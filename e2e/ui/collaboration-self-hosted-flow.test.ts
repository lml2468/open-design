import type { Page, Request, Response } from '@playwright/test';

import {
  dismissPrivacyDialog,
  openSettingsDialog,
  STORAGE_KEY,
  waitForLoadingToClear,
} from '@/playwright/app';
import {
  createCollabCluster,
  type CollabCluster,
} from '@/playwright/collab-cluster';
import { createFakeAgentRuntimes, type FakeAgentRuntime } from '@/playwright/fake-agents';
import {
  selfHostedCollaborationServerAvailable,
  startSelfHostedCollaborationServer,
  type SelfHostedCollaborationServer,
} from '@/playwright/self-hosted-collaboration-server';
import { clusterTest as test, expect } from '@/playwright/suite';
import { T } from '@/timeouts';

const OWNER_EMAIL = 'owner@collaboration.test';
const REVIEWER_EMAIL = 'reviewer@collaboration.test';
const OWNER_PASSWORD = 'owner-password-for-e2e';
const REVIEWER_PASSWORD = 'reviewer-password-for-e2e';
const PROJECT_NAME = 'Self-hosted review flow';
const ARTIFACT_FILE = 'real-daemon-smoke.html';
const HUMAN_COMMENT = 'Make the primary headline more explicit.';
const AGENT_COMMENT = 'Reviewer Agent: strengthen the call to action.';
const EXPERIENCE_SURVEY_RETIRED_KEY = 'open-design:experience-survey:v1:retired';

test.describe.configure({ timeout: T.xlong * 5 });

