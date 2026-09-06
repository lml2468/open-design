import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import type {
  CollaborationProject,
  CollaborationProjectList,
  CollaborationServerState,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { Icon } from '../Icon';

const CollaborationReviewDialog = lazy(async () => {
  const module = await import('./CollaborationReviewDialog');
  return { default: module.CollaborationReviewDialog };
});

type PendingAction = 'configure' | 'login' | 'logout' | 'refresh' | null;

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

function projectRoleLabel(
  project: CollaborationProject,
  ownerLabel: string,
  reviewerLabel: string,
): string {
  return project.callerRole === 'owner' ? ownerLabel : reviewerLabel;
}

export function CollaborationServerSettings() {
  const { t } = useI18n();
  const [serverState, setServerState] = useState<CollaborationServerState | null>(null);
  const [projects, setProjects] = useState<CollaborationProject[]>([]);
  const [origin, setOrigin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('OpenDesign Desktop');
  const [pending, setPending] = useState<PendingAction>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewProject, setReviewProject] = useState<CollaborationProject | null>(null);

  const loadProjects = useCallback(async () => {
    const result = await daemonJson<CollaborationProjectList>('/api/collaboration/projects');
    setProjects(result.projects);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const next = await daemonJson<CollaborationServerState>('/api/collaboration/server', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setServerState(next);
        setOrigin(next.profile?.origin ?? '');
        setEmail(next.session?.user.email ?? '');
        if (next.session) {
          const result = await daemonJson<CollaborationProjectList>('/api/collaboration/projects', {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setProjects(result.projects);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const configureServer = async (event: FormEvent) => {
    event.preventDefault();
    setPending('configure');
    setError(null);
    try {
      const next = await daemonJson<CollaborationServerState>('/api/collaboration/server', {
        method: 'PUT',
        body: JSON.stringify({ origin }),
      });
      setServerState(next);
      setOrigin(next.profile?.origin ?? origin);
      if (!next.session) setProjects([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setPending('login');
    setError(null);
    try {
      const next = await daemonJson<CollaborationServerState>('/api/collaboration/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, deviceName }),
      });
      setServerState(next);
      setPassword('');
      await loadProjects();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const logout = async () => {
    setPending('logout');
    setError(null);
    try {
      await daemonJson<null>('/api/collaboration/session', { method: 'DELETE' });
      setServerState((current) => current ? { ...current, session: null } : current);
      setProjects([]);
      setReviewProject(null);
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const refreshProjects = async () => {
    setPending('refresh');
    setError(null);
    try {
      await loadProjects();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  if (loading) {
    return (
      <section className="settings-section collaboration-settings" aria-busy="true">
        <div className="collaboration-settings__loading" role="status">
          <Icon name="spinner" size={16} className="icon-spin" />
          {t('collaboration.state.loading')}
        </div>
      </section>
    );
  }

  const profile = serverState?.profile ?? null;
  const session = serverState?.session ?? null;

  return (
    <section className="settings-section collaboration-settings">
      {error ? <div className="collaboration-settings__error" role="alert">{error}</div> : null}

      <form className="settings-section-card collaboration-settings__card" onSubmit={configureServer}>
        <div className="section-head collaboration-settings__head">
          <div>
            <h3>{t('collaboration.server.title')}</h3>
            <p className="hint">{t('collaboration.server.description')}</p>
          </div>
          <span className={`collaboration-settings__status${profile ? ' is-connected' : ''}`}>
            {profile ? t('collaboration.server.connected') : t('collaboration.server.notConfigured')}
          </span>
        </div>
        <label className="field-label">
          <span>{t('collaboration.server.originLabel')}</span>
          <div className="field-row collaboration-settings__field-action">
            <input
              type="url"
              value={origin}
              placeholder={t('collaboration.server.originPlaceholder')}
              onChange={(event) => setOrigin(event.target.value)}
              required
              disabled={pending !== null}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={pending !== null || !origin.trim()}>
              {pending === 'configure'
                ? t('collaboration.server.configuring')
                : t('collaboration.server.configure')}
            </Button>
          </div>
        </label>
        {profile ? (
          <div className="collaboration-settings__meta">
            <span><Icon name="lock" size={14} />{t('collaboration.server.localAuthority')}</span>
            <span>{t('collaboration.server.checkedAt', { time: new Date(profile.checkedAt).toLocaleString() })}</span>
          </div>
        ) : null}
      </form>

      <form className="settings-section-card collaboration-settings__card" onSubmit={login}>
        <div className="section-head collaboration-settings__head">
          <div>
            <h3>{t('collaboration.session.title')}</h3>
            <p className="hint">{t('collaboration.session.description')}</p>
          </div>
          {session ? (
            <Button type="button" onClick={() => void logout()} disabled={pending !== null}>
              {t('collaboration.session.signOut')}
            </Button>
          ) : null}
        </div>
        {session ? (
          <div className="collaboration-settings__account">
            <span className="collaboration-settings__avatar" aria-hidden>
              {session.user.displayName.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{t('collaboration.session.signedInAs', { name: session.user.displayName })}</strong>
              <span>{session.user.email}</span>
            </div>
          </div>
        ) : (
          <div className="collaboration-settings__login-grid">
            <label className="field-label">
              <span>{t('collaboration.session.email')}</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={!profile || pending !== null}
                required
                autoComplete="username"
              />
            </label>
            <label className="field-label">
              <span>{t('collaboration.session.password')}</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={!profile || pending !== null}
                required
                minLength={12}
                autoComplete="current-password"
              />
            </label>
            <label className="field-label collaboration-settings__device">
              <span>{t('collaboration.session.deviceName')}</span>
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                disabled={!profile || pending !== null}
                required
              />
            </label>
            <Button
              type="submit"
              disabled={!profile || pending !== null || !email.trim() || !password || !deviceName.trim()}
            >
              {pending === 'login'
                ? t('collaboration.session.signingIn')
                : t('collaboration.session.signIn')}
            </Button>
          </div>
        )}
      </form>

      {session ? (
        <div className="settings-section-card collaboration-settings__card">
          <div className="section-head collaboration-settings__head">
            <div>
              <h3>{t('collaboration.projects.title')}</h3>
              <p className="hint">{t('collaboration.projects.description')}</p>
            </div>
            <Button type="button" onClick={() => void refreshProjects()} disabled={pending !== null}>
              <Icon name={pending === 'refresh' ? 'spinner' : 'refresh'} size={14} className={pending === 'refresh' ? 'icon-spin' : undefined} />
              {t('collaboration.projects.refresh')}
            </Button>
          </div>
          {projects.length === 0 ? (
            <div className="collaboration-settings__empty">{t('collaboration.projects.empty')}</div>
          ) : (
            <ul className="collaboration-settings__projects">
              {projects.map((project) => (
                <li key={project.id}>
                  <span className="collaboration-settings__project-icon"><Icon name="folder-2" size={16} /></span>
                  <div>
                    <strong>{project.name}</strong>
                    <span>{project.id}</span>
                  </div>
                  <span className="collaboration-settings__role">
                    {projectRoleLabel(
                      project,
                      t('collaboration.projects.owner'),
                      t('collaboration.projects.reviewer'),
                    )}
                  </span>
                  <Button
                    type="button"
                    disabled={!project.publishedVersionId}
                    onClick={() => setReviewProject(project)}
                  >
                    {project.publishedVersionId
                      ? t('collaboration.projects.openReview')
                      : t('collaboration.projects.notPublished')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {reviewProject && session ? (
        <Suspense fallback={null}>
          <CollaborationReviewDialog
            project={reviewProject}
            session={session}
            onClose={() => setReviewProject(null)}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
