import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCollaborationPublishCandidate,
  buildCollaborationReviewBundle,
  CollaborationBundleError,
  type CollaborationProjectFile,
} from '../../src/collaboration/review-bundle.js';

const temporaryRoots: string[] = [];

async function fixture(files: Record<string, string | Buffer>): Promise<CollaborationProjectFile[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-collaboration-bundle-'));
  temporaryRoots.push(root);
  const result: CollaborationProjectFile[] = [];
  let mtime = Date.now();
  for (const [name, body] of Object.entries(files)) {
    const localPath = path.join(root, name);
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, body);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    result.push({ name, localPath, size: bytes.byteLength, mtime: mtime-- });
  }
  return result;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('collaboration preview-only Review Bundle', () => {
  it('includes only the HTML entrypoint and its transitive local assets', async () => {
    const files = await fixture({
      'index.html': '<link rel="stylesheet" href="assets/site.css"><img src="assets/hero.png"><script src="https://cdn.example.test/x.js"></script>',
      'assets/site.css': '@font-face { src: url("../fonts/site.woff2") }',
      'assets/hero.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'fonts/site.woff2': Buffer.from([1, 2, 3]),
      'notes.txt': 'must not publish',
      '.env': 'SECRET=must-not-publish',
    });

    const candidate = await buildCollaborationPublishCandidate({ files });

    expect(candidate.entrypoint).toBe('preview/index.html');
    expect(candidate.files.map((file) => file.path)).toEqual([
      'preview/assets/hero.png',
      'preview/assets/site.css',
      'preview/fonts/site.woff2',
      'preview/index.html',
    ]);
    expect(JSON.stringify(candidate)).not.toContain(temporaryRoots[0]);
    expect(JSON.stringify(candidate)).not.toContain('.env');
    expect(JSON.stringify(candidate)).not.toContain('notes.txt');
  });

  it('embeds the exact manifest and only declared files in the ZIP', async () => {
    const files = await fixture({
      'index.html': '<img src="asset.png">',
      'asset.png': Buffer.from([1, 2, 3, 4]),
    });
    const candidate = await buildCollaborationPublishCandidate({ files });
    const built = await buildCollaborationReviewBundle({
      sourceProjectId: 'local-project-42',
      projectName: 'Launch deck',
      files,
      expectedFingerprint: candidate.fingerprint,
      confirmedPaths: candidate.files.map((file) => file.path),
      createdAt: '2026-09-06T10:00:00.000Z',
    });
    const zip = await JSZip.loadAsync(built.archive);

    expect(JSON.parse(await zip.file('manifest.json')!.async('string'))).toEqual(built.manifest);
    expect(Object.keys(zip.files).sort()).toEqual([
      'manifest.json',
      'preview/',
      'preview/asset.png',
      'preview/index.html',
    ]);
  });

  it('rejects high-confidence secrets in preview files', async () => {
    const files = await fixture({
      'index.html': '<script src="app.js"></script>',
      'app.js': `const token = '${'ghp_' + 'a'.repeat(40)}';`,
    });

    await expect(buildCollaborationPublishCandidate({ files })).rejects.toMatchObject({
      code: 'COLLABORATION_BUNDLE_UNSAFE',
    });
  });

  it('rejects stale confirmations when a file changes after preview', async () => {
    const files = await fixture({ 'index.html': '<h1>one</h1>' });
    const candidate = await buildCollaborationPublishCandidate({ files });
    await writeFile(files[0]!.localPath, '<h1>two</h1>');
    files[0]!.size = Buffer.byteLength('<h1>two</h1>');

    await expect(buildCollaborationReviewBundle({
      sourceProjectId: 'local-project-42',
      projectName: 'Launch deck',
      files,
      expectedFingerprint: candidate.fingerprint,
      confirmedPaths: candidate.files.map((file) => file.path),
      createdAt: '2026-09-06T10:00:00.000Z',
    })).rejects.toBeInstanceOf(CollaborationBundleError);
  });
});
