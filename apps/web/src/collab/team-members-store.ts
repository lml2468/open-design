import type {
  CollabCloudMemberDirectoryEntry,
  CollabCloudMembersResponse,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  workspaceIdentityCacheKey,
  workspaceProjectHeaders,
} from './workspace-identity';

export const TEAM_MEMBERS_POLL_MS = 15_000;
export const TEAM_MEMBERS_IDLE_TTL_MS = 5 * 60_000;
export const TEAM_MEMBERS_MAX_RETAINED_IDENTITIES = 8;

type StoreListener = () => void;

/**
 * Account generation is part of the browser cache identity even though the
 * daemon authenticates the account implicitly. Two accounts can legitimately
 * expose the same Workspace/member ids; their directories must never share a
 * browser snapshot or an in-flight read.
 */
export function teamMembersIdentity(
  context: WorkspaceCollabContext,
  accountGeneration: number,
): string {
  return JSON.stringify([
    accountGeneration,
    workspaceIdentityCacheKey(context),
  ]);
}

/**
 * One snapshot, in-flight refresh, dirty queue, and poll scheduler for one
 * exact account + Workspace identity.
 */
export class TeamMembersIdentityStore {
  private readonly identity: string;
  private readonly context: WorkspaceCollabContext;
  private readonly listeners = new Set<StoreListener>();
  private readonly consumers = new Set<symbol>();
  private members: CollabCloudMemberDirectoryEntry[] = [];
  private inFlight: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private requestEpoch = 0;
  private hasSuccessfulLoad = false;
  private disposed = false;

  constructor(
    identity: string,
    context: WorkspaceCollabContext,
  ) {
    this.identity = identity;
    this.context = context;
    this.scheduleIdleEviction();
  }

  readonly getSnapshot = (): CollabCloudMemberDirectoryEntry[] => this.members;

  readonly subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retain(consumer: symbol): () => void {
    if (this.disposed) return () => {};
    this.cancelIdleEviction();
    touchTeamMembersStore(this.identity, this);
    this.consumers.add(consumer);
    if (this.consumers.size === 1) {
      // A warm remount paints `members` synchronously through
      // useSyncExternalStore, then this refresh runs without clearing it.
      void this.revalidate();
      this.rearmPoll();
    } else if (!this.hasSuccessfulLoad) {
      void this.revalidate();
    }
    return () => this.release(consumer);
  }

  /** One explicit/background refresh. Concurrent callers join one promise. */
  readonly revalidate = async (): Promise<void> => {
    if (this.disposed) return;
    touchTeamMembersStore(this.identity, this);
    if (this.consumers.size === 0) this.refreshIdleEviction();
    if (this.inFlight) return this.inFlight;
    const requestEpoch = ++this.requestEpoch;
    const operation = this.performLoad(requestEpoch);
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  };

  isRetained(): boolean {
    return this.consumers.size > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestEpoch += 1;
    this.stopPoll();
    this.cancelIdleEviction();
  }

  private release(consumer: symbol): void {
    if (!this.consumers.delete(consumer)) return;
    if (this.consumers.size === 0) {
      // Network reads may finish into last-good, but an idle identity owns no
      // scheduler. TTL/LRU below bounds how long its snapshot stays warm.
      this.stopPoll();
      this.scheduleIdleEviction();
      trimTeamMembersStores();
      return;
    }
    this.rearmPoll();
  }

  private async performLoad(requestEpoch: number): Promise<void> {
    try {
      const res = await fetch('/api/workspace/members', {
        headers: workspaceProjectHeaders(this.context),
      });
      if (!res.ok) throw new Error(`members ${res.status}`);
      const body = (await res.json()) as CollabCloudMembersResponse;
      if (!Array.isArray(body.members)) {
        throw new Error('members response missing directory array');
      }
      const members = body.members;
      if (this.disposed || requestEpoch !== this.requestEpoch) return;
      this.hasSuccessfulLoad = true;
      this.members = members;
      touchTeamMembersStore(this.identity, this);
      for (const listener of Array.from(this.listeners)) listener();
    } catch {
      // Failure is not an authoritative empty directory. Preserve last-good;
      // a successful `{ members: [] }` above still clears the snapshot.
    }
  }

  private rearmPoll(): void {
    if (this.consumers.size === 0 || this.disposed) {
      this.stopPoll();
      return;
    }
    const nextIntervalMs = TEAM_MEMBERS_POLL_MS;
    if (this.pollTimer && this.pollIntervalMs === nextIntervalMs) return;
    this.stopPoll();
    this.pollIntervalMs = nextIntervalMs;
    this.pollTimer = setInterval(() => {
      if (
        typeof document === 'undefined'
        || document.visibilityState === 'visible'
      ) {
        void this.revalidate();
      }
    }, nextIntervalMs);
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollIntervalMs = null;
  }

  private scheduleIdleEviction(): void {
    if (this.idleTimer || this.disposed || this.consumers.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      evictTeamMembersStore(this.identity, this);
    }, TEAM_MEMBERS_IDLE_TTL_MS);
  }

  private cancelIdleEviction(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private refreshIdleEviction(): void {
    this.cancelIdleEviction();
    this.scheduleIdleEviction();
  }
}

const teamMembersStores = new Map<string, TeamMembersIdentityStore>();

function touchTeamMembersStore(
  identity: string,
  store: TeamMembersIdentityStore,
): void {
  if (teamMembersStores.get(identity) !== store) return;
  teamMembersStores.delete(identity);
  teamMembersStores.set(identity, store);
}

function evictTeamMembersStore(
  identity: string,
  store: TeamMembersIdentityStore,
): void {
  if (store.isRetained() || teamMembersStores.get(identity) !== store) return;
  teamMembersStores.delete(identity);
  store.dispose();
}

function trimTeamMembersStores(
  protectedStore?: TeamMembersIdentityStore,
): void {
  if (teamMembersStores.size <= TEAM_MEMBERS_MAX_RETAINED_IDENTITIES) return;
  for (const [identity, store] of teamMembersStores) {
    if (store === protectedStore) continue;
    if (!store.isRetained()) evictTeamMembersStore(identity, store);
    if (teamMembersStores.size <= TEAM_MEMBERS_MAX_RETAINED_IDENTITIES) return;
  }
}

export function teamMembersStoreFor(
  context: WorkspaceCollabContext | null | undefined,
  accountGeneration: number,
): TeamMembersIdentityStore | null {
  if (!context) return null;
  const identity = teamMembersIdentity(context, accountGeneration);
  let store = teamMembersStores.get(identity);
  if (!store) {
    store = new TeamMembersIdentityStore(identity, context);
    teamMembersStores.set(identity, store);
    // `teamMembersStoreFor` is called during render; the matching retain effect
    // has not run yet. Never evict the store being returned when every older
    // identity is legitimately active.
    trimTeamMembersStores(store);
  }
  return store;
}

/** Test seam: release timers and snapshots owned by the module registry. */
export function resetTeamMembersStores(): void {
  for (const store of teamMembersStores.values()) store.dispose();
  teamMembersStores.clear();
}
