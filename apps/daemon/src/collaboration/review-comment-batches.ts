import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CollaborationReviewCommentBatchSchema,
  CollaborationReviewCommentSchema,
  type CollaborationPendingReviewCommentBatch,
  type CollaborationReviewComment,
  type CollaborationReviewCommentBatch,
  type CreateCollaborationReviewComment,
} from '@open-design/contracts';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface CollaborationReviewCommentBatchScope {
  serverOrigin: string;
  sessionId: string;
  userId: string;
}

interface StoredComment {
  input: CreateCollaborationReviewComment;
  idempotencyKey: string;
  result?: CollaborationReviewComment;
}

export interface StoredReviewCommentBatch {
  id: string;
  serverOrigin: string;
  sessionId: string;
  userId: string;
  remoteProjectId: string;
  versionId: string;
  comments: StoredComment[];
  status: 'pending' | 'confirmed';
  createdAt: string;
  expiresAt: string;
}

interface StoredState {
  version: 1;
  batches: StoredReviewCommentBatch[];
}

const writeLocks = new Map<string, Promise<unknown>>();

function batchesFile(dataDir: string): string {
  return path.join(dataDir, 'collaboration-review-comment-batches.json');
}

async function withLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const key = batchesFile(dataDir);
  const previous = writeLocks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  writeLocks.set(key, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(key) === task) writeLocks.delete(key);
  }
}

function sanitizeStoredComment(value: unknown): StoredComment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const input = CollaborationReviewCommentBatchSchema.safeParse({ comments: [source.input] });
  const result = source.result === undefined
    ? undefined
    : CollaborationReviewCommentSchema.safeParse(source.result);
  if (
    !input.success
    || typeof source.idempotencyKey !== 'string'
    || !source.idempotencyKey
    || (result !== undefined && !result.success)
  ) {
    return null;
  }
  return {
    input: input.data.comments[0]!,
    idempotencyKey: source.idempotencyKey,
    ...(result?.success ? { result: result.data } : {}),
  };
}

function sanitizeStoredBatch(value: unknown): StoredReviewCommentBatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const comments = Array.isArray(source.comments)
    ? source.comments.map(sanitizeStoredComment)
    : [];
  const timestampsValid = typeof source.createdAt === 'string'
    && Number.isFinite(Date.parse(source.createdAt))
    && typeof source.expiresAt === 'string'
    && Number.isFinite(Date.parse(source.expiresAt));
  if (
    typeof source.id !== 'string'
    || !source.id
    || typeof source.serverOrigin !== 'string'
    || !source.serverOrigin
    || typeof source.sessionId !== 'string'
    || !source.sessionId
    || typeof source.userId !== 'string'
    || !source.userId
    || typeof source.remoteProjectId !== 'string'
    || !source.remoteProjectId
    || typeof source.versionId !== 'string'
    || !source.versionId
    || (source.status !== 'pending' && source.status !== 'confirmed')
    || !timestampsValid
    || comments.length === 0
    || comments.some((comment) => comment === null)
  ) {
    return null;
  }
  const parsed = CollaborationReviewCommentBatchSchema.safeParse({
    comments: comments.map((comment) => comment!.input),
  });
  if (!parsed.success || parsed.data.comments[0]?.versionId !== source.versionId) return null;
  if (source.status === 'confirmed' && comments.some((comment) => !comment!.result)) return null;
  return {
    id: source.id,
    serverOrigin: source.serverOrigin,
    sessionId: source.sessionId,
    userId: source.userId,
    remoteProjectId: source.remoteProjectId,
    versionId: source.versionId,
    comments: comments as StoredComment[],
    status: source.status,
    createdAt: source.createdAt as string,
    expiresAt: source.expiresAt as string,
  };
}

