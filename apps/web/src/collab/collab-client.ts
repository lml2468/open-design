// Legacy Team collaboration client retained while the sync/mirror path is
// removed. It now owns only project synchronization status.

import type {
  CollabMemberRole,
  ProjectContentTransferState,
  ProjectSyncState,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { coalescedGet, evictCoalescedGet } from '../lib/coalesced-get';
import {
  workspaceIdentityCacheKey,
  workspaceProjectHeaders,
} from './workspace-identity';

export interface CollabSnapshot {
  publishedVersion: number | null;
  materializedVersion: number | null;
  contentTransferState: ProjectContentTransferState | null;
  awaitingFirstMaterialization: boolean;
  statusPollGeneration: number;
  syncState: ProjectSyncState | null;
  ownerMemberId: string | null;
  ownerDisplayName: string | null;
  ownerRole: CollabMemberRole | null;
}

export interface CollabClientOptions {
  projectId: string;
  workspaceContext?: WorkspaceCollabContext;
  fetch?: typeof fetch;
  baseUrl?: string;
  statusPollMs?: number;
  onUpdate?: (snapshot: CollabSnapshot) => void;
  onError?: (error: unknown) => void;
}

const DEFAULT_STATUS_POLL_MS = 5_000;

export class CollabClient {
  private readonly projectId: string;
  private readonly workspaceContext: WorkspaceCollabContext | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly statusPollMs: number;
  private readonly onUpdate?: CollabClientOptions['onUpdate'];
  private readonly onError?: CollabClientOptions['onError'];
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private snapshot: CollabSnapshot = {
    publishedVersion: null,
    materializedVersion: null,
    contentTransferState: null,
    awaitingFirstMaterialization: false,
    statusPollGeneration: 0,
    syncState: null,
    ownerMemberId: null,
    ownerDisplayName: null,
    ownerRole: null,
  };
  private contentTransferStateGeneration = 0;
  private contentTransferStatusRequestGeneration = 0;
  private lifecycleGeneration = 0;
  private running = false;
  private onVisibilityChange: (() => void) | null = null;

  constructor(options: CollabClientOptions) {
    this.projectId = options.projectId;
    this.workspaceContext = options.workspaceContext;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? '';
    this.statusPollMs = Math.max(1_000, options.statusPollMs ?? DEFAULT_STATUS_POLL_MS);
    this.onUpdate = options.onUpdate;
    this.onError = options.onError;
  }

  getSnapshot(): CollabSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const lifecycleGeneration = ++this.lifecycleGeneration;
    const statusRequestGeneration = this.contentTransferStatusRequestGeneration;
    queueMicrotask(() => {
      if (
        this.running
        && lifecycleGeneration === this.lifecycleGeneration
        && statusRequestGeneration === this.contentTransferStatusRequestGeneration
      ) {
        void this.pollStatus();
      }
    });
    const visible = () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden';
    this.timers.push(setInterval(() => {
      if (visible()) void this.pollStatus();
    }, this.statusPollMs));
    if (typeof document !== 'undefined') {
      this.onVisibilityChange = () => {
        if (visible()) void this.pollStatus();
      };
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.lifecycleGeneration += 1;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
  }

  async reportChange(): Promise<void> {
    await this.post('/collab/changed');
  }

  async requestPublish(): Promise<void> {
    await this.post('/collab/publish');
  }

  async pollStatus(): Promise<void> {
    const statusRequestGeneration = ++this.contentTransferStatusRequestGeneration;
    const transferGenerationAtStart = this.contentTransferStateGeneration;
    try {
      const body = await this.get('/collab/status');
      const contentTransferState = parseProjectContentTransferState(
        body?.contentTransferState,
      );
      const reportsContentTransferState =
        body != null
        && typeof body === 'object'
        && Object.prototype.hasOwnProperty.call(body, 'contentTransferState');
      const next: Partial<CollabSnapshot> = {
        publishedVersion:
          typeof body?.publishedVersion === 'number'
            ? body.publishedVersion
            : null,
        materializedVersion:
          typeof body?.materializedVersion === 'number'
            ? body.materializedVersion
            : null,
        awaitingFirstMaterialization:
          body?.awaitingFirstMaterialization === true,
        statusPollGeneration: this.snapshot.statusPollGeneration + 1,
        syncState:
          (body?.syncState as ProjectSyncState | undefined) ?? null,
        ownerMemberId:
          typeof body?.ownerMemberId === 'string'
            ? body.ownerMemberId
            : null,
        ownerDisplayName:
          typeof body?.ownerDisplayName === 'string'
            ? body.ownerDisplayName
            : null,
        ownerRole: isCollabMemberRole(body?.ownerRole)
          ? body.ownerRole
          : null,
      };
      const transferResponseIsCurrent =
        reportsContentTransferState
        && statusRequestGeneration === this.contentTransferStatusRequestGeneration
        && transferGenerationAtStart === this.contentTransferStateGeneration;
      if (transferResponseIsCurrent) {
        if (
          contentTransferState
          && (
            this.snapshot.contentTransferState == null
            || contentTransferState.updatedAt
              >= this.snapshot.contentTransferState.updatedAt
          )
        ) {
          next.contentTransferState = contentTransferState;
        } else if (body?.contentTransferState == null) {
          next.contentTransferState = null;
        }
        this.contentTransferStateGeneration += 1;
      }
      this.update(next);
    } catch (error) {
      this.onError?.(error);
    }
  }

  applyContentTransferState(state: ProjectContentTransferState): void {
    const current = this.snapshot.contentTransferState;
    if (current && current.updatedAt > state.updatedAt) return;
    this.contentTransferStateGeneration += 1;
    this.update({ contentTransferState: state });
  }

  private update(patch: Partial<CollabSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate?.(this.snapshot);
  }

  private async get(path: string): Promise<Record<string, unknown> | null> {
    const response = await this.fetchImpl(this.url(path), {
      ...(this.workspaceContext
        ? { headers: workspaceProjectHeaders(this.workspaceContext) }
        : {}),
    });
    if (!response.ok) {
      throw new Error(`collab GET ${path} failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  private async post(
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | null> {
    const init: RequestInit = {
      method: 'POST',
      ...(this.workspaceContext
        ? { headers: workspaceProjectHeaders(this.workspaceContext) }
        : {}),
    };
    if (body !== undefined) {
      init.headers = {
        ...(this.workspaceContext
          ? workspaceProjectHeaders(this.workspaceContext)
          : {}),
        'content-type': 'application/json',
      };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) {
      throw new Error(`collab POST ${path} failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/projects/${encodeURIComponent(this.projectId)}${path}`;
  }
}

export function fetchProjectCollabStatus(
  projectId: string,
  options?: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    workspaceContext?: WorkspaceCollabContext;
  },
): Promise<Record<string, unknown> | null> {
  const baseUrl = options?.baseUrl ?? '';
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const identity = workspaceIdentityCacheKey(options?.workspaceContext);
  return coalescedGet(`collab-status:${baseUrl}|${identity}|${projectId}`, async () => {
    const response = await fetchImpl(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/collab/status`,
      options?.workspaceContext
        ? { headers: workspaceProjectHeaders(options.workspaceContext) }
        : undefined,
    );
    if (!response.ok) {
      throw new Error(`collab GET /collab/status failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  });
}

export function evictProjectCollabStatusRead(
  projectId: string,
  baseUrl = '',
  workspaceContext?: WorkspaceCollabContext,
): void {
  evictCoalescedGet(
    `collab-status:${baseUrl}|${workspaceIdentityCacheKey(workspaceContext)}|${projectId}`,
  );
}

function isCollabMemberRole(value: unknown): value is CollabMemberRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

function parseProjectContentTransferState(
  value: unknown,
): ProjectContentTransferState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== 'downloading' && candidate.status !== 'idle') {
    return null;
  }
  if (
    typeof candidate.startedAt !== 'number'
    || !Number.isFinite(candidate.startedAt)
    || typeof candidate.updatedAt !== 'number'
    || !Number.isFinite(candidate.updatedAt)
  ) {
    return null;
  }
  if (
    candidate.version !== undefined
    && (
      typeof candidate.version !== 'number'
      || !Number.isSafeInteger(candidate.version)
      || candidate.version < 0
    )
  ) {
    return null;
  }
  return {
    status: candidate.status,
    ...(typeof candidate.version === 'number'
      ? { version: candidate.version }
      : {}),
    startedAt: candidate.startedAt,
    updatedAt: candidate.updatedAt,
  };
}
