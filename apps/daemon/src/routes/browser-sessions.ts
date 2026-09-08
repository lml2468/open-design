import type { Express } from 'express';
import type { BrowserSessionService } from '../browser-sessions.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterBrowserSessionRoutesDeps extends RouteDeps<'db' | 'http' | 'projectStore'> {
  browserSessions: BrowserSessionService;
}

export function registerBrowserSessionRoutes(app: Express, ctx: RegisterBrowserSessionRoutesDeps): void {
  const { db, browserSessions } = ctx;
  const { getProject } = ctx.projectStore;
  const { sendApiError } = ctx.http;

  app.post('/api/projects/:id/browser-sessions', async (req, res) => {
    if (!getProject(db, req.params.id)) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    try {
      res.json({ browserSession: await browserSessions.create() });
    } catch (error) {
      sendApiError(
        res,
        503,
        'BROWSER_SESSION_START_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.delete('/api/projects/:id/browser-sessions/:sessionId', async (req, res) => {
    if (!getProject(db, req.params.id)) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    }
    res.json({ closed: await browserSessions.close(req.params.sessionId) });
  });
}
