import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import type { TestInfo } from '@playwright/test';

import { e2eWorkspaceRoot } from '../tools-dev/runtime.ts';

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type SelfHostedCollaborationServer = {
  bootstrapToken: string;
  dataDir: string;
  origin: string;
  root: string;
  close: (options?: { preserve?: boolean }) => Promise<void>;
};

export function selfHostedCollaborationServerAvailable(): boolean {
  return requiredServerPaths(resolveServerRepository()).every((path) => existsSync(path));
}

/**
 * Start the real sibling open-design-server implementation for a Playwright
 * workflow. The process owns a fresh SQLite/Blob root and never reuses a
 * developer's configured Server or credentials.
 */
export async function startSelfHostedCollaborationServer(
  testInfo: TestInfo,
): Promise<SelfHostedCollaborationServer> {
  const serverRepository = resolveServerRepository();
  await assertServerRepository(serverRepository);

  const root = testInfo.outputPath('self-hosted-collaboration-server');
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const reservation = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${reservation.port}`;
  const bootstrapToken = randomBytes(32).toString('hex');
  const tokenSecret = randomBytes(32).toString('hex');
  const log = new BoundedLog(MAX_LOG_BYTES);

  await reservation.release();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/server/src/main.ts'],
    {
      cwd: serverRepository,
      env: {
        ...process.env,
        OD_SERVER_HOST: '127.0.0.1',
        OD_SERVER_PORT: String(reservation.port),
        OD_SERVER_PUBLIC_ORIGIN: origin,
        OD_SERVER_DATA_DIR: dataDir,
        OD_SERVER_SCHEMA_PATH: join(serverRepository, 'db', 'schema.sql'),
        OD_SERVER_BOOTSTRAP_TOKEN: bootstrapToken,
        OD_SERVER_TOKEN_SECRET: tokenSecret,
        OD_SERVER_MINIMUM_DESKTOP_VERSION: '0.21.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => log.append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => log.append('stderr', chunk));

  try {
    await waitForReady(origin, child, log);
  } catch (error) {
    await stopChild(child).catch(() => undefined);
    await attachServerDiagnostics(testInfo, log, serverRepository, dataDir);
    throw error;
  }

  let closed = false;
  return {
    bootstrapToken,
    dataDir,
    origin,
    root,
    close: async (options = {}) => {
      if (closed) return;
      closed = true;
      await stopChild(child);
      const preserve = options.preserve === true
        || testInfo.status !== testInfo.expectedStatus;
      if (preserve) {
        await attachServerDiagnostics(testInfo, log, serverRepository, dataDir);
      } else {
        await rm(root, { force: true, recursive: true });
      }
    },
  };
}

async function assertServerRepository(serverRepository: string): Promise<void> {
  const required = requiredServerPaths(serverRepository);
  try {
    await Promise.all(required.map((path) => access(path)));
  } catch {
    throw new Error(
      `OpenDesign Collaboration Server repository is unavailable at ${serverRepository}. `
      + 'Set OD_SELF_HOSTED_SERVER_ROOT to its checkout.',
    );
  }
}

function resolveServerRepository(): string {
  return resolve(
    process.env.OD_SELF_HOSTED_SERVER_ROOT
      ?? join(e2eWorkspaceRoot(), '..', 'open-design-server'),
  );
}

function requiredServerPaths(serverRepository: string): string[] {
  return [
    join(serverRepository, 'package.json'),
    join(serverRepository, 'apps', 'server', 'src', 'main.ts'),
    join(serverRepository, 'db', 'schema.sql'),
  ];
}

async function reserveLoopbackPort(): Promise<{
  port: number;
  release: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('self-hosted collaboration server did not reserve a TCP port');
  }
  return {
    port: address.port,
    release: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

async function waitForReady(
  origin: string,
  child: ChildProcess,
  log: BoundedLog,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(
        `Collaboration Server exited before readiness `
        + `(exit=${String(child.exitCode)}, signal=${String(child.signalCode)}).\n${log.text()}`,
      );
    }
    try {
      const response = await fetch(`${origin}/readyz`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json() as { status?: string };
        if (body.status === 'ready') return;
      }
    } catch {
      // The socket is expected to reject while Fastify and SQLite initialize.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Collaboration Server did not become ready at ${origin}.\n${log.text()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit').then(() => true);
  const timedOut = new Promise<false>((resolveTimeout) => {
    setTimeout(() => resolveTimeout(false), STOP_TIMEOUT_MS).unref();
  });
  if (await Promise.race([exited, timedOut])) return;
  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => undefined);
}

async function attachServerDiagnostics(
  testInfo: TestInfo,
  log: BoundedLog,
  serverRepository: string,
  dataDir: string,
): Promise<void> {
  let dataEntries: string[] = [];
  try {
    const metadata = await stat(join(dataDir, 'metadata.db'));
    dataEntries = [`metadata.db (${metadata.size} bytes)`];
  } catch {
    dataEntries = [];
  }
  await testInfo.attach('self-hosted-collaboration-server-log', {
    body: [
      `repository=${serverRepository}`,
      `dataDir=${dataDir}`,
      ...dataEntries,
      '',
      log.text(),
    ].join('\n'),
    contentType: 'text/plain',
  }).catch(() => undefined);
}

class BoundedLog {
  readonly #maxBytes: number;
  #value = '';

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    this.#value += `[${stream}] ${chunk.toString('utf8')}`;
    if (Buffer.byteLength(this.#value) > this.#maxBytes) {
      this.#value = this.#value.slice(-this.#maxBytes);
    }
  }

  text(): string {
    return this.#value;
  }
}
