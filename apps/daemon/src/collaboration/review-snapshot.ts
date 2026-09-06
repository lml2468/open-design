import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  CollaborationProjectSchema,
  CollaborationReviewBundleManifestSchema,
  CollaborationReviewVersionSchema,
  type CollaborationProject,
  type CollaborationReviewBundleManifest,
  type CollaborationReviewFile,
  type CollaborationReviewSnapshot,
  type CollaborationReviewVersion,
} from '@open-design/contracts';

const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_META_FILE = 'snapshot.json';

type StoredReviewSnapshot = {
  schemaVersion: 1;
  cachedForUserId: string;
  project: CollaborationProject;
  version: CollaborationReviewVersion;
  manifest: CollaborationReviewBundleManifest;
  cachedAt: string;
};

export class CollaborationReviewSnapshotError extends Error {
  constructor(
    readonly code: 'COLLABORATION_REVIEW_UNAVAILABLE' | 'COLLABORATION_SNAPSHOT_UNSAFE',
    message: string,
  ) {
    super(message);
    this.name = 'CollaborationReviewSnapshotError';
  }
}

export class CollaborationReviewSnapshotStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'collaboration-review-snapshots');
  }

  async materialize(input: {
    serverOrigin: string;
    cachedForUserId: string;
    project: CollaborationProject;
    version: CollaborationReviewVersion;
    manifest: CollaborationReviewBundleManifest;
    cachedAt: string;
    readRemoteFile: (filePath: string) => Promise<Buffer>;
  }): Promise<CollaborationReviewSnapshot> {
    validateSnapshotIdentity(input.project, input.version, input.manifest);
    const snapshotId = reviewSnapshotId(
      input.serverOrigin,
      input.project.id,
      input.version.id,
      input.version.manifestSha256,
      input.cachedForUserId,
    );
    const existing = await this.read(snapshotId, input.cachedForUserId).catch(() => null);
    if (existing) return { ...existing, project: input.project };

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const finalDirectory = this.snapshotDirectory(snapshotId);
    const stagingDirectory = path.join(
      this.root,
      `.${snapshotId}.${process.pid}.${Date.now()}.tmp`,
    );
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    try {
      for (const file of input.manifest.files) {
        const normalized = normalizeSnapshotPath(file.path);
        const bytes = await input.readRemoteFile(normalized);
        verifySnapshotFile(file, bytes);
        const target = path.join(stagingDirectory, ...normalized.split('/'));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
      }

      const stored: StoredReviewSnapshot = {
        schemaVersion: 1,
        cachedForUserId: input.cachedForUserId,
        project: input.project,
        version: input.version,
        manifest: input.manifest,
        cachedAt: input.cachedAt,
      };
      await writeFile(
        path.join(stagingDirectory, SNAPSHOT_META_FILE),
        `${JSON.stringify(stored, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      await rename(stagingDirectory, finalDirectory);
      await chmod(finalDirectory, 0o700).catch(() => undefined);
      return snapshotResponse(snapshotId, stored);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(snapshotId: string, expectedUserId?: string): Promise<CollaborationReviewSnapshot> {
    assertSnapshotId(snapshotId);
    let raw: string;
    try {
      raw = await readFile(path.join(this.snapshotDirectory(snapshotId), SNAPSHOT_META_FILE), 'utf8');
    } catch {
      throw new CollaborationReviewSnapshotError(
        'COLLABORATION_REVIEW_UNAVAILABLE',
        'Review Snapshot is not available in this Desktop cache',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw unsafeSnapshot('Review Snapshot metadata is invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw unsafeSnapshot('Review Snapshot metadata is invalid');
    }
    const source = parsed as Record<string, unknown>;
    const project = CollaborationProjectSchema.safeParse(source.project);
    const version = CollaborationReviewVersionSchema.safeParse(source.version);
    const manifest = CollaborationReviewBundleManifestSchema.safeParse(source.manifest);
    if (
      source.schemaVersion !== 1
      || typeof source.cachedForUserId !== 'string'
      || !source.cachedForUserId
      || !project.success
      || !version.success
      || !manifest.success
      || typeof source.cachedAt !== 'string'
      || !Number.isFinite(Date.parse(source.cachedAt))
    ) {
      throw unsafeSnapshot('Review Snapshot metadata is incompatible');
    }
    if (expectedUserId && source.cachedForUserId !== expectedUserId) {
      throw new CollaborationReviewSnapshotError(
        'COLLABORATION_REVIEW_UNAVAILABLE',
        'Review Snapshot belongs to a different signed-in account',
      );
    }
    validateSnapshotIdentity(project.data, version.data, manifest.data);
    return snapshotResponse(snapshotId, {
      schemaVersion: 1,
      cachedForUserId: source.cachedForUserId,
      project: project.data,
      version: version.data,
      manifest: manifest.data,
      cachedAt: source.cachedAt,
    });
  }

  async readSnapshotFile(
    snapshotId: string,
    requestedPath: string,
    expectedUserId?: string,
  ): Promise<{ bytes: Buffer; file: CollaborationReviewFile }> {
    const snapshot = await this.read(snapshotId, expectedUserId);
    const normalized = normalizeSnapshotPath(requestedPath);
    const file = snapshot.manifest.files.find((candidate) => candidate.path === normalized);
    if (!file) {
      throw new CollaborationReviewSnapshotError(
        'COLLABORATION_REVIEW_UNAVAILABLE',
        'Review Snapshot file was not declared by the immutable manifest',
      );
    }
    const filePath = path.join(this.snapshotDirectory(snapshotId), ...normalized.split('/'));
    let bytes: Buffer;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error('not a regular file');
      bytes = await readFile(filePath);
    } catch {
      throw unsafeSnapshot('Review Snapshot file is missing from the local cache');
    }
    verifySnapshotFile(file, bytes);
    return { bytes, file };
  }

  private snapshotDirectory(snapshotId: string): string {
    return path.join(this.root, snapshotId);
  }
}

export function normalizeSnapshotPath(value: string): string {
  if (
    !value
    || value.length > 1024
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || value.includes('\0')
  ) {
    throw unsafeSnapshot('Review Snapshot contains an unsafe file path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw unsafeSnapshot('Review Snapshot contains an unsafe file path');
  }
  const normalized = segments.join('/').normalize('NFC');
  if (normalized !== value) {
    throw unsafeSnapshot('Review Snapshot contains a non-canonical file path');
  }
  return normalized;
}

function reviewSnapshotId(
  serverOrigin: string,
  projectId: string,
  versionId: string,
  manifestSha256: string,
  cachedForUserId: string,
): string {
  return createHash('sha256')
    .update(`${serverOrigin}\0${projectId}\0${versionId}\0${manifestSha256}\0${cachedForUserId}`)
    .digest('hex');
}

function snapshotResponse(
  snapshotId: string,
  stored: StoredReviewSnapshot,
): CollaborationReviewSnapshot {
  return {
    snapshotId,
    project: stored.project,
    version: stored.version,
    manifest: stored.manifest,
    entrypointUrl: snapshotFileUrl(snapshotId, stored.manifest.entrypoint),
    cachedAt: stored.cachedAt,
  };
}

function snapshotFileUrl(snapshotId: string, filePath: string): string {
  return `/api/collaboration/review-snapshots/${snapshotId}/files/${filePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function validateSnapshotIdentity(
  project: CollaborationProject,
  version: CollaborationReviewVersion,
  manifest: CollaborationReviewBundleManifest,
): void {
  if (
    version.projectId !== project.id
    || version.entrypoint !== manifest.entrypoint
    || version.mode !== manifest.mode
    || !manifest.files.some((file) =>
      file.path === manifest.entrypoint
      && file.role === 'preview'
      && file.mimeType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html')
  ) {
    throw unsafeSnapshot('Review Version and manifest identity do not match');
  }
  const paths = new Set<string>();
  for (const file of manifest.files) {
    const normalized = normalizeSnapshotPath(file.path);
    if (paths.has(normalized)) throw unsafeSnapshot('Review Snapshot contains duplicate file paths');
    paths.add(normalized);
  }
}

function verifySnapshotFile(file: CollaborationReviewFile, bytes: Buffer): void {
  if (bytes.byteLength !== file.size) {
    throw unsafeSnapshot(`Review Snapshot size mismatch for ${file.path}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== file.sha256) {
    throw unsafeSnapshot(`Review Snapshot checksum mismatch for ${file.path}`);
  }
}

function assertSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw unsafeSnapshot('Review Snapshot id is invalid');
  }
}

function unsafeSnapshot(message: string): CollaborationReviewSnapshotError {
  return new CollaborationReviewSnapshotError('COLLABORATION_SNAPSHOT_UNSAFE', message);
}
