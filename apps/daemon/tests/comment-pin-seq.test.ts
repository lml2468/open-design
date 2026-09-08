import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  getPreviewComment,
  insertConversation,
  insertProject,
  openDatabase,
  reorderPreviewComment,
  upsertPreviewComment,
} from '../src/db.js';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function target(patch: Record<string, unknown> = {}) {
  return {
    filePath: 'index.html',
    elementId: 'hero-title',
    selector: '[data-od-id="hero-title"]',
    label: 'h1.hero-title',
    text: 'Current title',
    position: { x: 10, y: 20, width: 300, height: 80 },
    htmlHint: '<h1 data-od-id="hero-title">',
    ...patch,
  };
}

function seededDb() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-pin-seq-'));
  const db = openDatabase(tempDir, { dataDir: tempDir });
  insertProject(db, { id: 'project-1', name: 'Project', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'conversation-1', projectId: 'project-1', title: 'Chat', createdAt: 1, updatedAt: 1 });
  return db;
}

describe('pin_seq assignment (recvq5BVsolIxi)', () => {
  it('assigns pin_seq starting at 1 and never rewrites it on a later edit', () => {
    const db = seededDb();
    const first = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ elementId: 'a' }),
      note: 'First',
    });
    const second = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ elementId: 'b' }),
      note: 'Second',
    });
    expect(first?.pinSeq).toBe(1);
    expect(second?.pinSeq).toBe(2);

    // Editing the FIRST comment (by id) must not touch its pin_seq, even
    // though a naive "recompute MAX+1" would now see two existing rows.
    const edited = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      id: first!.id,
      target: target({ elementId: 'a' }),
      note: 'First, edited',
    });
    expect(edited?.pinSeq).toBe(1);
    expect(edited?.note).toBe('First, edited');
  });

  it('scopes pin_seq per (project, file) — a different file restarts at 1', () => {
    const db = seededDb();
    const onIndex = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ filePath: 'index.html', elementId: 'a' }),
      note: 'Index comment',
    });
    const onAbout = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ filePath: 'about.html', elementId: 'a' }),
      note: 'About comment',
    });
    const secondOnIndex = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ filePath: 'index.html', elementId: 'b' }),
      note: 'Second index comment',
    });
    expect(onIndex?.pinSeq).toBe(1);
    expect(onAbout?.pinSeq).toBe(1);
    expect(secondOnIndex?.pinSeq).toBe(2);
  });

  it('assigns a default sort_key so a fresh comment sorts to the front by default', () => {
    const db = seededDb();
    const older = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ elementId: 'a' }),
      note: 'Older',
    });
    const newer = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ elementId: 'b' }),
      note: 'Newer',
    });
    expect(newer!.sortKey!).toBeGreaterThan(older!.sortKey!);
  });

  it('reorderPreviewComment rewrites only the dragged row\'s sort_key, never pin_seq', () => {
    const db = seededDb();
    const older = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ elementId: 'a' }),
      note: 'Older',
    });
    const newer = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target({ elementId: 'b' }),
      note: 'Newer',
    });
    // Drag the older comment above the newer one.
    const reordered = reorderPreviewComment(
      db,
      'project-1',
      'conversation-1',
      older!.id,
      newer!.sortKey! + 1,
    );
    expect(reordered?.sortKey).toBe(newer!.sortKey! + 1);
    expect(reordered?.pinSeq).toBe(older!.pinSeq); // identity unchanged
    // The untouched comment's own sort_key is unaffected.
    const untouched = getPreviewComment(db, 'project-1', 'conversation-1', newer!.id);
    expect(untouched?.sortKey).toBe(newer!.sortKey);
  });
});