test('[P0] real self-hosted Server closes the Owner and Reviewer Desktop review loop', async ({
  browser,
}, testInfo) => {
  test.skip(
    !selfHostedCollaborationServerAvailable(),
    'requires the sibling open-design-server checkout or OD_SELF_HOSTED_SERVER_ROOT',
  );
  let server: SelfHostedCollaborationServer | undefined;
  let cluster: CollabCluster | undefined;
  let failed = false;
  try {
    server = await test.step('start a real isolated Collaboration Server', async () =>
      await startSelfHostedCollaborationServer(testInfo));
    const ownerSession = await bootstrapOwner(server);
    const fakeAgents = await createFakeAgentRuntimes({
      root: testInfo.outputPath('fake-agent-runtimes'),
      runtimeIds: ['codex'],
    });

    cluster = await test.step('start two isolated Desktop clients', async () =>
      await createCollabCluster(browser, testInfo, [
        {
          id: 'owner',
          env: fakeAgents.codex.env,
        },
        {
          id: 'reviewer',
          env: fakeAgents.codex.env,
        },
      ]));
    const owner = cluster.clients.owner!;
    const reviewer = cluster.clients.reviewer!;
    expect(owner.runtime.dataDir).not.toBe(reviewer.runtime.dataDir);
    expect(owner.runtime.dataDir).not.toBe(server.dataDir);

    await Promise.all([
      prepareClient(owner.page, fakeAgents.codex),
      prepareClient(reviewer.page, fakeAgents.codex),
    ]);

    await test.step('configure and sign in the Owner through Desktop settings', async () => {
      await configureCollaborationAccount(owner.page, server!.origin, OWNER_EMAIL, OWNER_PASSWORD, 'Owner Desktop');
    });

    const projectId = `self-hosted-${Date.now()}`;
    const { conversationId } = await test.step('create local Project and generate version one with the Owner Agent', async () => {
      const project = await createLocalProject(owner.page, projectId);
      await owner.page.goto(`/projects/${projectId}/conversations/${project.conversationId}`, {
        waitUntil: 'domcontentloaded',
      });
      await waitForLoadingToClear(owner.page);
      await dismissPrivacyDialog(owner.page);
      await sendPrompt(owner.page, 'Create a deterministic smoke artifact');
      await expectProjectFileToContain(owner.page, projectId, ARTIFACT_FILE, 'Real Daemon Smoke');
      return project;
    });
    const ownerProjectUrl = owner.page.url();

    const firstPublish = await test.step('bind and publish immutable version one through the Owner UI', async () =>
      await publishCurrentProject(owner.page, 1));
    const remoteProjectId = firstPublish.remoteProjectId;
    const versionOneId = firstPublish.versionId;

    await test.step('invite and enroll an independent Reviewer identity', async () => {
      const remoteProject = await serverJson<RemoteProject>(
        server!.origin,
        `/api/v1/projects/${encodeURIComponent(remoteProjectId)}`,
        { headers: bearer(ownerSession.accessToken) },
      );
      const invitation = await serverJson<{ desktopDeepLink: string }>(
        server!.origin,
        `/api/v1/projects/${encodeURIComponent(remoteProjectId)}/invitations`,
        {
          method: 'POST',
          headers: {
            ...bearer(ownerSession.accessToken),
            'content-type': 'application/json',
            'idempotency-key': 'self-hosted-reviewer-invite',
            'if-match': `"project-${remoteProject.revision}"`,
          },
          body: JSON.stringify({ email: REVIEWER_EMAIL }),
        },
      );
      const token = new URL(invitation.desktopDeepLink).searchParams.get('nonce');
      expect(token).toBeTruthy();
      await serverJson(
        server!.origin,
        '/api/v1/invitations/accept',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token,
            displayName: 'Riley Reviewer',
            password: REVIEWER_PASSWORD,
            deviceName: 'Reviewer enrollment',
          }),
        },
      );
      await configureCollaborationAccount(
        reviewer.page,
        server!.origin,
        REVIEWER_EMAIL,
        REVIEWER_PASSWORD,
        'Reviewer Desktop',
      );
    });

    await test.step('download the fixed Snapshot and submit a human comment through Desktop', async () => {
      const settings = await collaborationSettings(reviewer.page);
      const row = settings.locator('.collaboration-settings__projects li', { hasText: PROJECT_NAME });
      await expect(row).toContainText('Reviewer');
      await row.getByRole('button', { name: 'Open review' }).click();
      const dialog = reviewer.page.getByRole('dialog', { name: PROJECT_NAME });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.frameLocator('iframe[title="Published Project preview"]').getByRole('heading', {
          name: 'Real Daemon Smoke',
        }),
      ).toBeVisible({ timeout: T.long });
      await dialog.getByRole('button', { name: 'Place comment' }).click();
      await dialog.locator('.collaboration-review-dialog__placement').click({ position: { x: 240, y: 160 } });
      await dialog.getByPlaceholder('Describe what should change…').fill(HUMAN_COMMENT);
      await dialog.getByRole('button', { name: 'Submit comment' }).click();
      await expect(dialog.getByText(HUMAN_COMMENT)).toBeVisible();
      await testInfo.attach('reviewer-fixed-snapshot', {
        body: await reviewer.page.screenshot(),
        contentType: 'image/png',
      });
    });

    const agentComment = await test.step('review and confirm a provenance-bearing Agent comment before upload', async () => {
      const response = await reviewer.page.request.post(
        `/api/collaboration/projects/${encodeURIComponent(remoteProjectId)}/review-comments/batch`,
        {
          data: {
            comments: [{
              versionId: versionOneId,
              target: {
                filePath: `preview/${ARTIFACT_FILE}`,
                selectionKind: 'visual',
                position: { x: 0.55, y: 0.4, width: 0, height: 0 },
              },
              note: AGENT_COMMENT,
              source: 'agent',
              agent: {
                name: 'Reviewer Agent',
                model: 'fake-review-model',
                reviewRunId: 'review-run-e2e-1',
              },
              attachmentIds: [],
            }],
          },
          timeout: T.long,
        },
      );
      expect(response.ok(), await response.text()).toBeTruthy();
      expect(response.status()).toBe(202);
      const body = await response.json() as { batch: { id: string; comments: unknown[] } };
      expect(body.batch.comments).toHaveLength(1);

      const beforeConfirmation = await reviewer.page.request.get(
        `/api/collaboration/projects/${encodeURIComponent(remoteProjectId)}/review-comments?versionId=${encodeURIComponent(versionOneId)}`,
      );
      expect(beforeConfirmation.ok(), await beforeConfirmation.text()).toBeTruthy();
      const commentsBefore = await beforeConfirmation.json() as { comments: Array<{ note: string }> };
      expect(commentsBefore.comments.some(({ note }) => note === AGENT_COMMENT)).toBe(false);

      const dialog = reviewer.page.getByRole('dialog', { name: PROJECT_NAME });
      await dialog.getByRole('button', { name: 'Refresh comments' }).click();
      await expect(dialog.getByText('Agent comments awaiting approval')).toBeVisible();
      await expect(dialog.getByText(AGENT_COMMENT)).toBeVisible();
      await expect(dialog.getByText('Reviewer Agent', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Confirm and submit 1' }).click();
      await expect(dialog.getByText('Agent comments awaiting approval')).not.toBeVisible();
      await expect(dialog.getByText(AGENT_COMMENT)).toBeVisible();

      const afterConfirmation = await reviewer.page.request.get(
        `/api/collaboration/projects/${encodeURIComponent(remoteProjectId)}/review-comments?versionId=${encodeURIComponent(versionOneId)}`,
      );
      expect(afterConfirmation.ok(), await afterConfirmation.text()).toBeTruthy();
      const commentsAfter = await afterConfirmation.json() as {
        comments: Array<{ id: string; note: string }>;
      };
      return commentsAfter.comments.find(({ note }) => note === AGENT_COMMENT)!;
    });
    expect(agentComment.id).toBeTruthy();

    await test.step('attach both comments and let the Owner Agent apply them locally', async () => {
      await owner.page.goto(ownerProjectUrl, { waitUntil: 'domcontentloaded' });
      await waitForLoadingToClear(owner.page);
      const dialog = await openPublishDialog(owner.page);
      await dialog.getByRole('button', { name: 'Load feedback' }).click();
      await expect(dialog.getByText(HUMAN_COMMENT)).toBeVisible();
      await expect(dialog.getByText(AGENT_COMMENT)).toBeVisible();
      await dialog.locator('label', { hasText: HUMAN_COMMENT }).getByRole('checkbox').check();
      await dialog.locator('label', { hasText: AGENT_COMMENT }).getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Attach 2 to Agent' }).click();
      await expect(dialog.getByText('2 review comments are ready in the composer.')).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();

      await sendPrompt(owner.page, 'Apply the attached collaboration review comments');
      await expectProjectFileToContain(
        owner.page,
        projectId,
        ARTIFACT_FILE,
        'Collaboration Feedback Applied',
      );
    });

    const secondPublish = await test.step('publish version two and prove version one stayed immutable', async () => {
      const published = await publishCurrentProject(owner.page, 2);
      const versionsResponse = await reviewer.page.request.get(
        `/api/collaboration/projects/${encodeURIComponent(remoteProjectId)}/versions`,
      );
      expect(versionsResponse.ok(), await versionsResponse.text()).toBeTruthy();
      const versions = await versionsResponse.json() as {
        versions: Array<{ id: string; number: number }>;
      };
      expect(versions.versions.map(({ number }) => number)).toEqual([2, 1]);

      const versionOne = await readSnapshotEntrypoint(reviewer.page, remoteProjectId, versionOneId);
      const versionTwo = await readSnapshotEntrypoint(reviewer.page, remoteProjectId, published.versionId);
      expect(versionOne).toContain('Real Daemon Smoke');
      expect(versionOne).not.toContain('Collaboration Feedback Applied');
      expect(versionTwo).toContain('Collaboration Feedback Applied');
      await testInfo.attach('owner-version-two', {
        body: await owner.page.screenshot(),
        contentType: 'image/png',
      });
      return published;
    });
    expect(secondPublish.versionId).not.toBe(versionOneId);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await cluster?.close({ preserve: failed });
    await server?.close({ preserve: failed });
    if (!failed) {
      await rm(testInfo.outputPath('fake-agent-runtimes'), { force: true, recursive: true });
    }
  }
});

