import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  deletePreviewComment,
  getConversation,
  getPreviewComment,
  insertConversation,
  insertProject,
  listPreviewComments,
  openDatabase,
  reorderPreviewComment,
  updatePreviewCommentAnchor,
  updatePreviewCommentStatus,
  updateProject,
  upsertPreviewComment,
} from '../src/db.js';
import { registerProjectCommentRoutes } from '../src/routes/project/comments.js';

let server: http.Server | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const PROJECT = 'p1';
const CONVERSATION = 'conv-1';

async function startServer(metadata: Record<string, unknown> = { kind: 'prototype' }) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-local-comments-'));
  const db = openDatabase(tempDir);
  insertProject(db, {
    id: PROJECT,
    name: 'Project',
    metadata,
    createdAt: 1,
    updatedAt: 1,
  });
  insertConversation(db, {
    id: CONVERSATION,
    projectId: PROJECT,
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
  });

  const productEvents: Array<{
    eventName: string;
    properties: Record<string, unknown>;
  }> = [];
  const app = express();
  app.use(express.json());
  registerProjectCommentRoutes(app, {
    db,
    projectStore: { updateProject } as never,
    conversations: {
      getConversation,
      listPreviewComments,
      upsertPreviewComment,
      getPreviewComment,
      updatePreviewCommentStatus,
      updatePreviewCommentAnchor,
      deletePreviewComment,
      reorderPreviewComment,
    } as never,
    telemetry: {
      captureProductEvent: (_req: unknown, eventName: string, properties: Record<string, unknown>) => {
        productEvents.push({ eventName, properties });
      },
    } as never,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const base = `http://127.0.0.1:${address.port}`;

  async function json(route: string, options: { method?: string; body?: unknown } = {}) {
    const init: RequestInit = { method: options.method ?? 'GET' };
    if (options.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${base}${route}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as any) : {} };
  }

  const commentTarget = {
    filePath: 'index.html',
    elementId: 'hero',
    selector: '[data-od-id="hero"]',
    label: 'h1.hero',
    text: 'Hero',
    htmlHint: '<h1>',
    position: { x: 0, y: 0, width: 100, height: 40 },
  };

  async function createComment(note = 'a note', extra: Record<string, unknown> = {}) {
    return json(`/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`, {
      method: 'POST',
      body: { target: commentTarget, note, ...extra },
    });
  }

  return { base, commentTarget, createComment, db, json, productEvents };
}

describe('local preview comment authority', () => {
  it('creates local comments without accepting legacy member identity or review provenance', async () => {
    const api = await startServer();
    const created = await api.createComment('owner note', {
      authorMemberId: 'forged-member',
      reviewSource: { kind: 'collaboration-review' },
    });

    expect(created.status).toBe(200);
    expect(created.body.comment).toMatchObject({ note: 'owner note' });
    expect(created.body.comment.authorMemberId).toBeUndefined();
    expect(created.body.comment.reviewSource).toBeUndefined();
    expect(api.productEvents).toEqual([
      {
        eventName: 'project_comment_create_result',
        properties: expect.objectContaining({
          result: 'success',
          target_project_relation: 'self',
          comment_level: 'top_level',
          project_id: PROJECT,
          project_kind: 'prototype',
        }),
      },
    ]);
    expect(api.productEvents[0]?.properties).not.toHaveProperty('workspace_key');
  });

  it('edits an existing local comment by id without inflating creation telemetry', async () => {
    const api = await startServer();
    const created = await api.createComment('first note');
    const edited = await api.createComment('edited note', { id: created.body.comment.id });

    expect(edited.status).toBe(200);
    expect(edited.body.comment).toMatchObject({
      id: created.body.comment.id,
      note: 'edited note',
    });
    expect(api.productEvents).toHaveLength(1);
  });

  it('keeps reads and edits scoped to the requested conversation', async () => {
    const api = await startServer();
    insertConversation(api.db, {
      id: 'conv-2',
      projectId: PROJECT,
      title: 'Other chat',
      createdAt: 2,
      updatedAt: 2,
    });
    const other = upsertPreviewComment(api.db, PROJECT, 'conv-2', {
      target: api.commentTarget,
      note: 'other conversation',
    });

    const listed = await api.json(`/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`);
    expect(listed.status).toBe(200);
    expect(listed.body.comments).toEqual([]);

    const edit = await api.createComment('cross-conversation edit', { id: other!.id });
    expect(edit.status).toBe(404);
    expect(getPreviewComment(api.db, PROJECT, 'conv-2', other!.id)?.note).toBe('other conversation');
  });

  it('keeps projected collaboration review provenance immutable locally', async () => {
    const api = await startServer();
    const projected = upsertPreviewComment(api.db, PROJECT, CONVERSATION, {
      id: 'review-local-id',
      target: api.commentTarget,
      note: 'reviewer note',
      reviewSource: {
        kind: 'collaboration-review',
        remoteProjectId: 'remote-project',
        remoteVersionId: 'version-1',
        remoteVersionNumber: 1,
        remoteCommentId: 'comment-1',
        remoteCommentRevision: 1,
        authorUserId: 'reviewer-1',
        source: 'human',
        status: 'open',
        targetSelectionKind: 'element',
        targetPosition: api.commentTarget.position,
      },
    });

    const edit = await api.createComment('rewritten locally', { id: projected!.id });
    expect(edit.status).toBe(409);
    expect(getPreviewComment(api.db, PROJECT, CONVERSATION, projected!.id)?.note).toBe('reviewer note');
  });

  it('allows local status, anchor, reorder, and delete lifecycle operations', async () => {
    const api = await startServer();
    const created = await api.createComment();
    const id = created.body.comment.id as string;

    const status = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${id}`,
      { method: 'PATCH', body: { status: 'applying' } },
    );
    expect(status.status).toBe(200);
    expect(status.body.comment.status).toBe('applying');

    const anchor = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${id}/anchor`,
      { method: 'PATCH', body: { anchorState: 'anchored' } },
    );
    expect(anchor.status).toBe(200);
    expect(anchor.body.comment.anchorState).toBe('anchored');

    const reordered = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${id}/reorder`,
      { method: 'PATCH', body: { sortKey: 42 } },
    );
    expect(reordered.status).toBe(200);
    expect(reordered.body.comment.sortKey).toBe(42);

    const removed = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${id}`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(listPreviewComments(api.db, PROJECT, CONVERSATION)).toEqual([]);
  });

  it('uses the canonical prototype analytics kind for legacy project metadata', async () => {
    const api = await startServer({});
    await api.createComment('legacy project note');
    expect(api.productEvents[0]?.properties.project_kind).toBe('prototype');
  });

  it('rejects invalid reorder values and unknown comment ids', async () => {
    const api = await startServer();
    const created = await api.createComment();
    const bad = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${created.body.comment.id}/reorder`,
      { method: 'PATCH', body: { sortKey: 'not-a-number' } },
    );
    expect(bad.status).toBe(400);

    const missing = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/missing-comment/reorder`,
      { method: 'PATCH', body: { sortKey: 1 } },
    );
    expect(missing.status).toBe(404);
  });
});
