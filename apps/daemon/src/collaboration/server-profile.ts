import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CollaborationRemoteSessionSchema,
  CollaborationServerCapabilitiesSchema,
  CollaborationServerProfileSchema,
  type CollaborationRemoteSession,
  type CollaborationServerProfile,
  type CollaborationServerState,
} from '@open-design/contracts';

type StoredSession = CollaborationRemoteSession & { accessExpiresAt: number };
type StoredState = {
  profile?: CollaborationServerProfile;
  session?: StoredSession;
};

const writeLocks = new Map<string, Promise<unknown>>();

function stateFile(dataDir: string): string {
  return path.join(dataDir, 'collaboration-server.json');
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

async function readStoredState(dataDir: string): Promise<StoredState> {
  try {
    return sanitizeStoredState(JSON.parse(await readFile(stateFile(dataDir), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function sanitizeStoredState(raw: unknown): StoredState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const profile = CollaborationServerProfileSchema.safeParse(source.profile);
  const sessionSource = source.session;
  let session: StoredSession | undefined;
  if (sessionSource && typeof sessionSource === 'object' && !Array.isArray(sessionSource)) {
    const { accessExpiresAt, ...remoteSessionSource } = sessionSource as Record<string, unknown>;
    const remoteSession = CollaborationRemoteSessionSchema.safeParse(remoteSessionSource);
    if (
      remoteSession.success
      && typeof accessExpiresAt === 'number'
      && Number.isSafeInteger(accessExpiresAt)
      && accessExpiresAt > 0
    ) {
      session = { ...remoteSession.data, accessExpiresAt };
    }
  }
  return {
    ...(profile.success ? { profile: profile.data } : {}),
    ...(profile.success && session ? { session } : {}),
  };
}

async function writeStoredState(dataDir: string, state: StoredState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = stateFile(dataDir);
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

function publicState(state: StoredState): CollaborationServerState {
  return {
    profile: state.profile ?? null,
    session: state.session
      ? { sessionId: state.session.sessionId, user: state.session.user }
      : null,
  };
}

export class CollaborationServerProfileStore {
  constructor(private readonly dataDir: string) {}

  async readPublicState(): Promise<CollaborationServerState> {
    return publicState(await readStoredState(this.dataDir));
  }

  async readCredentials(): Promise<StoredState> {
    return readStoredState(this.dataDir);
  }

  async setProfile(input: {
    origin: string;
    capabilities: unknown;
    checkedAt: string;
  }): Promise<CollaborationServerState> {
    return withLock(this.dataDir, async () => {
      const current = await readStoredState(this.dataDir);
      const profile: CollaborationServerProfile = CollaborationServerProfileSchema.parse({
        id: 'default',
        origin: input.origin,
        capabilities: CollaborationServerCapabilitiesSchema.parse(input.capabilities),
        checkedAt: input.checkedAt,
      });
      const next: StoredState = {
        profile,
        ...(current.profile?.origin === profile.origin && current.session
          ? { session: current.session }
          : {}),
      };
      await writeStoredState(this.dataDir, next);
      return publicState(next);
    });
  }

  async setSession(session: CollaborationRemoteSession, now = Date.now()): Promise<CollaborationServerState> {
    return withLock(this.dataDir, async () => {
      const current = await readStoredState(this.dataDir);
      if (!current.profile) throw new Error('Collaboration Server is not configured');
      const next: StoredState = {
        profile: current.profile,
        session: {
          ...session,
          accessExpiresAt: now + session.expiresIn * 1_000,
        },
      };
      await writeStoredState(this.dataDir, next);
      return publicState(next);
    });
  }

  async clearSession(): Promise<CollaborationServerState> {
    return withLock(this.dataDir, async () => {
      const current = await readStoredState(this.dataDir);
      const next: StoredState = current.profile ? { profile: current.profile } : {};
      await writeStoredState(this.dataDir, next);
      return publicState(next);
    });
  }
}
