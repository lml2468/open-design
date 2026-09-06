import { useCallback, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@open-design/components';
import type {
  CollaborationProject,
  CollaborationReviewComment,
  CollaborationReviewComments,
  CollaborationReviewSnapshot,
  CollaborationReviewVersion,
  CollaborationReviewVersionList,
  CollaborationSessionSummary,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';

type PendingAction = 'snapshot' | 'comments' | 'submit' | 'transition' | null;

async function daemonJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body
      ? { 'content-type': 'application/json', ...init.headers }
      : init?.headers,
  });
  const payload = response.status === 204
    ? null
    : await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = payload && typeof payload === 'object'
      ? (payload as { error?: { message?: unknown } | string }).error
      : null;
    throw new Error(
      typeof error === 'string'
        ? error
        : typeof error?.message === 'string'
          ? error.message
          : `Request failed (${response.status})`,
    );
  }
  return payload as T;
}

export function CollaborationReviewDialog({
  project,
  session,
  onClose,
}: {
  project: CollaborationProject;
  session: CollaborationSessionSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [versions, setVersions] = useState<CollaborationReviewVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState(project.publishedVersionId ?? '');
  const [snapshot, setSnapshot] = useState<CollaborationReviewSnapshot | null>(null);
  const [comments, setComments] = useState<CollaborationReviewComment[]>([]);
  const [commentRevision, setCommentRevision] = useState(0);
  const [note, setNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [pending, setPending] = useState<PendingAction>('snapshot');
  const [error, setError] = useState<string | null>(null);

  const route = `/api/collaboration/projects/${encodeURIComponent(project.id)}`;

  const loadComments = useCallback(async (versionId: string) => {
    setPending('comments');
    try {
      const query = new URLSearchParams({ versionId });
      const result = await daemonJson<CollaborationReviewComments>(
        `${route}/review-comments?${query}`,
      );
      setComments(result.comments);
      setCommentRevision(result.commentRevision);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }, [route]);

  const loadSnapshot = useCallback(async (versionId?: string) => {
    setPending('snapshot');
    setError(null);
    setSnapshot(null);
    setComments([]);
    setPoint(null);
    setPlacing(false);
    try {
      const next = await daemonJson<CollaborationReviewSnapshot>(
        `${route}/review-snapshot`,
        {
          method: 'POST',
          body: JSON.stringify(versionId ? { versionId } : {}),
        },
      );
      setSnapshot(next);
      setSelectedVersionId(next.version.id);
      await loadComments(next.version.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(null);
    }
  }, [loadComments, route]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await daemonJson<CollaborationReviewVersionList>(`${route}/versions`);
        if (cancelled) return;
        setVersions(result.versions);
        const initial = project.publishedVersionId
          ?? result.versions[0]?.id;
        if (initial) await loadSnapshot(initial);
        else {
          setPending(null);
          setError(t('collaboration.review.noPublishedVersion'));
        }
      } catch (cause) {
        if (!cancelled) {
          setPending(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [loadSnapshot, project.publishedVersionId, route, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const versionNumbers = useMemo(
    () => new Map(versions.map((version) => [version.id, version.number])),
    [versions],
  );

  const placePoint = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPoint({
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
    setPlacing(false);
  };

  const submitComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!snapshot || !point || !note.trim()) return;
    setPending('submit');
    setError(null);
    try {
      const created = await daemonJson<CollaborationReviewComment>(
        `${route}/review-comments`,
        {
          method: 'POST',
          body: JSON.stringify({
            versionId: snapshot.version.id,
            target: {
              filePath: snapshot.manifest.entrypoint,
              selectionKind: 'visual',
              label: t('collaboration.review.visualPoint'),
              position: { x: point.x, y: point.y, width: 0, height: 0 },
            },
            note: note.trim(),
            source: 'human',
            attachmentIds: [],
          }),
        },
      );
      setComments((current) => [...current, created]);
      setNote('');
      setPoint(null);
      setCommentRevision((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const transitionComment = async (
    comment: CollaborationReviewComment,
    status: 'addressed' | 'resolved' | 'reopened',
  ) => {
    setPending('transition');
    setError(null);
    try {
      const updated = await daemonJson<CollaborationReviewComment>(
        `${route}/review-comments/${encodeURIComponent(comment.id)}/status`,
        {
          method: 'POST',
          body: JSON.stringify({
            status,
            expectedRevision: comment.revision,
            ...(status === 'addressed' && project.publishedVersionId
              ? { addressedInVersionId: project.publishedVersionId }
              : {}),
          }),
        },
      );
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      setCommentRevision((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const publishedNumber = project.publishedVersionId
    ? versionNumbers.get(project.publishedVersionId)
    : undefined;

  return createPortal(
    <div className="collaboration-review-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="collaboration-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-review-title"
      >
        <header className="collaboration-review-dialog__header">
          <div>
            <span>{t('collaboration.review.eyebrow')}</span>
            <h2 id="collaboration-review-title">{project.name}</h2>
          </div>
          <div className="collaboration-review-dialog__header-actions">
            <label>
              <span>{t('collaboration.review.version')}</span>
              <select
                value={selectedVersionId}
                disabled={pending === 'snapshot'}
                onChange={(event) => void loadSnapshot(event.target.value)}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.number}{version.id === project.publishedVersionId
                      ? ` · ${t('collaboration.review.published')}`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={onClose} aria-label={t('common.close')}>
              <Icon name="close" size={18} />
            </button>
          </div>
        </header>

        {error ? <div className="collaboration-review-dialog__error" role="alert">{error}</div> : null}

        <div className="collaboration-review-dialog__body">
          <div className="collaboration-review-dialog__canvas-column">
            <div className="collaboration-review-dialog__toolbar">
              <div>
                <Icon name="lock" size={14} />
                {t('collaboration.review.immutable', { revision: commentRevision })}
              </div>
              <Button
                type="button"
                onClick={() => setPlacing((current) => !current)}
                disabled={!snapshot || pending === 'snapshot'}
              >
                <Icon name="plus" size={14} />
                {placing
                  ? t('collaboration.review.cancelPlacement')
                  : t('collaboration.review.placeComment')}
              </Button>
            </div>
            <div className="collaboration-review-dialog__canvas">
              {snapshot ? (
                <>
                  <iframe
                    key={snapshot.snapshotId}
                    src={snapshot.entrypointUrl}
                    title={t('collaboration.review.previewTitle')}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                  />
                  <div className="collaboration-review-dialog__markers" aria-hidden>
                    {comments
                      .filter((comment) => comment.target.filePath === snapshot.manifest.entrypoint)
                      .map((comment, index) => (
                        <span
                          key={comment.id}
                          className={`collaboration-review-dialog__marker is-${comment.status}`}
                          style={{
                            left: `${comment.target.position.x * 100}%`,
                            top: `${comment.target.position.y * 100}%`,
                          }}
                        >
                          {index + 1}
                        </span>
                      ))}
                    {point ? (
                      <span
                        className="collaboration-review-dialog__marker is-draft"
                        style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                      >
                        +
                      </span>
                    ) : null}
                  </div>
                  {placing ? (
                    <div
                      className="collaboration-review-dialog__placement"
                      role="button"
                      tabIndex={0}
                      aria-label={t('collaboration.review.placeInstruction')}
                      onClick={placePoint}
                    />
                  ) : null}
                </>
              ) : (
                <div className="collaboration-review-dialog__loading" role="status">
                  <Icon name="spinner" size={20} className="icon-spin" />
                  {t('collaboration.review.loadingSnapshot')}
                </div>
              )}
            </div>
          </div>

          <aside className="collaboration-review-dialog__comments">
            <div className="collaboration-review-dialog__comments-head">
              <div>
                <h3>{t('collaboration.review.comments')}</h3>
                <span>{t('collaboration.review.commentCount', { count: comments.length })}</span>
              </div>
              <button
                type="button"
                aria-label={t('collaboration.review.refreshComments')}
                disabled={!snapshot || pending === 'comments'}
                onClick={() => snapshot && void loadComments(snapshot.version.id)}
              >
                <Icon name={pending === 'comments' ? 'spinner' : 'refresh'} size={15} className={pending === 'comments' ? 'icon-spin' : undefined} />
              </button>
            </div>

            <form className="collaboration-review-dialog__composer" onSubmit={submitComment}>
              <p>{point
                ? t('collaboration.review.pointSelected')
                : t('collaboration.review.selectPointFirst')}</p>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t('collaboration.review.commentPlaceholder')}
                maxLength={10_000}
                rows={3}
              />
              <Button
                type="submit"
                disabled={!snapshot || !point || !note.trim() || pending === 'submit'}
              >
                {pending === 'submit'
                  ? t('collaboration.review.submitting')
                  : t('collaboration.review.submit')}
              </Button>
            </form>

            <div className="collaboration-review-dialog__comment-list">
              {comments.length === 0 ? (
                <div className="collaboration-review-dialog__empty">
                  {t('collaboration.review.noComments')}
                </div>
              ) : comments.map((comment, index) => {
                const isAuthor = comment.authorUserId === session.user.id;
                const commentVersionNumber = versionNumbers.get(comment.versionId);
                const canAddress = project.callerRole === 'owner'
                  && (comment.status === 'open' || comment.status === 'reopened')
                  && publishedNumber !== undefined
                  && commentVersionNumber !== undefined
                  && publishedNumber > commentVersionNumber;
                const canResolve = isAuthor && comment.status === 'addressed';
                const canReopen = isAuthor
                  && (comment.status === 'addressed' || comment.status === 'resolved');
                return (
                  <article key={comment.id} className="collaboration-review-dialog__comment">
                    <div className="collaboration-review-dialog__comment-meta">
                      <span>{index + 1}</span>
                      <strong>{comment.source === 'agent'
                        ? comment.agent?.name ?? t('collaboration.review.agent')
                        : isAuthor
                          ? session.user.displayName
                          : t('collaboration.review.reviewer')}</strong>
                      <small>{comment.status}</small>
                    </div>
                    <p>{comment.note}</p>
                    {comment.source === 'agent' && comment.agent?.model ? (
                      <small>{comment.agent.model}</small>
                    ) : null}
                    {canAddress || canResolve || canReopen ? (
                      <div className="collaboration-review-dialog__comment-actions">
                        {canAddress ? (
                          <button type="button" onClick={() => void transitionComment(comment, 'addressed')}>
                            {t('collaboration.review.markAddressed')}
                          </button>
                        ) : null}
                        {canResolve ? (
                          <button type="button" onClick={() => void transitionComment(comment, 'resolved')}>
                            {t('collaboration.review.resolve')}
                          </button>
                        ) : null}
                        {canReopen ? (
                          <button type="button" onClick={() => void transitionComment(comment, 'reopened')}>
                            {t('collaboration.review.reopen')}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  );
}
