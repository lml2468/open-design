import { spawn } from 'node:child_process';
import http from 'node:http';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubResponse {
  status: number;
  body?: unknown;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  setResponder: (responder: (request: CapturedRequest) => StubResponse) => void;
  close: () => Promise<void>;
}

const state = {
  profile: {
    id: 'default',
    origin: 'https://design.example.test',
    capabilities: {
      apiVersion: 'v1',
      minimumDesktopVersion: '0.22.0',
      bundleSchemaVersions: [1],
      authModes: ['local'],
      projectAuthorityModes: ['local-authoritative'],
      features: ['publish', 'review-comments'],
    },
    checkedAt: '2026-09-06T00:00:00.000Z',
  },
  session: null,
};

async function startStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let responder: (request: CapturedRequest) => StubResponse = () => ({
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: 'unexpected request' } },
  });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const captured = {
        method: request.method ?? '',
        url: request.url ?? '',
        body,
      };
      requests.push(captured);
      const result = responder(captured);
      response.statusCode = result.status;
      if (result.status === 204) {
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub server has no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder(next) {
      responder = next;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

function runCli(
  args: string[],
  input = '',
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveRun) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolveRun({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

describe('od collaboration CLI', () => {
  let stub: StubServer;

  beforeAll(async () => {
    stub = await startStubServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
    stub.setResponder(() => ({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'unexpected request' } },
    }));
  });

  it('documents the independent Collaboration Server command surface', async () => {
    const result = await runCli(['collaboration', 'help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('od collaboration server status');
    expect(result.stdout).toContain('--password-stdin');
    expect(result.stdout).not.toContain('--password <');
  });

  it('reads and configures the single server profile through the local daemon', async () => {
    stub.setResponder((request) => {
      if (request.method === 'GET' && request.url === '/api/collaboration/server') {
        return { status: 200, body: state };
      }
      if (request.method === 'PUT' && request.url === '/api/collaboration/server') {
        return { status: 200, body: state };
      }
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'unexpected' } } };
    });

    const status = await runCli([
      'collaboration', 'server', 'status', '--json', '--daemon-url', stub.baseUrl,
    ]);
    const configured = await runCli([
      'collaboration', 'server', 'set', 'https://design.example.test',
      '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(state);
    expect(configured.code).toBe(0);
    expect(JSON.parse(stub.requests[1]!.body)).toEqual({ origin: 'https://design.example.test' });
    expect(stub.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: '/api/collaboration/server' },
      { method: 'PUT', url: '/api/collaboration/server' },
    ]);
  });

  it('reads the password from stdin without accepting a password argv flag', async () => {
    stub.setResponder((request) => request.url === '/api/collaboration/login'
      ? { status: 200, body: { ...state, session: { sessionId: 's1', user: { id: 'u1', email: 'owner@example.test', displayName: 'Owner' } } } }
      : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'unexpected' } } });

    const result = await runCli([
      'collaboration', 'login',
      '--email', 'owner@example.test',
      '--password-stdin',
      '--device-name', 'Owner Mac',
      '--json',
      '--daemon-url', stub.baseUrl,
    ], 'a-long-secret-password\n');

    expect(result.code).toBe(0);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      email: 'owner@example.test',
      password: 'a-long-secret-password',
      deviceName: 'Owner Mac',
    });

    const unsafe = await runCli([
      'collaboration', 'login', '--email', 'owner@example.test', '--password', 'visible-secret',
    ]);
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain('unknown flag: --password');
  });

  it('logs out and lists collaboration projects through the local daemon', async () => {
    stub.setResponder((request) => {
      if (request.method === 'DELETE' && request.url === '/api/collaboration/session') {
        return { status: 204 };
      }
      if (request.method === 'GET' && request.url === '/api/collaboration/projects') {
        return {
          status: 200,
          body: {
            projects: [{ id: 'p1', name: 'Launch', callerRole: 'owner', status: 'active' }],
          },
        };
      }
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'unexpected' } } };
    });

    const logout = await runCli([
      'collaboration', 'logout', '--json', '--daemon-url', stub.baseUrl,
    ]);
    const projects = await runCli([
      'collaboration', 'projects', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(logout.code).toBe(0);
    expect(JSON.parse(logout.stdout)).toEqual({ ok: true });
    expect(projects.code).toBe(0);
    expect(JSON.parse(projects.stdout)).toEqual({
      projects: [{ id: 'p1', name: 'Launch', callerRole: 'owner', status: 'active' }],
    });
  });

  it('previews and explicitly publishes a Project through the local daemon', async () => {
    const candidate = {
      schemaVersion: 1,
      mode: 'preview-only',
      entrypoint: 'preview/index.html',
      files: [{ path: 'preview/index.html', size: 14, mimeType: 'text/html' }],
      totalBytes: 14,
      fingerprint: 'b'.repeat(64),
    };
    stub.setResponder((request) => {
      if (request.url.endsWith('/publish-candidate')) return { status: 200, body: candidate };
      if (request.url.endsWith('/publish')) {
        return {
          status: 201,
          body: {
            version: { number: 2 },
            desktopDeepLink: 'opendesign://collaboration/review/open?version_id=ver_2',
          },
        };
      }
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'unexpected' } } };
    });

    const preview = await runCli([
      'project', 'collaboration', 'preview', 'local-project-1',
      '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual(candidate);

    const withoutConfirmation = await runCli([
      'project', 'collaboration', 'publish', 'local-project-1',
      '--daemon-url', stub.baseUrl,
    ]);
    expect(withoutConfirmation.code).toBe(2);
    expect(withoutConfirmation.stderr).toContain('requires --confirm');

    const published = await runCli([
      'project', 'collaboration', 'publish', 'local-project-1',
      '--confirm', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(published.code).toBe(0);
    const publishRequest = stub.requests.find(({ url }) => url.endsWith('/publish'));
    expect(JSON.parse(publishRequest!.body)).toEqual({
      candidateFingerprint: candidate.fingerprint,
      confirmedPaths: ['preview/index.html'],
    });
    expect(stub.requests.every(({ url }) => url.startsWith('/api/projects/'))).toBe(true);
  });

  it('lets a local Reviewer Agent inspect comments and submit provenance-tagged feedback', async () => {
    stub.setResponder((request) => {
      if (request.method === 'GET' && request.url.startsWith('/api/collaboration/projects/p1/review-comments')) {
        return { status: 200, body: { comments: [], commentRevision: 0 } };
      }
      if (request.method === 'POST' && request.url.endsWith('/review-comments/batch')) {
        const payload = JSON.parse(request.body);
        return {
          status: 201,
          body: {
            comments: payload.comments.map((comment: Record<string, unknown>, index: number) => ({
              id: `c${index + 1}`,
              projectId: 'p1',
              ...comment,
              authorUserId: 'reviewer-1',
              status: 'open',
              revision: 1,
            })),
          },
        };
      }
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'unexpected' } } };
    });

    const listed = await runCli([
      'review', 'comments', 'p1', '--version', 'v1', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({ comments: [], commentRevision: 0 });

    const input = JSON.stringify([{
      versionId: 'v1',
      target: {
        filePath: 'preview/index.html',
        selectionKind: 'visual',
        position: { x: 0.4, y: 0.2, width: 0, height: 0 },
      },
      note: 'Increase contrast',
      source: 'agent',
      agent: { name: 'Review Bot', model: 'review-model' },
      attachmentIds: [],
    }]);
    const submitted = await runCli([
      'review', 'submit-comments', 'p1', '--input', '-', '--json', '--daemon-url', stub.baseUrl,
    ], input);
    expect(submitted.code).toBe(0);
    expect(JSON.parse(submitted.stdout).comments[0]).toMatchObject({
      source: 'agent',
      agent: { name: 'Review Bot', model: 'review-model' },
    });
    expect(JSON.parse(stub.requests.at(-1)!.body)).toMatchObject({
      comments: [{ source: 'agent', agent: { name: 'Review Bot' } }],
    });
  });

  it('lets the Owner list and attach selected review feedback through the local daemon', async () => {
    stub.setResponder((request) => {
      if (request.method === 'GET' && request.url.includes('/review-comments')) {
        return {
          status: 200,
          body: {
            version: { id: 'v2', number: 2 },
            comments: [{ id: 'c1', status: 'open', source: 'human', note: 'Increase contrast' }],
            commentRevision: 1,
          },
        };
      }
      if (request.method === 'POST' && request.url.endsWith('/preview-comments')) {
        return {
          status: 200,
          body: { comments: [{ id: 'review-local-1', note: 'Increase contrast' }] },
        };
      }
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'unexpected' } } };
    });

    const listed = await runCli([
      'project', 'collaboration', 'comments', 'local-project-1',
      '--version', 'v2', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).comments[0].id).toBe('c1');

    const attached = await runCli([
      'project', 'collaboration', 'attach-comments', 'local-project-1',
      '--conversation', 'conversation-1', '--version', 'v2', '--input', '-',
      '--json', '--daemon-url', stub.baseUrl,
    ], '["c1"]');
    expect(attached.code).toBe(0);
    expect(JSON.parse(attached.stdout).comments[0].id).toBe('review-local-1');
    expect(JSON.parse(stub.requests.at(-1)!.body)).toEqual({
      conversationId: 'conversation-1',
      versionId: 'v2',
      commentIds: ['c1'],
    });
  });
});
