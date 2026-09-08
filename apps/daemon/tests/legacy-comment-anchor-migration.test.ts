import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  getConversation,
  insertConversation,
  insertProject,
  listConversations,
  listPreviewComments,
  migrateLegacyProjectCommentAnchors,
  openDatabase,
  upsertPreviewComment,
} from '../src/db.js';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function target() {
  return {
    filePath: 'index.html',
    elementId: 'hero',
    selector: '#hero',
    label: 'Hero',
    text: 'Hello',
    htmlHint: '<h1 id="hero">Hello</h1>',
    position: { x: 0, y: 0, width: 100, height: 40 },
  };
}

describe('legacy comment anchor migration', () => {
  it('moves anchored comments into the latest ordinary conversation and removes the anchor', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-comment-anchor-migration-'));
    const db = openDatabase(tempDir);
    insertProject(db, { id: 'p1', name: 'Project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, {
      id: 'chat-1',
      projectId: 'p1',
      title: 'Chat',
      createdAt: 1,
      updatedAt: 2,
    });
    insertConversation(db, {
      id: 'comment-anchor-legacy',
      projectId: 'p1',
      title: null,
      createdAt: 2,
      updatedAt: 3,
    });
    const comment = upsertPreviewComment(db, 'p1', 'comment-anchor-legacy', {
      target: target(),
      note: 'legacy team comment',
    });

    expect(migrateLegacyProjectCommentAnchors(db)).toEqual({
      anchorsRemoved: 1,
      commentsMoved: 1,
      conversationsCreated: 0,
    });
    expect(getConversation(db, 'comment-anchor-legacy')).toBeNull();
    expect(listPreviewComments(db, 'p1', 'chat-1')).toEqual([
      expect.objectContaining({ id: comment!.id, note: 'legacy team comment' }),
    ]);
  });

  it('creates one ordinary conversation when a project only has legacy anchors', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-comment-anchor-migration-'));
    const db = openDatabase(tempDir);
    insertProject(db, { id: 'p1', name: 'Project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, {
      id: 'comment-anchor-legacy',
      projectId: 'p1',
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    upsertPreviewComment(db, 'p1', 'comment-anchor-legacy', {
      target: target(),
      note: 'legacy team comment',
    });

    expect(migrateLegacyProjectCommentAnchors(db, 10)).toEqual({
      anchorsRemoved: 1,
      commentsMoved: 1,
      conversationsCreated: 1,
    });
    const conversations = listConversations(db, 'p1');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toMatch(/^conversation-/);
    expect(listPreviewComments(db, 'p1', conversations[0]!.id)).toHaveLength(1);
    expect(migrateLegacyProjectCommentAnchors(db, 11)).toEqual({
      anchorsRemoved: 0,
      commentsMoved: 0,
      conversationsCreated: 0,
    });
  });
});
