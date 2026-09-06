import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CollaborationProjectBindingSchema,
  type CollaborationProjectBinding,
} from '@open-design/contracts';

type StoredBindings = {
  version: 1;
  bindings: CollaborationProjectBinding[];
};

const writeLocks = new Map<string, Promise<unknown>>();

export class CollaborationProjectBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationProjectBindingConflictError';
  }
}

function bindingsFile(dataDir: string): string {
  return path.join(dataDir, 'collaboration-project-bindings.json');
}

async function withLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(dataDir) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  writeLocks.set(dataDir, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(dataDir) === task) writeLocks.delete(dataDir);
  }
}

async function readBindings(dataDir: string): Promise<StoredBindings> {
  try {
    const raw = JSON.parse(await readFile(bindingsFile(dataDir), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, bindings: [] };
    const source = raw as Record<string, unknown>;
    if (source.version !== 1 || !Array.isArray(source.bindings)) return { version: 1, bindings: [] };
    const bindings = source.bindings.flatMap((value) => {
      const parsed = CollaborationProjectBindingSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    return { version: 1, bindings };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return { version: 1, bindings: [] };
    }
    throw error;
  }
}

async function writeBindings(dataDir: string, state: StoredBindings): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = bindingsFile(dataDir);
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

export class CollaborationProjectBindingStore {
  constructor(private readonly dataDir: string) {}

  async read(localProjectId: string): Promise<CollaborationProjectBinding | null> {
    const state = await readBindings(this.dataDir);
    return state.bindings.find((binding) => binding.localProjectId === localProjectId) ?? null;
  }

  async create(input: {
    localProjectId: string;
    serverOrigin: string;
    remoteProjectId: string;
    remoteRevision: number;
    publishedVersionId: string | null;
    now: string;
  }): Promise<CollaborationProjectBinding> {
    return withLock(this.dataDir, async () => {
      const state = await readBindings(this.dataDir);
      const existing = state.bindings.find(
        (binding) => binding.localProjectId === input.localProjectId,
      );
      if (existing) {
        if (
          existing.serverOrigin === input.serverOrigin
          && existing.remoteProjectId === input.remoteProjectId
        ) {
          return existing;
        }
        throw new CollaborationProjectBindingConflictError(
          'Local Project already has a different Collaboration binding',
        );
      }
      const binding = CollaborationProjectBindingSchema.parse({
        localProjectId: input.localProjectId,
        serverOrigin: input.serverOrigin,
        remoteProjectId: input.remoteProjectId,
        authorityMode: 'local-authoritative',
        remoteRevision: input.remoteRevision,
        publishedVersionId: input.publishedVersionId,
        lastPublishedVersionNumber: null,
        createdAt: input.now,
        updatedAt: input.now,
      });
      state.bindings.push(binding);
      await writeBindings(this.dataDir, state);
      return binding;
    });
  }

  async recordPublish(input: {
    localProjectId: string;
    serverOrigin: string;
    remoteProjectId: string;
    remoteRevision: number;
    publishedVersionId: string;
    versionNumber: number;
    now: string;
  }): Promise<CollaborationProjectBinding> {
    return withLock(this.dataDir, async () => {
      const state = await readBindings(this.dataDir);
      const index = state.bindings.findIndex(
        (binding) => binding.localProjectId === input.localProjectId,
      );
      const existing = index >= 0 ? state.bindings[index] : null;
      if (
        !existing
        || existing.serverOrigin !== input.serverOrigin
        || existing.remoteProjectId !== input.remoteProjectId
      ) {
        throw new CollaborationProjectBindingConflictError(
          'Collaboration binding changed while Publish was in progress',
        );
      }
      const binding = CollaborationProjectBindingSchema.parse({
        ...existing,
        remoteRevision: input.remoteRevision,
        publishedVersionId: input.publishedVersionId,
        lastPublishedVersionNumber: input.versionNumber,
        updatedAt: input.now,
      });
      state.bindings[index] = binding;
      await writeBindings(this.dataDir, state);
      return binding;
    });
  }

  async remove(localProjectId: string): Promise<boolean> {
    return withLock(this.dataDir, async () => {
      const state = await readBindings(this.dataDir);
      const bindings = state.bindings.filter(
        (binding) => binding.localProjectId !== localProjectId,
      );
      if (bindings.length === state.bindings.length) return false;
      await writeBindings(this.dataDir, { version: 1, bindings });
      return true;
    });
  }
}
