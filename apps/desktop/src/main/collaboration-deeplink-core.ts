export const COLLABORATION_DEEPLINK_SCHEME = 'opendesign';

export type CollaborationDeeplink =
  | {
      kind: 'invitation';
      serverOrigin: string;
      invitationId: string;
      token: string;
    }
  | {
      kind: 'review';
      serverOrigin: string;
      projectId: string;
      versionId: string;
    };

export type ProtocolClientRegistration =
  | { register: false }
  | { register: true; clientPath: string | null };

export interface CollaborationDeeplinkDeps {
  navigate: (path: string) => void | Promise<void>;
  focus?: () => void;
  onCompleted?: (outcome: { ok: boolean; kind?: CollaborationDeeplink['kind']; reason?: string }) => void;
  protocolClientPath?: string | null;
}

type HandleDeeplink = (
  url: string,
  deps: CollaborationDeeplinkDeps,
) => Promise<{ ok: boolean; kind?: CollaborationDeeplink['kind']; reason?: string }>;

function requiredQuery(parsed: URL, name: string): string | null {
  const value = parsed.searchParams.get(name)?.trim();
  return value ? value : null;
}

function validServerOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseCollaborationDeeplink(url: string): CollaborationDeeplink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${COLLABORATION_DEEPLINK_SCHEME}:` || parsed.host !== 'collaboration') return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  const server = requiredQuery(parsed, 'server');
  const serverOrigin = server ? validServerOrigin(server) : null;
  if (!serverOrigin) return null;
  if (path === '/invite/continue') {
    const invitationId = requiredQuery(parsed, 'invite_id');
    const token = requiredQuery(parsed, 'nonce');
    if (!invitationId || !token || token.length < 32) return null;
    return { kind: 'invitation', serverOrigin, invitationId, token };
  }
  if (path === '/review/open') {
    const projectId = requiredQuery(parsed, 'project_id');
    const versionId = requiredQuery(parsed, 'version_id');
    if (!projectId || !versionId) return null;
    return { kind: 'review', serverOrigin, projectId, versionId };
  }
  return null;
}

export function collaborationDeeplinkAppPath(deeplink: CollaborationDeeplink): string {
  const query = new URLSearchParams({
    collaboration_action: deeplink.kind,
    server: deeplink.serverOrigin,
  });
  if (deeplink.kind === 'invitation') {
    query.set('invitation_id', deeplink.invitationId);
    query.set('token', deeplink.token);
  } else {
    query.set('project_id', deeplink.projectId);
    query.set('version_id', deeplink.versionId);
  }
  return `/settings?${query}`;
}

export function planProtocolClientRegistration(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  protocolClientPath?: string | null;
}): ProtocolClientRegistration {
  if (!input.isPackaged) return { register: false };
  return {
    register: true,
    clientPath: input.platform === 'win32' ? input.protocolClientPath ?? null : null,
  };
}

export function findCollaborationDeeplinkArg(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${COLLABORATION_DEEPLINK_SCHEME}://`)) ?? null;
}

export async function handleCollaborationDeeplink(
  url: string,
  deps: CollaborationDeeplinkDeps,
): Promise<{ ok: boolean; kind?: CollaborationDeeplink['kind']; reason?: string }> {
  const deeplink = parseCollaborationDeeplink(url);
  if (!deeplink) return complete(deps, { ok: false, reason: 'unsupported_deeplink' });
  try {
    await deps.navigate(collaborationDeeplinkAppPath(deeplink));
    deps.focus?.();
    return complete(deps, { ok: true, kind: deeplink.kind });
  } catch {
    return complete(deps, { ok: false, kind: deeplink.kind, reason: 'navigation_failed' });
  }
}

export function createCollaborationDeeplinkDispatcher(
  handler: HandleDeeplink = handleCollaborationDeeplink,
) {
  let deps: CollaborationDeeplinkDeps | null = null;
  const pending: string[] = [];
  const dispatch = (url: string | null) => {
    if (!url) return;
    if (!deps) {
      pending.push(url);
      return;
    }
    void handler(url, deps);
  };
  return {
    dispatch,
    setDeps(next: CollaborationDeeplinkDeps) {
      deps = next;
      for (const url of pending.splice(0)) dispatch(url);
    },
    pendingCount: () => pending.length,
  };
}

function complete(
  deps: CollaborationDeeplinkDeps,
  outcome: { ok: boolean; kind?: CollaborationDeeplink['kind']; reason?: string },
) {
  try {
    deps.onCompleted?.(outcome);
  } catch {
    // Completion reporting is observational only.
  }
  return outcome;
}
