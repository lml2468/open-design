// `GET /api/runs` ships `awaitingInputProjectIds` beside the runs.
//
// `ChatRunStatus` cannot express "waiting on the user": the run that emitted a
// `<question-form>` reports `succeeded` and exits while the project stays
// blocked, so a client folding this feed into a per-project status would show
// such a project as finished. The route composes the set from the same
// `listProjectsAwaitingInput` read `GET /api/projects` uses, intersected with
// the projects the returned runs already reveal so it can never widen what a
// caller may see.

import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import { registerRunRoutes } from '../src/routes/runs.js';
import { connectorService } from '../src/connectors/service.js';

let server: http.Server | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const SECOND_AWAITING_PROJECT = 'p-second-awaiting';
const UNBOUND_PROJECT = 'p-unbound-awaiting';
const ANSWERED_PROJECT = 'p-unbound-answered';
const QUIET_PROJECT = 'p-unbound-quiet';
/** Awaiting input, but no run of its own — must never surface through another
 *  project's query. */
const RUNLESS_PROJECT = 'p-unbound-runless';

const RENDERABLE_FORM =
  'Which direction? <question-form>{"questions":[{"id":"dir","label":"Direction?"}]}</question-form>';

function sendApiError(
  res: any,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return res.status(status).json({ error: { code, message, ...details } });
}

function seedRun(runs: Map<string, any>, input: Record<string, unknown>) {
  const run: Record<string, any> = {
    conversationId: null,
    assistantMessageId: null,
    clientRequestId: null,
    requestFingerprint: null,
    message: null,
    currentPrompt: null,
    status: 'succeeded',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    events: [],
    clients: new Set(),
    ...input,
  };
  runs.set(String(run.id), run);
  return run;
}

/** An assistant turn that asked, optionally followed by the user's answer. */
function seedConversation(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  options: { asked: boolean; answered?: boolean },
) {
  const conversationId = `conv-${projectId}`;
  insertConversation(db, { id: conversationId, projectId, createdAt: 1, updatedAt: 1 });
  if (!options.asked) return;
  upsertMessage(db, conversationId, {
    id: `msg-${projectId}-ask`,
    role: 'assistant',
    content: RENDERABLE_FORM,
    createdAt: 10,
  });
  if (options.answered) {
    upsertMessage(db, conversationId, {
      id: `msg-${projectId}-answer`,
      role: 'user',
      content: 'Left.',
      createdAt: 20,
    });
  }
}

