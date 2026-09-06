import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CollaborationPublishCandidateSchema,
  CollaborationReviewBundleManifestSchema,
  type CollaborationPublishCandidate,
  type CollaborationReviewBundleManifest,
  type CollaborationReviewFile,
} from '@open-design/contracts';
import JSZip from 'jszip';

const MAX_FILES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const BUNDLE_PATH_PATTERN = /^[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._/@+-]+)*$/;
const DENIED_SEGMENTS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'coverage',
  '.cache',
  '.next',
]);
const DENIED_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
]);
const DENIED_EXTENSIONS = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.log',
  '.pem',
  '.key',
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

const HTML_REF_PATTERNS = [
  /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /<(?:img|source|video|audio|iframe)\b[^>]*\bsrc=["']([^"']+)["']/gi,
];
const CSS_REF_PATTERNS = [
  /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
  /@import\s+(?:url\()?\s*["']([^"')]+)["']/gi,
];
const JS_REF_PATTERNS = [
  /\bimport\s+[^'"]*?['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const SRCSET_PATTERN = /\bsrcset=["']([^"']+)["']/gi;

export type CollaborationProjectFile = {
  name: string;
  localPath: string;
  size: number;
  mtime: number;
  mime?: string;
};

type CandidateFile = CollaborationReviewFile & {
  localName: string;
  bytes: Buffer;
};

type BuiltCandidate = {
  candidate: CollaborationPublishCandidate;
  files: CandidateFile[];
};

export class CollaborationBundleError extends Error {
  constructor(
    readonly code:
      | 'COLLABORATION_PREVIEW_REQUIRED'
      | 'COLLABORATION_BUNDLE_UNSAFE'
      | 'COLLABORATION_BUNDLE_TOO_LARGE'
      | 'COLLABORATION_PUBLISH_CANDIDATE_CHANGED',
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationBundleError';
  }
}

export async function buildCollaborationPublishCandidate(input: {
  files: CollaborationProjectFile[];
  entrypoint?: string;
}): Promise<CollaborationPublishCandidate> {
  return (await buildCandidate(input)).candidate;
}

export async function buildCollaborationReviewBundle(input: {
  sourceProjectId: string;
  projectName: string;
  files: CollaborationProjectFile[];
  entrypoint?: string;
  expectedFingerprint: string;
  confirmedPaths: string[];
  createdAt: string;
  openDesignVersion?: string;
}): Promise<{
  candidate: CollaborationPublishCandidate;
  manifest: CollaborationReviewBundleManifest;
  archive: Buffer;
}> {
  const built = await buildCandidate(input);
  if (built.candidate.fingerprint !== input.expectedFingerprint) {
    throw new CollaborationBundleError(
      'COLLABORATION_PUBLISH_CANDIDATE_CHANGED',
      'Project files changed after the Publish preview was confirmed',
    );
  }
  const confirmed = [...new Set(input.confirmedPaths)].sort();
  const actual = built.candidate.files.map((file) => file.path).sort();
  if (confirmed.length !== actual.length || confirmed.some((value, index) => value !== actual[index])) {
    throw new CollaborationBundleError(
      'COLLABORATION_PUBLISH_CANDIDATE_CHANGED',
      'Confirmed Publish files do not match the current preview Bundle',
    );
  }

  const manifest = CollaborationReviewBundleManifestSchema.parse({
    schemaVersion: 1,
    mode: 'preview-only',
    project: {
      sourceProjectId: input.sourceProjectId,
      name: input.projectName,
    },
    createdAt: input.createdAt,
    entrypoint: built.candidate.entrypoint,
    publisher: {
      ...(input.openDesignVersion ? { openDesignVersion: input.openDesignVersion } : {}),
      bundleBuilderVersion: '1',
    },
    files: built.candidate.files,
  });
  const manifestJson = JSON.stringify(manifest);
  const zip = new JSZip();
  zip.file('manifest.json', manifestJson, { date: new Date(0) });
  for (const file of built.files) {
    zip.file(file.path, file.bytes, { date: new Date(0) });
  }
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new CollaborationBundleError(
      'COLLABORATION_BUNDLE_TOO_LARGE',
      'Preview Bundle exceeds the 25 MiB compressed size limit',
    );
  }
  return { candidate: built.candidate, manifest, archive };
}

async function buildCandidate(input: {
  files: CollaborationProjectFile[];
  entrypoint?: string;
}): Promise<BuiltCandidate> {
  const inventory = new Map<string, CollaborationProjectFile>();
  for (const file of input.files) {
    const name = normalizeLocalPath(file.name);
    if (isDeniedPath(name)) continue;
    inventory.set(name, { ...file, name });
  }
  const entrypoint = selectEntrypoint(inventory, input.entrypoint);
  const queue = [entrypoint];
  const visited = new Set<string>();
  const files: CandidateFile[] = [];
  let totalBytes = 0;

  while (queue.length > 0) {
    const localName = queue.shift()!;
    if (visited.has(localName)) continue;
    visited.add(localName);
    if (isDeniedPath(localName)) {
      throw new CollaborationBundleError(
        'COLLABORATION_BUNDLE_UNSAFE',
        `Preview references a protected local path: ${localName}`,
      );
    }
    assertBundleCompatiblePath(localName);
    const source = inventory.get(localName);
    if (!source) {
      throw new CollaborationBundleError(
        'COLLABORATION_BUNDLE_UNSAFE',
        `Preview references a missing local file: ${localName}`,
      );
    }
    if (source.size > MAX_FILE_BYTES) {
      throw new CollaborationBundleError(
        'COLLABORATION_BUNDLE_TOO_LARGE',
        `Preview file exceeds the 10 MiB limit: ${localName}`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(source.localPath);
    } catch {
      throw new CollaborationBundleError(
        'COLLABORATION_BUNDLE_UNSAFE',
        `Unable to read preview file: ${localName}`,
      );
    }
    if (bytes.byteLength !== source.size || bytes.byteLength > MAX_FILE_BYTES) {
      throw new CollaborationBundleError(
        'COLLABORATION_PUBLISH_CANDIDATE_CHANGED',
        `Preview file changed while it was being prepared: ${localName}`,
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_EXPANDED_BYTES) {
      throw new CollaborationBundleError(
        'COLLABORATION_BUNDLE_TOO_LARGE',
        'Preview Bundle exceeds the 50 MiB expanded size limit',
      );
    }
    if (files.length >= MAX_FILES) {
      throw new CollaborationBundleError(
        'COLLABORATION_BUNDLE_TOO_LARGE',
        'Preview Bundle contains more than 500 files',
      );
    }
    const mimeType = mimeFor(localName, source.mime);
    scanForSecrets(bytes, localName, mimeType);
    const publishedPath = `preview/${localName}`;
    files.push({
      localName,
      path: publishedPath,
      role: 'preview',
      sha256: sha256(bytes),
      size: bytes.byteLength,
      mimeType,
      bytes,
    });

    if (isTextual(mimeType, localName)) {
      const text = decodeUtf8(bytes, localName);
      for (const reference of extractRelativeReferences(text, localName, mimeType)) {
        if (!visited.has(reference)) queue.push(reference);
      }
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const publicFiles = files.map(({ localName: _localName, bytes: _bytes, ...file }) => file);
  const publicEntrypoint = `preview/${entrypoint}`;
  const fingerprint = sha256(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    mode: 'preview-only',
    entrypoint: publicEntrypoint,
    files: publicFiles,
  }), 'utf8'));
  const candidate = CollaborationPublishCandidateSchema.parse({
    schemaVersion: 1,
    mode: 'preview-only',
    entrypoint: publicEntrypoint,
    files: publicFiles,
    totalBytes,
    fingerprint,
  });
  return { candidate, files };
}

function selectEntrypoint(
  inventory: ReadonlyMap<string, CollaborationProjectFile>,
  requested?: string,
): string {
  const normalizedRequested = requested
    ? normalizeLocalPath(requested.replace(/^preview\//, ''))
    : null;
  const candidate = normalizedRequested
    ?? [...inventory.values()].find((file) => /(^|\/)index\.html?$/i.test(file.name))?.name
    ?? [...inventory.values()].find((file) => /\.html?$/i.test(file.name))?.name;
  if (!candidate || !/\.html?$/i.test(candidate) || !inventory.has(candidate)) {
    throw new CollaborationBundleError(
      'COLLABORATION_PREVIEW_REQUIRED',
      'Publish requires an HTML preview entrypoint in Design Files',
    );
  }
  assertBundleCompatiblePath(candidate);
  return candidate;
}

function normalizeLocalPath(value: string): string {
  const normalized = String(value).replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new CollaborationBundleError(
      'COLLABORATION_BUNDLE_UNSAFE',
      'Preview contains an unsafe project-relative path',
    );
  }
  return normalized.normalize('NFC');
}

function assertBundleCompatiblePath(localName: string): void {
  const publishedPath = `preview/${localName}`;
  if (publishedPath.length > 1024 || !BUNDLE_PATH_PATTERN.test(publishedPath)) {
    throw new CollaborationBundleError(
      'COLLABORATION_BUNDLE_UNSAFE',
      `Preview path is not supported by Collaboration Server v1: ${localName}`,
    );
  }
}

function isDeniedPath(localName: string): boolean {
  const segments = localName.toLocaleLowerCase('en-US').split('/');
  const basename = segments.at(-1) ?? '';
  return segments.some((segment) => segment.startsWith('.') || DENIED_SEGMENTS.has(segment))
    || DENIED_BASENAMES.has(basename)
    || basename.startsWith('.env.')
    || DENIED_EXTENSIONS.has(path.posix.extname(basename));
}

function extractRelativeReferences(text: string, fromPath: string, mimeType: string): string[] {
  const candidates: string[] = [];
  const isHtml = /html/i.test(mimeType) || /\.html?$/i.test(fromPath);
  const isCss = /css/i.test(mimeType) || /\.css$/i.test(fromPath);
  const isJavaScript = /javascript|typescript/i.test(mimeType) || /\.(?:m?jsx?|tsx?|cjs)$/i.test(fromPath);
  const patterns = [
    ...(isHtml ? [...HTML_REF_PATTERNS, ...CSS_REF_PATTERNS] : []),
    ...(isCss ? CSS_REF_PATTERNS : []),
    ...(isJavaScript ? JS_REF_PATTERNS : []),
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const reference = match[1]?.trim();
      if (reference) candidates.push(reference);
    }
  }
  if (isHtml) {
    SRCSET_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(SRCSET_PATTERN)) {
      for (const part of (match[1] ?? '').split(',')) {
        const reference = part.trim().split(/\s+/)[0];
        if (reference) candidates.push(reference);
      }
    }
  }

  const references = new Set<string>();
  const baseSegments = fromPath.split('/').slice(0, -1);
  for (const raw of candidates) {
    if (/^(?:https?:|\/\/|data:|blob:|mailto:|tel:|#)/i.test(raw)) continue;
    if (isJavaScript && !raw.startsWith('.') && !raw.startsWith('/')) continue;
    const withoutQuery = raw.replace(/[?#].*$/, '');
    if (!withoutQuery) continue;
    const segments = withoutQuery.startsWith('/') ? [] : [...baseSegments];
    let escaped = false;
    for (const segment of withoutQuery.replace(/^\//, '').split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (segments.length === 0) {
          escaped = true;
          break;
        }
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    if (escaped || segments.length === 0) {
      throw new CollaborationBundleError(
        'COLLABORATION_BUNDLE_UNSAFE',
        `Preview reference escapes the Project: ${raw}`,
      );
    }
    references.add(normalizeLocalPath(segments.join('/')));
  }
  return [...references];
}

function scanForSecrets(bytes: Buffer, localName: string, mimeType: string): void {
  if (!isTextual(mimeType, localName)) return;
  const text = decodeUtf8(bytes, localName);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new CollaborationBundleError(
      'COLLABORATION_BUNDLE_UNSAFE',
      `High-confidence secret detected in preview file: ${localName}`,
    );
  }
}

function decodeUtf8(bytes: Buffer, localName: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CollaborationBundleError(
      'COLLABORATION_BUNDLE_UNSAFE',
      `Text preview file is not valid UTF-8: ${localName}`,
    );
  }
}

function isTextual(mimeType: string, localName: string): boolean {
  return mimeType.startsWith('text/')
    || /(?:json|javascript|typescript|xml|svg)/i.test(mimeType)
    || /\.(?:html?|css|m?jsx?|tsx?|json|svg|xml|txt|md)$/i.test(localName);
}

function mimeFor(localName: string, existing?: string): string {
  if (existing && existing !== 'application/octet-stream') return existing.split(';')[0]!.trim();
  const extension = path.posix.extname(localName).toLocaleLowerCase('en-US');
  return ({
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
