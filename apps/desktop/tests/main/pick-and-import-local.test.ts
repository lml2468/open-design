import { describe, expect, it, vi } from 'vitest';
import { pickAndImportFolder } from '../../src/main/runtime.js';

describe('pickAndImportFolder local import', () => {
  it('sends only local import metadata and desktop authorization', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        project: { id: 'project-imported' },
        conversationId: 'conversation-imported',
        entryFile: 'index.html',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await pickAndImportFolder({
      apiBaseUrl: 'http://127.0.0.1:17591',
      baseDir: '/tmp/workspace-folder',
      desktopAuthSecret: Buffer.alloc(32, 1),
      fetchImpl,
      mintToken: () => 'desktop-import-token',
      init: {
        skillId: 'prototype-skill',
      },
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-od-desktop-import-token': 'desktop-import-token',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      baseDir: '/tmp/workspace-folder',
      skillId: 'prototype-skill',
    });
  });
});
