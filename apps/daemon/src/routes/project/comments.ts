import type { Express } from 'express';
import type { PreviewComment } from '@open-design/contracts';
import { projectKindFromMetadataToTrackingOrLegacyDefault } from '@open-design/contracts/analytics';
import type { RouteDeps } from '../../server-context.js';
import { getProject } from '../../db.js';

export interface RegisterProjectCommentRoutesDeps extends RouteDeps<'db' | 'projectStore' | 'conversations'> {
  /** Optional in focused CRUD fixtures; production supplies request-scoped analytics. */
  telemetry?: RouteDeps<'telemetry'>['telemetry'];
}

export function registerProjectCommentRoutes(app: Express, ctx: RegisterProjectCommentRoutesDeps): void {
  const { db } = ctx;
  const { updateProject } = ctx.projectStore;
  const {
    getConversation,
    listPreviewComments,
    upsertPreviewComment,
    getPreviewComment,
    updatePreviewCommentStatus,
    updatePreviewCommentAnchor,
    deletePreviewComment,
    reorderPreviewComment,
  } = ctx.conversations;
  const getRoutableConversation = (projectId: string, conversationId: string) => {
    const conversation = getConversation(db, conversationId);
    return conversation?.projectId === projectId ? conversation : null;
  };

  function getRequestPreviewComment(
    projectId: string,
    conversationId: string,
    commentId: string,
  ): PreviewComment | null {
    return getPreviewComment(db, projectId, conversationId, commentId) as PreviewComment | null;
  }

  // ---- Preview comments ----------------------------------------------------

  app.get('/api/projects/:id/conversations/:cid/comments', async (req, res) => {
    const conv = getRoutableConversation(req.params.id, req.params.cid);
    if (!conv) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({
      comments: listPreviewComments(db, req.params.id, req.params.cid),
    });
  });

  app.post('/api/projects/:id/conversations/:cid/comments', async (req, res) => {
    const conv = getRoutableConversation(req.params.id, req.params.cid);
    if (!conv) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    try {
      // Local preview comments belong to this daemon session. Remote review
      // comments are authored and authorized by Collaboration Server routes,
      // then projected directly into this store with immutable provenance.
      const body = { ...(req.body || {}), reviewSource: undefined };
      const requestedId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
      let existing: PreviewComment | null = null;
      if (requestedId) {
        existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          requestedId,
        );
        if (!existing) {
          return res.status(404).json({ error: 'comment not found' });
        }
        if (existing.reviewSource) {
          return res.status(409).json({
            error: 'collaboration review comments cannot be edited locally',
          });
        }
      }
      const targetConversationId = requestedId
        ? existing?.conversationId ?? req.params.cid
        : req.params.cid;
      const comment = db.transaction(() => {
        const saved = upsertPreviewComment(db, req.params.id, targetConversationId, body);
        updateProject(db, req.params.id, {});
        return saved;
      })();
      // Only a genuinely new, successfully persisted comment is counted.
      // Edits reuse this POST route with an id and must not inflate creation.
      if (comment && !requestedId) {
        const project = getProject(db, req.params.id);
        void ctx.telemetry?.captureProductEvent?.(
          req,
          'project_comment_create_result',
          {
            page_name: 'artifact',
            area: 'comments',
            result: 'success',
            target_project_relation: 'self',
            comment_level: 'top_level',
            project_id: req.params.id,
            project_kind: projectKindFromMetadataToTrackingOrLegacyDefault(project?.metadata),
          },
        );
      }
      res.json({ comment });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        const existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          req.params.commentId,
        );
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = db.transaction(() => {
          const saved = updatePreviewCommentStatus(
            db,
            req.params.id,
            existing.conversationId,
            req.params.commentId,
            req.body?.status,
          );
          if (!saved) return null;
          updateProject(db, req.params.id, {});
          return saved;
        })();
        if (!comment)
          return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId/anchor',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        // Drift-ladder write-back: the client resolves anchor state each render
        // and reports it here. This is a per-daemon DERIVED read-back (each
        // daemon anchors against its own content), not a user edit or a synced
        // field — so it is neither permission-gated nor pushed to the relay, and
        // it does not bump updated_at.
        const existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          req.params.commentId,
        );
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = updatePreviewCommentAnchor(
          db,
          req.params.id,
          existing.conversationId,
          req.params.commentId,
          req.body || {},
        );
        if (!comment) return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId/reorder',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const sortKey = Number(req.body?.sortKey);
      if (!Number.isFinite(sortKey)) {
        return res.status(400).json({ error: 'sortKey must be a finite number' });
      }
      try {
        // Sidebar display order is a per-daemon viewing preference, not a
        // content edit: unlike status change/delete, it is not gated on
        // authorship (any member may reorder their OWN view of a shared
        // project's comments) and does not bump updated_at.
        const existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          req.params.commentId,
        );
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = reorderPreviewComment(
          db,
          req.params.id,
          existing.conversationId,
          req.params.commentId,
          sortKey,
        );
        if (!comment) return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.delete(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const existing = getRequestPreviewComment(
        req.params.id,
        req.params.cid,
        req.params.commentId,
      );
      if (!existing) return res.status(404).json({ error: 'comment not found' });
      let ok = false;
      try {
        ok = db.transaction(() => {
          const deleted = deletePreviewComment(
            db,
            req.params.id,
            existing.conversationId,
            req.params.commentId,
          );
          if (!deleted) return false;
          updateProject(db, req.params.id, {});
          return true;
        })();
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message || err) });
      }
      if (!ok) return res.status(404).json({ error: 'comment not found' });
      res.json({ ok: true });
    },
  );
}
