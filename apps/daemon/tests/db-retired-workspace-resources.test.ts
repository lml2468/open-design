import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db.js';

describe('retired Workspace schema', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    closeDatabase();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('does not create the retired generic Workspace resource table', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-retired-workspace-resources-'));
    const db = openDatabase(tempDir, { dataDir: tempDir });

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_resources'",
    ).get();

    expect(table).toBeUndefined();
  });

  it('does not create the retired Workspace project-binding table', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-retired-workspace-projects-'));
    const db = openDatabase(tempDir, { dataDir: tempDir });

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_projects'",
    ).get();

    expect(table).toBeUndefined();
  });
});