async function startServer() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-runs-awaiting-'));
  const db = openDatabase(tempDir);
  const now = Date.now();
  for (const id of [
    SECOND_AWAITING_PROJECT,
    UNBOUND_PROJECT,
    ANSWERED_PROJECT,
    QUIET_PROJECT,
    RUNLESS_PROJECT,
  ]) {
    insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
  }
  seedConversation(db, SECOND_AWAITING_PROJECT, { asked: true });
  seedConversation(db, UNBOUND_PROJECT, { asked: true });
  seedConversation(db, ANSWERED_PROJECT, { asked: true, answered: true });
  seedConversation(db, QUIET_PROJECT, { asked: false });
  seedConversation(db, RUNLESS_PROJECT, { asked: true });

  const runs = new Map<string, any>();
  seedRun(runs, {
    id: 'run-second-awaiting',
    projectId: SECOND_AWAITING_PROJECT,
    agentId: 'claude',
  });
  seedRun(runs, { id: 'run-unbound', projectId: UNBOUND_PROJECT, agentId: 'claude' });
  seedRun(runs, { id: 'run-answered', projectId: ANSWERED_PROJECT, agentId: 'claude' });
  seedRun(runs, { id: 'run-quiet', projectId: QUIET_PROJECT, agentId: 'claude' });

  const runsService = {
    get: (id: string) => runs.get(id) ?? null,
    list: (filters: { projectId?: unknown } = {}) =>
      Array.from(runs.values()).filter(
        (run) => typeof filters.projectId !== 'string' || run.projectId === filters.projectId,
      ),
    statusBody: (run: any) => ({ ...run }),
    fail: (run: any, code: string, message: string) => {
      run.status = 'failed';
      run.errorCode = code;
      run.error = message;
    },
    isTerminal: (status: string) =>
      status === 'succeeded' || status === 'failed' || status === 'canceled',
  };

  const app = express();
  app.use(express.json());
  registerRunRoutes(app, {
    db,
    design: {
      runs: runsService,
      analytics: { capture: () => {} },
      getAppVersion: () => 'test',
    },
    http: {
      createSseResponse: () => ({ send() {}, end() {}, cleanup() {} }),
      sendApiError,
    },
    paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    agents: {
      detectAgents: async () => [],
      getAgentDef: () => null,
    },
    chat: { startChatRun: async () => undefined },
    byokCredentials: { has: async () => false },
    lifecycle: { isDaemonShuttingDown: () => false },
    plugins: {
      connectorService,
      detectSkillPluginCandidateOnRunSuccess: () => {},
      firePipelineForRun: () => {},
      loadPluginRegistryView: async () => ({} as any),
      renderPluginBriefTemplate: (template: string) => template,
    },
    telemetry: {
      reportRunCompletionTelemetryFallback: () => {},
      resolveRunProjectKindForAnalytics: () => null,
      runArtifactBaselines: { take: () => undefined },
      runRetryEventsForAnalytics: () => [],
    },
    messages: {
      pinAssistantMessageOnRunCreate: () => ({ ok: true }),
      reconcileAssistantMessageOnRunEnd: () => {},
    },
  } as any);
  const created = http.createServer(app);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, resolve));
  const address = created.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

type RunListBody = {
  runs: Array<{ id: string; projectId: string | null; status: string }>;
  awaitingInputProjectIds?: string[];
};

describe('GET /api/runs — awaitingInputProjectIds', () => {
  it('flags a project whose succeeded run left a question the user has not answered', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/runs?projectId=${UNBOUND_PROJECT}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunListBody;
    expect(body.runs.map((run) => run.status)).toEqual(['succeeded']);
    expect(body.awaitingInputProjectIds).toEqual([UNBOUND_PROJECT]);
  });

  it('always sends the field, empty when nothing is pending', async () => {
    const baseUrl = await startServer();
    const quiet = (await (await fetch(`${baseUrl}/api/runs?projectId=${QUIET_PROJECT}`)).json()) as RunListBody;
    expect(quiet.runs).toHaveLength(1);
    expect(quiet.awaitingInputProjectIds).toEqual([]);

    // A later user reply answers the form, so the project is no longer blocked.
    const answered = (await (await fetch(`${baseUrl}/api/runs?projectId=${ANSWERED_PROJECT}`)).json()) as RunListBody;
    expect(answered.runs).toHaveLength(1);
    expect(answered.awaitingInputProjectIds).toEqual([]);
  });

  it('never names a project the returned runs do not reveal', async () => {
    const baseUrl = await startServer();
    // RUNLESS_PROJECT is awaiting input in the database, but it has no run in
    // this feed — so a query for another project must not leak its id.
    const body = (await (await fetch(`${baseUrl}/api/runs?projectId=${UNBOUND_PROJECT}`)).json()) as RunListBody;
    expect(body.awaitingInputProjectIds).not.toContain(RUNLESS_PROJECT);
    expect(body.awaitingInputProjectIds).not.toContain(SECOND_AWAITING_PROJECT);
  });

  it('reports another local project when its run is requested', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/runs?projectId=${SECOND_AWAITING_PROJECT}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RunListBody;
    expect(body.runs.map((run) => run.id)).toEqual(['run-second-awaiting']);
    expect(body.awaitingInputProjectIds).toEqual([SECOND_AWAITING_PROJECT]);
  });
});
