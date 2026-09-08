// Collab realtime — hop-2 (daemon → web) thin invalidation events.
//
// These are SIGNALS, not payloads. An event says only "something of type X
// changed" (plus the scoping id when relevant); the web reacts by RE-FETCHING
// the affected resource through its existing loaders. Never widen these into
// fat payloads — the whole point of the thin model is that a missed event during
// a disconnect is harmless (the reconnect snapshot re-fetch closes the gap), so
// no server-side event buffer / Last-Event-ID replay is required for
// correctness.
//
// Project-scoped events ride the EXISTING `/api/projects/:id/events` SSE
// alongside `file-changed` / `live_artifact*` / `conversation-created`.
//
// Producer: `apps/daemon` (see `emitProjectEvent` in
// `apps/daemon/src/server.ts`). Consumer: `apps/web` through the Project event
// provider. One shared type here keeps producer and consumer aligned.

/** A comment was added / edited / status-changed / deleted for this project. */
export interface CommentChangedSsePayload {
  type: 'comment-changed';
  projectId: string;
  /** Emit time (epoch ms); advisory only. */
  at?: number;
}

/** The project's name / settings / share metadata changed. */
export interface ProjectMetadataChangedSsePayload {
  type: 'project-metadata-changed';
  projectId: string;
  at?: number;
}

/**
 * Thin invalidation for daemon-local inbound project content. The project id
 * is not an authorization scope: the web must re-read `/collab/status`, which
 * resolves the current workspace/resource/viewer/owner binding, rather than
 * applying an unscoped lifecycle payload directly.
 */
export interface ProjectContentTransferStateSsePayload {
  type: 'project-content-transfer-state';
  projectId: string;
  at?: number;
}

/**
 * Project-scoped collab invalidation events multiplexed onto
 * `/api/projects/:id/events`. Each carries the `projectId` it invalidates.
 */
export type CollabProjectInvalidationSsePayload =
  | CommentChangedSsePayload
  | ProjectMetadataChangedSsePayload;

export const PROJECT_CONTENT_TRANSFER_STATE_EVENT =
  'project-content-transfer-state' as const;

/** The SSE `event:` names for the project-scoped collab invalidations. */
export const COLLAB_PROJECT_INVALIDATION_EVENTS = [
  'comment-changed',
  'project-metadata-changed',
] as const;

export type CollabProjectInvalidationEventName =
  (typeof COLLAB_PROJECT_INVALIDATION_EVENTS)[number];