async function readState(dataDir: string): Promise<StoredState> {
  try {
    const raw = JSON.parse(await readFile(batchesFile(dataDir), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, batches: [] };
    const source = raw as Record<string, unknown>;
    if (source.version !== 1 || !Array.isArray(source.batches)) return { version: 1, batches: [] };
    return {
      version: 1,
      batches: source.batches.flatMap((value) => {
        const batch = sanitizeStoredBatch(value);
        return batch ? [batch] : [];
      }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return { version: 1, batches: [] };
    }
    throw error;
  }
}

async function writeState(dataDir: string, state: StoredState): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = batchesFile(dataDir);
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, file);
  try {
    await chmod(file, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOTSUP' && code !== 'EPERM') throw error;
  }
}

function isOwnedBy(
  batch: StoredReviewCommentBatch,
  scope: CollaborationReviewCommentBatchScope,
): boolean {
  return batch.serverOrigin === scope.serverOrigin
    && batch.sessionId === scope.sessionId
    && batch.userId === scope.userId;
}

function publicBatch(batch: StoredReviewCommentBatch): CollaborationPendingReviewCommentBatch {
  return {
    id: batch.id,
    remoteProjectId: batch.remoteProjectId,
    versionId: batch.versionId,
    comments: batch.comments.map(({ input }) => input),
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
  };
}

function pruneExpired(state: StoredState, nowMs: number): boolean {
  const batches = state.batches.filter((batch) => Date.parse(batch.expiresAt) > nowMs);
  if (batches.length === state.batches.length) return false;
  state.batches = batches;
  return true;
}

export class CollaborationReviewCommentBatchStore {
  constructor(
    private readonly dataDir: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  async stage(input: {
    scope: CollaborationReviewCommentBatchScope;
    remoteProjectId: string;
    batch: CollaborationReviewCommentBatch;
    now: Date;
  }): Promise<CollaborationPendingReviewCommentBatch> {
    return withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      pruneExpired(state, input.now.getTime());
      const createdAt = input.now.toISOString();
      const stored: StoredReviewCommentBatch = {
        id: `review-batch-${randomUUID()}`,
        ...input.scope,
        remoteProjectId: input.remoteProjectId,
        versionId: input.batch.comments[0]!.versionId,
        comments: input.batch.comments.map((comment) => ({
          input: comment,
          idempotencyKey: `desktop-review-${randomUUID()}`,
        })),
        status: 'pending',
        createdAt,
        expiresAt: new Date(input.now.getTime() + this.ttlMs).toISOString(),
      };
      state.batches.push(stored);
      await writeState(this.dataDir, state);
      return publicBatch(stored);
    });
  }

  async list(input: {
    scope: CollaborationReviewCommentBatchScope;
    remoteProjectId: string;
    versionId?: string;
    now: Date;
  }): Promise<CollaborationPendingReviewCommentBatch[]> {
    return withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      const pruned = pruneExpired(state, input.now.getTime());
      if (pruned) await writeState(this.dataDir, state);
      return state.batches
        .filter((batch) => batch.status === 'pending'
          && isOwnedBy(batch, input.scope)
          && batch.remoteProjectId === input.remoteProjectId
          && (!input.versionId || batch.versionId === input.versionId))
        .map(publicBatch);
    });
  }

  async read(input: {
    scope: CollaborationReviewCommentBatchScope;
    remoteProjectId: string;
    batchId: string;
    now: Date;
  }): Promise<StoredReviewCommentBatch | null> {
    return withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      const pruned = pruneExpired(state, input.now.getTime());
      if (pruned) await writeState(this.dataDir, state);
      const batch = state.batches.find((candidate) => candidate.id === input.batchId);
      if (!batch || !isOwnedBy(batch, input.scope) || batch.remoteProjectId !== input.remoteProjectId) {
        return null;
      }
      return structuredClone(batch);
    });
  }

  async recordSubmitted(input: {
    scope: CollaborationReviewCommentBatchScope;
    remoteProjectId: string;
    batchId: string;
    commentIndex: number;
    result: CollaborationReviewComment;
    now: Date;
  }): Promise<void> {
    await withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      pruneExpired(state, input.now.getTime());
      const batch = state.batches.find((candidate) => candidate.id === input.batchId);
      if (!batch || !isOwnedBy(batch, input.scope) || batch.remoteProjectId !== input.remoteProjectId) {
        throw new Error('Pending review comment batch no longer exists');
      }
      const comment = batch.comments[input.commentIndex];
      if (!comment) throw new Error('Pending review comment batch is invalid');
      comment.result = CollaborationReviewCommentSchema.parse(input.result);
      await writeState(this.dataDir, state);
    });
  }

  async markConfirmed(input: {
    scope: CollaborationReviewCommentBatchScope;
    remoteProjectId: string;
    batchId: string;
    now: Date;
  }): Promise<CollaborationReviewComment[]> {
    return withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      pruneExpired(state, input.now.getTime());
      const batch = state.batches.find((candidate) => candidate.id === input.batchId);
      if (!batch || !isOwnedBy(batch, input.scope) || batch.remoteProjectId !== input.remoteProjectId) {
        throw new Error('Pending review comment batch no longer exists');
      }
      const results = batch.comments.map(({ result }) => result).filter(Boolean) as CollaborationReviewComment[];
      if (results.length !== batch.comments.length) {
        throw new Error('Pending review comment batch is not fully submitted');
      }
      batch.status = 'confirmed';
      await writeState(this.dataDir, state);
      return results;
    });
  }

  async discard(input: {
    scope: CollaborationReviewCommentBatchScope;
    remoteProjectId: string;
    batchId: string;
    now: Date;
  }): Promise<boolean> {
    return withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      pruneExpired(state, input.now.getTime());
      const index = state.batches.findIndex((batch) => batch.id === input.batchId
        && batch.status === 'pending'
        && isOwnedBy(batch, input.scope)
        && batch.remoteProjectId === input.remoteProjectId);
      if (index < 0) return false;
      state.batches.splice(index, 1);
      await writeState(this.dataDir, state);
      return true;
    });
  }

  async clearSession(scope: CollaborationReviewCommentBatchScope): Promise<void> {
    await withLock(this.dataDir, async () => {
      const state = await readState(this.dataDir);
      const batches = state.batches.filter((batch) => !isOwnedBy(batch, scope));
      if (batches.length === state.batches.length) return;
      await writeState(this.dataDir, { version: 1, batches });
    });
  }
}
