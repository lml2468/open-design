import express from 'express';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerTerminalRoutes } from '../src/routes/terminal.js';

describe('local Project terminal routes', () => {
  let server: http.Server;
  let baseUrl = '';
  const session = { id: 'terminal-a', projectId: 'project-a' };
  const terminals = {
    list: vi.fn(() => [session]),
    statusBody: vi.fn((value) => value),
    create: vi.fn(async () => session),
    get: vi.fn(() => session),
    stream: vi.fn((_session, _req, res) => res.end()),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    kill: vi.fn(),
  };
  const resolveProjectDir = vi.fn(() => '/tmp/project-a');

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerTerminalRoutes(app, {
      db: {},
      http: {
        sendApiError: (res: any, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
        createSseResponse: vi.fn(),
      },
      paths: { PROJECTS_DIR: '/tmp/projects' },
      projectStore: {
        getProject: () => ({ id: 'project-a', metadata: null }),
      },
      projectFiles: { resolveProjectDir },
      terminals,
    } as any);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing address');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves terminal operations without legacy Workspace authority', async () => {
    const requests = [
      fetch(`${baseUrl}/api/projects/project-a/terminals`),
      fetch(`${baseUrl}/api/projects/project-a/terminals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      }),
      fetch(`${baseUrl}/api/projects/project-a/terminals/terminal-a/stream`),
      fetch(`${baseUrl}/api/projects/project-a/terminals/terminal-a/stdin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 'whoami\n' }),
      }),
      fetch(`${baseUrl}/api/projects/project-a/terminals/terminal-a/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 100, rows: 40 }),
      }),
      fetch(`${baseUrl}/api/projects/project-a/terminals/terminal-a/kill`, {
        method: 'POST',
      }),
      fetch(`${baseUrl}/api/projects/project-a/terminals/terminal-a`, {
        method: 'DELETE',
      }),
    ];
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: requests.length }, () => 200),
    );
    expect(terminals.list).toHaveBeenCalledTimes(1);
    expect(terminals.create).toHaveBeenCalledTimes(1);
    expect(terminals.stream).toHaveBeenCalledTimes(1);
    expect(terminals.write).toHaveBeenCalledWith(session, 'whoami\n');
    expect(terminals.resize).toHaveBeenCalledWith(session, 100, 40);
    expect(terminals.kill).toHaveBeenCalledTimes(2);
    expect(resolveProjectDir).toHaveBeenCalledWith(
      '/tmp/projects',
      'project-a',
      null,
    );
  });
});
