import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@open-design/components';
import type {
  CollaborationProjectBindingState,
  CollaborationPublishCandidate,
  CollaborationPublishResult,
  PreviewComment,
  ProjectCollaborationCommentProjectionResult,
  ProjectCollaborationReviewComments,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';

type PendingAction = 'load' | 'bind' | 'candidate' | 'publish' | 'feedback' | 'attach-feedback' | 'unbind' | null;

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
    const message = typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function ProjectCollaborationPublish({
  projectId,
  conversationId,
  disabled = false,
  onOpenSettings,
  onAttachReviewComments,
}: {
  projectId: string;
  conversationId?: string | null;
  disabled?: boolean;
  onOpenSettings: () => void;
  onAttachReviewComments?: (comments: PreviewComment[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CollaborationProjectBindingState | null>(null);
  const [candidate, setCandidate] = useState<CollaborationPublishCandidate | null>(null);
  const [result, setResult] = useState<CollaborationPublishResult | null>(null);
  const [feedback, setFeedback] = useState<ProjectCollaborationReviewComments | null>(null);
  const [selectedFeedbackIds, setSelectedFeedbackIds] = useState<Set<string>>(() => new Set());
  const [attachedFeedbackCount, setAttachedFeedbackCount] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const route = `/api/projects/${encodeURIComponent(projectId)}/collaboration`;

  const loadState = useCallback(async () => {
    setPending('load');
    setError(null);
    try {
      setState(await daemonJson<CollaborationProjectBindingState>(route));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }, [route]);

  useEffect(() => {
    if (!open) return;
    setCandidate(null);
    setResult(null);
    setFeedback(null);
    setSelectedFeedbackIds(new Set());
    setAttachedFeedbackCount(0);
    setConfirmed(false);
    setConfirmUnbind(false);
    void loadState();
  }, [loadState, open]);

  const bindProject = async () => {
    setPending('bind');
    setError(null);
    try {
      const next = await daemonJson<CollaborationProjectBindingState>(route, {
        method: 'POST',
        body: JSON.stringify({ mode: 'create' }),
      });
      setState(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const prepareCandidate = async () => {
    setPending('candidate');
    setError(null);
    setResult(null);
    setConfirmed(false);
    try {
      setCandidate(await daemonJson<CollaborationPublishCandidate>(`${route}/publish-candidate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const publish = async () => {
    if (!candidate || !confirmed) return;
    setPending('publish');
    setError(null);
    try {
      const published = await daemonJson<CollaborationPublishResult>(`${route}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          candidateFingerprint: candidate.fingerprint,
          confirmedPaths: candidate.files.map((file) => file.path),
          entrypoint: candidate.entrypoint,
        }),
      });
      setResult(published);
      setState({ localProjectId: projectId, binding: published.binding });
      setCandidate(null);
      setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const loadFeedback = async () => {
    setPending('feedback');
    setError(null);
    try {
      const next = await daemonJson<ProjectCollaborationReviewComments>(`${route}/review-comments`);
      setFeedback(next);
      setSelectedFeedbackIds(new Set());
      setAttachedFeedbackCount(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const attachFeedback = async () => {
    if (!conversationId || !feedback || selectedFeedbackIds.size === 0) return;
    setPending('attach-feedback');
    setError(null);
    try {
      const projected = await daemonJson<ProjectCollaborationCommentProjectionResult>(
        `${route}/preview-comments`,
        {
          method: 'POST',
          body: JSON.stringify({
            conversationId,
            versionId: feedback.version.id,
            commentIds: Array.from(selectedFeedbackIds),
          }),
        },
      );
      onAttachReviewComments?.(projected.comments);
      setAttachedFeedbackCount(projected.comments.length);
      setSelectedFeedbackIds(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const unbind = async () => {
    setPending('unbind');
    setError(null);
    try {
      await daemonJson<null>(route, { method: 'DELETE' });
      setState({ localProjectId: projectId, binding: null });
      setCandidate(null);
      setResult(null);
      setConfirmUnbind(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <button
        type="button"
        className="project-collaboration-trigger od-tooltip"
        aria-label={t('collaboration.publish.open')}
        data-tooltip={t('collaboration.publish.open')}
        data-tooltip-placement="bottom"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Icon name="upload" size={15} />
      </button>

      {open ? createPortal((
        <div
          className="project-collaboration-modal"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && pending === null) setOpen(false);
          }}
        >
          <section
            className="project-collaboration-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-collaboration-title"
          >
            <header className="project-collaboration-dialog__header">
              <div>
                <span className="project-collaboration-dialog__eyebrow">
                  {t('collaboration.publish.eyebrow')}
                </span>
                <h2 id="project-collaboration-title">{t('collaboration.publish.title')}</h2>
              </div>
              <button
                type="button"
                className="project-collaboration-dialog__close"
                aria-label={t('common.close')}
                disabled={pending !== null}
                onClick={() => setOpen(false)}
              >
                <Icon name="close" size={18} />
              </button>
            </header>

            {error ? (
              <div className="project-collaboration-dialog__error" role="alert">
                <Icon name="alert-triangle" size={16} />
                <span>{error}</span>
              </div>
            ) : null}

            {pending === 'load' && !state ? (
              <div className="project-collaboration-dialog__loading" role="status">
                <Icon name="spinner" size={16} className="icon-spin" />
                {t('collaboration.state.loading')}
              </div>
            ) : null}

            {state && !state.binding ? (
              <div className="project-collaboration-dialog__empty">
                <div className="project-collaboration-dialog__symbol"><Icon name="link" size={20} /></div>
                <h3>{t('collaboration.publish.notBound')}</h3>
                <p>{t('collaboration.publish.notBoundDescription')}</p>
                <div className="project-collaboration-dialog__actions">
                  <Button type="button" variant="primary" onClick={() => void bindProject()} disabled={pending !== null}>
                    {pending === 'bind'
                      ? t('collaboration.publish.binding')
                      : t('collaboration.publish.createBinding')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setOpen(false);
                      onOpenSettings();
                    }}
                    disabled={pending !== null}
                  >
                    {t('collaboration.publish.openSettings')}
                  </Button>
                </div>
              </div>
            ) : null}

            {state?.binding ? (
              <>
                <div className="project-collaboration-dialog__binding">
                  <div>
                    <span>{t('collaboration.publish.remoteProject')}</span>
                    <strong>{state.binding.remoteProjectId}</strong>
                  </div>
                  <div>
                    <span>{t('collaboration.publish.remoteRevision')}</span>
                    <strong>{state.binding.remoteRevision}</strong>
                  </div>
                  <div>
                    <span>{t('collaboration.publish.lastVersion')}</span>
                    <strong>{state.binding.lastPublishedVersionNumber ?? '—'}</strong>
                  </div>
                </div>

                {state.binding.publishedVersionId ? (
                  <section className="project-collaboration-dialog__feedback">
                    <div className="project-collaboration-dialog__feedback-head">
                      <div>
                        <strong>{t('collaboration.publish.feedbackTitle')}</strong>
                        <span>{t('collaboration.publish.feedbackDescription')}</span>
                      </div>
                      <Button type="button" variant="ghost" onClick={() => void loadFeedback()} disabled={pending !== null}>
                        <Icon name={pending === 'feedback' ? 'spinner' : 'refresh'} size={14} className={pending === 'feedback' ? 'icon-spin' : undefined} />
                        {t('collaboration.publish.loadFeedback')}
                      </Button>
                    </div>
                    {feedback ? (
                      <>
                        <div className="project-collaboration-dialog__feedback-list">
                          {feedback.comments.filter((comment) => comment.status === 'open' || comment.status === 'reopened').length === 0 ? (
                            <span>{t('collaboration.publish.noFeedback')}</span>
                          ) : feedback.comments
                            .filter((comment) => comment.status === 'open' || comment.status === 'reopened')
                            .map((comment) => (
                              <label key={comment.id}>
                                <input
                                  type="checkbox"
                                  checked={selectedFeedbackIds.has(comment.id)}
                                  disabled={pending !== null}
                                  onChange={() => setSelectedFeedbackIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(comment.id)) next.delete(comment.id);
                                    else next.add(comment.id);
                                    return next;
                                  })}
                                />
                                <span>
                                  <strong>{comment.source === 'agent'
                                    ? comment.agent?.name ?? t('collaboration.review.agent')
                                    : t('collaboration.review.reviewer')}</strong>
                                  {comment.note}
                                </span>
                              </label>
                            ))}
                        </div>
                        <Button
                          type="button"
                          variant="primary"
                          onClick={() => void attachFeedback()}
                          disabled={!conversationId || selectedFeedbackIds.size === 0 || pending !== null}
                        >
                          {pending === 'attach-feedback'
                            ? t('collaboration.publish.attachingFeedback')
                            : t('collaboration.publish.attachFeedback', { count: selectedFeedbackIds.size })}
                        </Button>
                        {attachedFeedbackCount > 0 ? (
                          <span className="project-collaboration-dialog__feedback-attached" role="status">
                            {t('collaboration.publish.feedbackAttached', { count: attachedFeedbackCount })}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </section>
                ) : null}

                {result ? (
                  <div className="project-collaboration-dialog__success" role="status">
                    <Icon name="check" size={18} />
                    <div>
                      <strong>{t('collaboration.publish.success', { version: result.version.number })}</strong>
                      <a href={result.desktopDeepLink}>{t('collaboration.publish.openReview')}</a>
                    </div>
                  </div>
                ) : null}

                {!candidate ? (
                  <div className="project-collaboration-dialog__prepare">
                    <p>{t('collaboration.publish.description')}</p>
                    <Button type="button" variant="primary" onClick={() => void prepareCandidate()} disabled={pending !== null}>
                      {pending === 'candidate'
                        ? t('collaboration.publish.preparing')
                        : t('collaboration.publish.prepare')}
                    </Button>
                  </div>
                ) : (
                  <div className="project-collaboration-dialog__candidate">
                    <div className="project-collaboration-dialog__candidate-summary">
                      <div>
                        <span>{t('collaboration.publish.entrypoint')}</span>
                        <strong>{candidate.entrypoint}</strong>
                      </div>
                      <span>{t('collaboration.publish.fileSummary', {
                        count: candidate.files.length,
                        size: formatBytes(candidate.totalBytes),
                      })}</span>
                    </div>
                    <div className="project-collaboration-dialog__files" role="list">
                      {candidate.files.map((file) => (
                        <div key={file.path} className="project-collaboration-dialog__file" role="listitem">
                          <Icon name="file" size={14} />
                          <span>{file.path}</span>
                          <small>{formatBytes(file.size)}</small>
                        </div>
                      ))}
                    </div>
                    <label className="project-collaboration-dialog__confirm">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={pending !== null}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      <span>{t('collaboration.publish.confirmFiles')}</span>
                    </label>
                    <div className="project-collaboration-dialog__actions">
                      <Button
                        type="button"
                        variant="primary"
                        onClick={() => void publish()}
                        disabled={!confirmed || pending !== null}
                      >
                        {pending === 'publish'
                          ? t('collaboration.publish.publishing')
                          : t('collaboration.publish.publish')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setCandidate(null)}
                        disabled={pending !== null}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}

                <footer className="project-collaboration-dialog__footer">
                  {confirmUnbind ? (
                    <>
                      <span>{t('collaboration.publish.unbindConfirm')}</span>
                      <Button type="button" variant="ghost" onClick={() => void unbind()} disabled={pending !== null}>
                        {t('collaboration.publish.unbind')}
                      </Button>
                      <button type="button" onClick={() => setConfirmUnbind(false)} disabled={pending !== null}>
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmUnbind(true)} disabled={pending !== null}>
                      {t('collaboration.publish.unbind')}
                    </button>
                  )}
                </footer>
              </>
            ) : null}
          </section>
        </div>
      ), document.body) : null}
    </>
  );
}
