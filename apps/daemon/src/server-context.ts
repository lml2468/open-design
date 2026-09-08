import type { Express } from 'express';
import type { SkillInfo } from './skills.js';
import type { DesignSystemSummary } from './design-systems/index.js';
import type { RoutineRoutesService } from './routes/routine.js';
import type { OpenDesignPublicMetadataService } from './services/open-design-public-metadata.js';
import type {
  AuthorizeProjectRequest,
  AuthorizeProjectToolRequest,
} from './collab/project-request-authority.js';

export interface HttpDeps {
  createSseResponse: (...args: any[]) => any;
  getPublicBaseUrl?: (...args: any[]) => string;
  isLocalSameOrigin: (...args: any[]) => boolean;
  requireLocalDaemonRequest: (...args: any[]) => any;
  resolvedPortRef: { current: number };
  sendApiError: (...args: any[]) => any;
  sendLiveArtifactRouteError: (...args: any[]) => any;
  sendMulterError: (...args: any[]) => any;
}

export interface PathDeps {
  ARTIFACTS_DIR: string;
  BRANDS_DIR: string;
  BUNDLED_PETS_DIR: string;
  CRAFT_DIR: string;
  DESIGN_SYSTEMS_DIR: string;
  // Bundled rendering catalogue (see specs/current/skills-and-design-templates.md).
  // Distinct from SKILLS_DIR so the EntryView Templates surface and the
  // Settings → Skills surface stay decoupled.
  DESIGN_TEMPLATES_DIR: string;
  // Global OD Library data root for owned, content-addressed assets
  // (derived from RUNTIME_DATA_DIR). See apps/daemon/src/library.ts.
  LIBRARY_DIR: string;
  OD_BIN: string;
  PROJECT_ROOT: string;
  PROJECTS_DIR: string;
  PROMPT_TEMPLATES_DIR: string;
  RUNTIME_DATA_DIR: string;
  RUNTIME_DATA_DIR_CANONICAL: string;
  SKILLS_DIR: string;
  USER_DESIGN_SYSTEMS_DIR: string;
  // Mirror of USER_SKILLS_DIR rooted at DESIGN_TEMPLATES_DIR so user
  // imports of templates do not collide with imports of functional skills.
  USER_DESIGN_TEMPLATES_DIR: string;
  USER_SKILLS_DIR: string;
}

export interface ResourceDeps {
  FIRST_PARTY_ATOMS?: Array<any>;
  // `workspaceId` scopes the user half of the catalog to one workspace (#145).
  // Omit it to resolve a design system by id from anywhere.
  listAllDesignSystems: (options?: {
    workspaceId?: string | null;
    workspaceMemberId?: string | null;
  }) => Promise<Array<DesignSystemSummary & { source?: string }>>;
  // The workspace a catalog read should be scoped to (#145). Data-plane reads
  // resolve it from this exact request's explicit Workspace/member identity,
  // never from a daemon-global active/current Workspace.
  resolveWorkspaceScope?: (req: any) => Promise<string | null>;
  // `workspaceId` scopes user-imported skills to one workspace, same
  // one-way "unclaimed visible everywhere, claimed elsewhere hidden" rule
  // as `listAllDesignSystems` above. Omit it to resolve a skill by id (or
  // compose the system prompt) from anywhere.
  listAllSkills: (options?: {
    workspaceId?: string | null;
    workspaceMemberId?: string | null;
  }) => Promise<Array<SkillInfo & { source?: string }>>;
  // Mirrors listAllSkills but scans DESIGN_TEMPLATE_ROOTS so the Templates
  // surface only sees rendering-catalogue entries.
  listAllDesignTemplates: () => Promise<Array<SkillInfo & { source?: string }>>;
  // Spans both functional skills and design templates so cross-surface
  // resolvers (chat run system prompt, orbit template resolver,
  // /api/skills/:id/example, /api/skills/:id/assets/*) keep working when
  // a stored project.skillId points at either root.
  listAllSkillLikeEntries: (options?: {
    workspaceId?: string | null;
    workspaceMemberId?: string | null;
  }) => Promise<Array<SkillInfo & { source?: string }>>;
  mimeFor: (filePath: string) => string;
}

