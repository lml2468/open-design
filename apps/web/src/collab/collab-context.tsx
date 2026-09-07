import { createContext, useContext, type ReactNode } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import type { AnchorWriteBack } from '../comments';

// Shares project-scoped resource authority and local comment ownership with
// deep descendants without prop-threading through the large project view.
// Remote Collaboration snapshots use their dedicated review surface; this
// context always describes the owner's local project tree.

export type ProjectResourceAuthority = 'pending' | 'denied' | 'local' | 'workspace';

export interface CollabContextValue {
  /** Exact persisted scope of the project being rendered. Never shell navigation state. */
  workspaceContext: WorkspaceCollabContext | null;
  workspaceContextLoading: boolean;
  /** Whether project-owned resources may use local or exact Workspace reads.
   * Optional only for standalone consumers; ProjectView always supplies it. */
  projectResourceAuthority?: ProjectResourceAuthority;
  /** Persist a drifted-to-`lost` comment's last-good position (needs the active
   * conversation id, which only ProjectView has). Absent when unavailable. */
  onLostAnchors?: (writeBacks: AnchorWriteBack[]) => void;
  /** Legacy PreviewComment synchronization is disabled for local projects. */
  enabled: boolean;
  publishedVersion: number | null;
  /** The local project owner may manage projected review comments. */
  isOwner: boolean;
}

const DISABLED: CollabContextValue = {
  workspaceContext: null,
  workspaceContextLoading: false,
  projectResourceAuthority: 'local',
  enabled: false,
  publishedVersion: null,
  isOwner: true,
};

const CollabContext = createContext<CollabContextValue>(DISABLED);

export function CollabProvider({ value, children }: { value: CollabContextValue; children: ReactNode }) {
  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>;
}

/** The current project's collab state; disabled default outside a provider. */
export function useProjectCollabContext(): CollabContextValue {
  return useContext(CollabContext);
}
