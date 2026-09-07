import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectContentTransferState,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  CollabClient,
  type CollabClientOptions,
  type CollabSnapshot,
} from './collab-client';
import { workspaceIdentityCacheKey } from './workspace-identity';

export interface UseCollabOptions {
  projectId: string | null | undefined;
  workspaceContext?: WorkspaceCollabContext | null;
  enabled?: boolean;
  baseUrl?: string;
  statusPollMs?: number;
  fetch?: typeof fetch;
}

export interface UseCollabResult {
  publishedVersion: number | null;
  materializedVersion: number | null;
  contentTransferState: ProjectContentTransferState | null;
  awaitingFirstMaterialization: boolean;
  statusPollGeneration: number;
  syncState: CollabSnapshot['syncState'];
  ownerMemberId: CollabSnapshot['ownerMemberId'];
  ownerDisplayName: CollabSnapshot['ownerDisplayName'];
  ownerRole: CollabSnapshot['ownerRole'];
  reportChange: () => void;
  requestPublish: () => void;
  pull: () => Promise<number | null>;
  checkStatusNow: () => void;
  applyContentTransferState: (state: ProjectContentTransferState) => void;
}

const EMPTY: CollabSnapshot = {
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

interface ProjectScopedSnapshot {
  sourceProjectId: string | null;
  sourceWorkspaceIdentity: string;
  snapshot: CollabSnapshot;
}

const EMPTY_SCOPED_SNAPSHOT: ProjectScopedSnapshot = {
  sourceProjectId: null,
  sourceWorkspaceIdentity: 'none',
  snapshot: EMPTY,
};

/** React seam over the remaining legacy status/pull client. */
export function useCollab(options: UseCollabOptions): UseCollabResult {
  const { projectId, enabled = true } = options;
  const workspaceIdentity =
    options.workspaceContext === undefined
      ? 'legacy'
      : workspaceIdentityCacheKey(options.workspaceContext);
  const active = Boolean(
    enabled && projectId && options.workspaceContext !== null,
  );
  const [scopedSnapshot, setScopedSnapshot] =
    useState<ProjectScopedSnapshot>(EMPTY_SCOPED_SNAPSHOT);
  const snapshot =
    active
      && scopedSnapshot.sourceProjectId === (projectId ?? null)
      && scopedSnapshot.sourceWorkspaceIdentity === workspaceIdentity
      ? scopedSnapshot.snapshot
      : EMPTY;
  const clientRef = useRef<CollabClient | null>(null);

  useEffect(() => {
    if (!active || !projectId) {
      setScopedSnapshot(EMPTY_SCOPED_SNAPSHOT);
      return;
    }
    let disposed = false;
    const clientOptions: CollabClientOptions = {
      projectId,
      ...(options.workspaceContext
        ? { workspaceContext: options.workspaceContext }
        : {}),
      onUpdate: (nextSnapshot) => {
        if (!disposed) {
          setScopedSnapshot({
            sourceProjectId: projectId,
            sourceWorkspaceIdentity: workspaceIdentity,
            snapshot: nextSnapshot,
          });
        }
      },
    };
    if (options.baseUrl !== undefined) clientOptions.baseUrl = options.baseUrl;
    if (options.statusPollMs !== undefined) {
      clientOptions.statusPollMs = options.statusPollMs;
    }
    if (options.fetch !== undefined) clientOptions.fetch = options.fetch;

    const client = new CollabClient(clientOptions);
    clientRef.current = client;
    client.start();
    return () => {
      disposed = true;
      client.stop();
      clientRef.current = null;
      setScopedSnapshot(EMPTY_SCOPED_SNAPSHOT);
    };
    // fetch is intentionally not a restart trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    projectId,
    workspaceIdentity,
    options.baseUrl,
    options.statusPollMs,
  ]);

  const reportChange = useCallback(() => {
    void clientRef.current?.reportChange();
  }, []);
  const requestPublish = useCallback(() => {
    void clientRef.current?.requestPublish();
  }, []);
  const pull = useCallback(async () => {
    return (await clientRef.current?.pull()) ?? null;
  }, []);
  const checkStatusNow = useCallback(() => {
    void clientRef.current?.pollStatus();
  }, []);
  const applyContentTransferState = useCallback(
    (state: ProjectContentTransferState) => {
      clientRef.current?.applyContentTransferState(state);
    },
    [],
  );

  return {
    publishedVersion: snapshot.publishedVersion,
    materializedVersion: snapshot.materializedVersion,
    contentTransferState: snapshot.contentTransferState,
    awaitingFirstMaterialization: snapshot.awaitingFirstMaterialization,
    statusPollGeneration: snapshot.statusPollGeneration,
    syncState: snapshot.syncState,
    ownerMemberId: snapshot.ownerMemberId,
    ownerDisplayName: snapshot.ownerDisplayName,
    ownerRole: snapshot.ownerRole,
    reportChange,
    requestPublish,
    pull,
    checkStatusNow,
    applyContentTransferState,
  };
}
