import { createContext, useContext, type ReactNode } from 'react';
import type { AnchorWriteBack } from '../comments';

// Shares local comment ownership with deep descendants without prop-threading
// through the large project view. Remote Collaboration snapshots use their
// dedicated review surface.

export interface CollabContextValue {
  /** Persist a drifted-to-`lost` comment's last-good position (needs the active
   * conversation id, which only ProjectView has). Absent when unavailable. */
  onLostAnchors?: (writeBacks: AnchorWriteBack[]) => void;
}

const DISABLED: CollabContextValue = {};

const CollabContext = createContext<CollabContextValue>(DISABLED);

export function CollabProvider({ value, children }: { value: CollabContextValue; children: ReactNode }) {
  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>;
}

/** The current project's collab state; disabled default outside a provider. */
export function useProjectCollabContext(): CollabContextValue {
  return useContext(CollabContext);
}
