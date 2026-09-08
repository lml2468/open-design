import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  collaborationDeeplinkAppPath,
  createCollaborationDeeplinkDispatcher,
  findCollaborationDeeplinkArg,
  handleCollaborationDeeplink,
  parseCollaborationDeeplink,
} from '../../src/main/collaboration-deeplink-core.js';

const INVITE = 'opendesign://collaboration/invite/continue?server=https%3A%2F%2Fdesign.example.com&invite_id=inv-1&nonce=abcdefghijklmnopqrstuvwxyz123456';
const REVIEW = 'opendesign://collaboration/review/open?server=http%3A%2F%2F127.0.0.1%3A8787&project_id=prj-1&version_id=ver-2';
const desktopMainSource = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8');
const desktopRuntimeSource = readFileSync(new URL('../../src/main/runtime.ts', import.meta.url), 'utf8');

describe('collaboration deeplink core', () => {
  it('parses invitation and fixed-version review links', () => {
    expect(parseCollaborationDeeplink(INVITE)).toEqual({
      kind: 'invitation',
      serverOrigin: 'https://design.example.com',
      invitationId: 'inv-1',
      token: 'abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(parseCollaborationDeeplink(REVIEW)).toEqual({
      kind: 'review',
      serverOrigin: 'http://127.0.0.1:8787',
      projectId: 'prj-1',
      versionId: 'ver-2',
    });
  });

  it.each([
    'opendesign://workspace/invite/continue?nonce=legacy',
    'opendesign://collaboration/invite/continue?server=http%3A%2F%2Fexample.com&invite_id=i&nonce=abcdefghijklmnopqrstuvwxyz123456',
    'opendesign://collaboration/invite/continue?server=https%3A%2F%2Fexample.com&invite_id=i&nonce=short',
    'opendesign://collaboration/review/open?server=https%3A%2F%2Fexample.com&project_id=p',
  ])('rejects malformed or legacy links: %s', (url) => {
    expect(parseCollaborationDeeplink(url)).toBeNull();
  });

  it('maps a deeplink to the local Settings route without contacting the remote server', async () => {
    const navigate = vi.fn(async (_path: string) => undefined);
    const focus = vi.fn();
    await expect(handleCollaborationDeeplink(INVITE, { navigate, focus })).resolves.toEqual({
      ok: true,
      kind: 'invitation',
    });
    const target = navigate.mock.calls[0]?.[0] ?? '';
    expect(target).toBe(collaborationDeeplinkAppPath(parseCollaborationDeeplink(INVITE)!));
    expect(target).toContain('/settings?collaboration_action=invitation');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('queues cold-start links until the Desktop runtime is ready', () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatcher = createCollaborationDeeplinkDispatcher(handler);
    const deps = { navigate: vi.fn() };
    dispatcher.dispatch(REVIEW);
    expect(dispatcher.pendingCount()).toBe(1);
    dispatcher.setDeps(deps);
    expect(dispatcher.pendingCount()).toBe(0);
    expect(handler).toHaveBeenCalledWith(REVIEW, deps);
  });

  it('finds only opendesign scheme arguments', () => {
    expect(findCollaborationDeeplinkArg(['/app', REVIEW])).toBe(REVIEW);
    expect(findCollaborationDeeplinkArg(['/app', '--flag'])).toBeNull();
  });

  it('keeps invitation secrets out of the observable eval channel', () => {
    const registrationStart = desktopMainSource.indexOf('registerCollaborationDeeplink({');
    const registrationEnd = desktopMainSource.indexOf('\n  });', registrationStart);
    expect(registrationStart).toBeGreaterThanOrEqual(0);
    expect(registrationEnd).toBeGreaterThan(registrationStart);
    const registration = desktopMainSource.slice(registrationStart, registrationEnd);
    expect(registration).toContain('await desktop.navigate(path)');
    expect(registration).not.toContain('.eval(');

    const navigateStart = desktopRuntimeSource.indexOf('async navigate(path)');
    const navigateEnd = desktopRuntimeSource.indexOf('\n    exportArtifact(', navigateStart);
    expect(navigateStart).toBeGreaterThanOrEqual(0);
    expect(navigateEnd).toBeGreaterThan(navigateStart);
    const navigate = desktopRuntimeSource.slice(navigateStart, navigateEnd);
    expect(navigate).toContain('window.webContents.executeJavaScript');
    expect(navigate).not.toContain('summarizeExpression');
    expect(navigate).not.toContain('console.');
  });
});