export interface RoutineDeps {
  routineService: RoutineRoutesService;
}

export interface ProjectPreviewScopeDeps {
  mint: (
    projectId: string,
    workspace?: { workspaceId: string; workspaceMemberId: string } | null,
    options?: { readonly ttlMs?: number },
  ) => string;
  revoke: (scope: string) => void;
  expiresAt: (projectId: string, scope: string) => number | undefined;
  renew: (
    projectId: string,
    scope: string,
    options?: { readonly ttlMs?: number },
  ) => number | undefined;
  validate: (projectId: string, scope: string) => boolean;
  resolve: (
    projectId: string,
    scope: string,
  ) => { workspaceId: string; workspaceMemberId: string } | null | undefined;
}

export interface TelemetryDeps {
  reportFinalizedMessage: (
    saved: any,
    body?: any,
    options?: {
      analyticsContext?: any;
      projectId?: string;
      conversationId?: string;
      reportTrigger?: 'final_message' | 'terminal_fallback';
    },
  ) => void;
  /**
   * Best-effort Langfuse score emission for assistant-turn user ratings.
   * Returns the categorical outcome so the API surface in chat-routes can
   * report back to the web client whether the report was accepted or
   * skipped (consent off / no sink). The handler must not await this in
   * the request hot path — fire-and-forget.
   */
  reportFeedback?: (req: {
    runId: string;
    rating: 'positive' | 'negative';
    reasonCodes: string[];
    hasCustomReason: boolean;
    customReason: string;
    scoreMetadata?: Record<string, unknown>;
  }) => Promise<{ status: 'accepted' | 'skipped_consent' | 'skipped_no_sink' }>;
  reportRunCompletionTelemetryFallback: (...args: any[]) => any;
  resolveRunProjectKindForAnalytics: (...args: any[]) => any;
  runArtifactBaselines: any;
  runRetryEventsForAnalytics: (...args: any[]) => any;
  /** Product-result capture for request-scoped, consented analytics. */
  captureProductEvent?: (
    req: any,
    eventName: string,
    properties: Record<string, unknown>,
  ) => Promise<void> | void;
  /** Update one PostHog Workspace group from an authoritative read. */
  identifyWorkspaceGroup?: (
    req: any,
    workspaceId: string,
    properties: Record<string, unknown>,
  ) => Promise<void> | void;
}

export interface ServerContext {
  db: any;
  design: any;
  http: HttpDeps;
  paths: PathDeps;
  ids: any;
  uploads: any;
  node: any;
  projectStore: any;
  authorizeProjectRequest: AuthorizeProjectRequest;
  authorizeProjectToolRequest: AuthorizeProjectToolRequest;
  isApiTokenAuthorization: (authorization: string | undefined) => boolean;
  projectFiles: any;
  conversations: any;
  templates: any;
  status: any;
  events: any;
  imports: any;
  exports: any;
  artifacts: any;
  documents: any;
  auth: any;
  liveArtifacts: any;
  deploy: any;
  media: any;
  appConfig: any;
  orbit: any;
  nativeDialogs: any;
  research: any;
  mcp: {
    pendingAuth: any;
    daemonUrlRef: { current: string };
    inheritedEnvironment: (baseEnv?: NodeJS.ProcessEnv) => Record<string, string>;
  };
  plugins: any;
  resources: ResourceDeps;
  routines: RoutineDeps;
  projectPreviewScopes: ProjectPreviewScopeDeps;
  telemetry: TelemetryDeps;
  validation: any;
  finalize: any;
  handoff: any;
  chat: any;
  messages: any;
  agents: any;
  critique: any;
  openDesignPublicMetadata: OpenDesignPublicMetadataService;
  lifecycle: {
    isDaemonShuttingDown: () => boolean;
  };
}

export type RouteDeps<K extends keyof ServerContext> = Pick<ServerContext, K>;

export type RouteRegistrar = (app: Express, ctx: ServerContext) => void;
