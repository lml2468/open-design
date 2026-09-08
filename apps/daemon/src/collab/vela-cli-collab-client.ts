import type {
  CollabCloudMemberDirectoryEntry,
  CollabMemberRole,
} from '@open-design/contracts';
import {
  runVelaCommand,
  velaWorkspaceCommandOptions,
} from '../integrations/vela-command.js';

export type RunVelaCollab = (
  args: string[],
  workspaceId?: string,
) => Promise<string>;

export interface VelaCliCollabClientOptions {
  run?: RunVelaCollab;
}

type MemberWire = {
  memberId?: unknown;
  displayName?: unknown;
  role?: unknown;
  avatarUrl?: unknown;
};

export function createVelaCliCollabClient(options: VelaCliCollabClientOptions = {}) {
  const run = options.run ?? defaultRunVelaCollab;

  async function runJson<T>(args: string[], workspaceId: string): Promise<T> {
    const requestedWorkspaceId = workspaceId.trim();
    if (!requestedWorkspaceId) {
      throw new Error('explicit workspace scope is required');
    }
    const stdout = await run(args, requestedWorkspaceId);
    const trimmed = stdout.trim();
    if (!trimmed) return {} as T;
    return JSON.parse(trimmed) as T;
  }

  return {
    isConfigured(): boolean {
      return true;
    },

    async registerMember(
      _teamId: string,
      _memberId: string,
      input: { displayName: string; role: CollabMemberRole },
    ): Promise<CollabCloudMemberDirectoryEntry> {
      const args = ['member', 'register', '--display-name', input.displayName, '--role', input.role];
      const payload = await runJson<{ member?: MemberWire }>(args, _teamId);
      return toDirectoryEntry(payload.member);
    },

    async listMembers(_teamId: string): Promise<CollabCloudMemberDirectoryEntry[]> {
      const payload = await runJson<{ members?: MemberWire[] }>(
        ['member', 'list'],
        _teamId,
      );
      return Array.isArray(payload.members) ? payload.members.map(toDirectoryEntry) : [];
    },

  };
}

export type VelaCliCollabClient = ReturnType<typeof createVelaCliCollabClient>;

function toDirectoryEntry(input: MemberWire | undefined): CollabCloudMemberDirectoryEntry {
  const memberId = typeof input?.memberId === 'string' ? input.memberId : '';
  const displayName =
    typeof input?.displayName === 'string' && input.displayName.trim()
      ? input.displayName
      : memberId;
  const role = isRole(input?.role) ? input.role : 'member';
  return { memberId, displayName, role };
}

function isRole(value: unknown): value is CollabMemberRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

const defaultRunVelaCollab: RunVelaCollab = (args, workspaceId) =>
  runVelaCommand(
    ['collab', ...args],
    velaWorkspaceCommandOptions(workspaceId),
  );

export function shouldUseVelaCliCollabTransport(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OD_WORKSPACE_CONTEXT_SOURCE?.trim() === 'vela') return true;
  const explicitTransport = env.OD_COLLAB_TRANSPORT?.trim();
  if (explicitTransport) return explicitTransport === 'vela-cli';
  if (env.OD_COLLAB_CLOUD_URL?.trim()) return false;
  return env.OD_TEAM_PROJECTS_TRANSPORT?.trim() === 'vela-cli' ||
    env.OD_RESOURCE_TRANSPORT?.trim() === 'vela-cli';
}

export function createVelaCliCollabClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<VelaCliCollabClientOptions, 'run'> = {},
): VelaCliCollabClient | null {
  return shouldUseVelaCliCollabTransport(env)
    ? createVelaCliCollabClient(options)
    : null;
}