async function prepareClient(page: Page, runtime: FakeAgentRuntime): Promise<void> {
  const config = {
    mode: 'daemon',
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    agentId: 'codex',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    agentModels: { codex: { model: 'default', reasoning: 'default' } },
    agentCliEnv: { codex: runtime.env },
  };
  await page.addInitScript(({ key, retiredKey, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.localStorage.setItem(retiredKey, '1');
  }, { key: STORAGE_KEY, retiredKey: EXPERIENCE_SURVEY_RETIRED_KEY, value: config });
  const response = await page.request.put('/api/app-config', { data: config });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function configureCollaborationAccount(
  page: Page,
  origin: string,
  email: string,
  password: string,
  deviceName: string,
): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const settings = await collaborationSettings(page);
  await settings.getByLabel('Server URL').fill(origin);
  await settings.getByRole('button', { name: 'Connect server' }).click();
  await expect(settings.getByText('Connected', { exact: true })).toBeVisible({ timeout: T.long });
  await settings.getByLabel('Email').fill(email);
  await settings.getByLabel('Password').fill(password);
  await settings.getByLabel('Device name').fill(deviceName);
  await settings.getByRole('button', { name: 'Sign in' }).click();
  await expect(settings.getByText(new RegExp(`Signed in as`))).toBeVisible({ timeout: T.long });
}

async function collaborationSettings(page: Page) {
  const settings = await openSettingsDialog(page);
  await settings.getByTestId('settings-nav-collaboration').click();
  await expect(settings.getByRole('heading', { name: 'Collaboration Server' })).toBeVisible();
  return settings;
}

async function createLocalProject(page: Page, id: string): Promise<{ conversationId: string }> {
  const response = await page.request.post('/api/projects', {
    data: {
      id,
      name: PROJECT_NAME,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<{ conversationId: string }>;
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId('chat-composer-input');
  const send = page.getByTestId('chat-send');
  await expect(input).toBeEditable({ timeout: T.long });
  await input.fill(prompt);
  let requestSent = false;
  const onRequest = (request: Request) => {
    if (new URL(request.url()).pathname === '/api/runs' && request.method() === 'POST') {
      requestSent = true;
    }
  };
  page.on('request', onRequest);
  try {
    const response = await Promise.all([
      page.waitForResponse(isCreateRunResponse, { timeout: T.long }),
      send.click(),
    ]).then(([result]) => result);
    expect(response.ok(), await response.text()).toBeTruthy();
  } catch (error) {
    throw new Error(
      `Owner Agent run did not start (${requestSent ? 'request sent' : 'request not sent'})`,
      { cause: error },
    );
  } finally {
    page.off('request', onRequest);
  }
}

async function publishCurrentProject(
  page: Page,
  expectedVersion: number,
): Promise<{ remoteProjectId: string; versionId: string }> {
  const dialog = await openPublishDialog(page);
  const unbound = dialog.getByRole('button', { name: 'Create collaboration Project' });
  const prepareButton = dialog.getByRole('button', { name: 'Review Publish files' });
  const confirmation = dialog.getByRole('checkbox');
  await expect(async () => {
    if (await unbound.isVisible().catch(() => false)) {
      await expect(unbound).toBeEnabled({ timeout: T.short });
      const bindResponse = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return /\/api\/projects\/[^/]+\/collaboration$/.test(url.pathname)
            && response.request().method() === 'POST';
        }, { timeout: T.short }),
        unbound.click({ timeout: T.short }),
      ]).then(([response]) => response);
      expect(bindResponse.ok(), await bindResponse.text()).toBeTruthy();
    }

    await expect(prepareButton).toBeEnabled({ timeout: T.short });
    const candidateResponse = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/collaboration/publish-candidate')
          && response.request().method() === 'POST';
      }, { timeout: T.short }),
      prepareButton.click({ timeout: T.short }),
    ]).then(([response]) => response);
    expect(candidateResponse.ok(), await candidateResponse.text()).toBeTruthy();
    await expect(confirmation).toBeVisible({ timeout: T.short });
  }).toPass({ timeout: T.long });
  await confirmation.check();
  const publishButton = dialog.getByRole('button', { name: 'Publish version' });
  await expect(publishButton).toBeEnabled({ timeout: T.long });
  let requestSent = false;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/collaboration/publish') && request.method() === 'POST') {
      requestSent = true;
    }
  };
  page.on('request', onRequest);
  const isPublishResponse = (response: Response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/collaboration/publish')
      && response.request().method() === 'POST';
  };
  let response: Response | undefined;
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 3 && !response; attempt += 1) {
      requestSent = false;
      try {
        await expect(publishButton).toBeEnabled({ timeout: T.short });
        response = await Promise.all([
          page.waitForResponse(isPublishResponse, { timeout: T.short }),
          publishButton.click({ timeout: T.short }),
        ]).then(([result]) => result);
      } catch (error) {
        lastError = error;
        if (requestSent) {
          throw new Error('Publish request was sent but no response arrived', { cause: error });
        }
      }
    }
  } finally {
    page.off('request', onRequest);
  }
  if (!response) {
    throw new Error(
      'Publish did not complete (request not sent after 3 actionable clicks)',
      { cause: lastError },
    );
  }
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as {
    binding: { remoteProjectId: string };
    version: { id: string; number: number };
  };
  expect(body.version.number).toBe(expectedVersion);
  await expect(dialog.getByText(`Version ${expectedVersion} published`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  return { remoteProjectId: body.binding.remoteProjectId, versionId: body.version.id };
}

async function openPublishDialog(page: Page) {
  await page.getByRole('button', { name: 'Publish for team review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish this Project' });
  await expect(dialog).toBeVisible({ timeout: T.long });
  return dialog;
}

async function expectProjectFileToContain(
  page: Page,
  projectId: string,
  fileName: string,
  expected: string,
): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${projectId}/files/${fileName}`);
    return response.ok() ? response.text() : '';
  }, { timeout: T.long }).toContain(expected);
}

async function readSnapshotEntrypoint(
  page: Page,
  remoteProjectId: string,
  versionId: string,
): Promise<string> {
  const snapshotResponse = await page.request.post(
    `/api/collaboration/projects/${encodeURIComponent(remoteProjectId)}/review-snapshot`,
    { data: { versionId }, timeout: T.long },
  );
  expect(snapshotResponse.ok(), await snapshotResponse.text()).toBeTruthy();
  const snapshot = await snapshotResponse.json() as { entrypointUrl: string };
  const fileResponse = await page.request.get(snapshot.entrypointUrl);
  expect(fileResponse.ok(), await fileResponse.text()).toBeTruthy();
  return fileResponse.text();
}

async function bootstrapOwner(server: SelfHostedCollaborationServer): Promise<AuthSession> {
  return serverJson<AuthSession>(server.origin, '/api/v1/bootstrap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bootstrap-token': server.bootstrapToken,
    },
    body: JSON.stringify({
      email: OWNER_EMAIL,
      displayName: 'Olivia Owner',
      password: OWNER_PASSWORD,
      deviceName: 'E2E bootstrap',
    }),
  });
}

async function serverJson<T = unknown>(
  origin: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) as T : undefined as T;
}

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

function isCreateRunResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.pathname === '/api/runs' && response.request().method() === 'POST';
}

type AuthSession = {
  accessToken: string;
};

type RemoteProject = {
  revision: number;
};
import { rm } from 'node:fs/promises';
