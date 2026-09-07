import type { Page } from '@playwright/test';

import {
  createProjectViaApi,
  gotoProject,
  putAppConfig,
  seedBrowserConfig,
} from '@/playwright/app';
import { runErrorCard } from '@/playwright/chat';
import { routeAgents, suppressWhatsNew } from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

const CODEX_AGENT = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: 'test',
  models: [{ id: 'default', label: 'Default' }],
};

const CLAUDE_AGENT = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: 'test',
  models: [{ id: 'default', label: 'Default' }],
};

const ANTIGRAVITY_AGENT = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'antigravity',
  available: true,
  version: 'test',
  models: [{ id: 'default', label: 'Default' }],
};

test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await suppressWhatsNew(page);
  await stubCatalogsEmpty(page);
  await routeAgents(page, [CODEX_AGENT, CLAUDE_AGENT, ANTIGRAVITY_AGENT]);
});

test('[P0] @critical upstream outages keep Retry available', async ({ page }) => {
  const config = runtimeConfig('claude');
  await seedBrowserConfig(page, config);
  await putAppConfig(page, config);

  const projectId = projectIdFor('upstream-ui');
  const { conversationId } = await createProjectViaApi(
    page,
    projectId,
    'Upstream outage recovery',
  );
  await seedFailedRun(page, {
    projectId,
    conversationId,
    agentId: 'claude',
    detail: 'The model provider is temporarily unavailable.',
    code: 'UPSTREAM_UNAVAILABLE',
  });

  await gotoProject(page, projectId);

  await expect(
    page.getByRole('button', { name: /^Retry$|^重试$|^重試$/i }).first(),
  ).toBeVisible({ timeout: T.long });
  await expect(
    page
      .getByText(/Generation service unavailable|model provider is temporarily unavailable/i)
      .first(),
  ).toBeVisible();
  await expect(page.getByText(/Model call failed/i)).toHaveCount(0);
});

test('[P1] zh-CN run failure guidance shows actionable copy and expandable raw source', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('open-design:locale', 'zh-CN');
    window.localStorage.setItem('open-design:locale-source', 'manual');
  });
  const config = runtimeConfig('codex');
  await seedBrowserConfig(page, config);
  await putAppConfig(page, config);

  const projectId = projectIdFor('prompt-too-large-ui');
  const { conversationId } = await createProjectViaApi(
    page,
    projectId,
    'Prompt too large guidance',
  );
  const rawDetail = 'context window exceeded: estimated 250000 tokens for this run.';
  await seedFailedRun(page, {
    projectId,
    conversationId,
    agentId: 'codex',
    agentName: 'Codex CLI',
    detail: rawDetail,
    code: 'AGENT_PROMPT_TOO_LARGE',
  });

  await gotoProject(page, projectId);

  const card = runErrorCard(page);
  await expect(card).toContainText('内容过长', { timeout: T.long });
  await expect(card).toContainText('本轮输入超出了模型的上下文上限');
  await expect(page.getByRole('button', { name: /^重试$/ }).first()).toBeVisible();

  const sourceToggle = card.getByRole('button', { name: /查看详情/ });
  await expect(sourceToggle).toHaveAttribute('aria-expanded', 'false');
  await sourceToggle.click();
  await expect(sourceToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.run-error__diagnostic')).toContainText(rawDetail);
});

test('[P0] Antigravity rate limits offer terminal model switching', async ({ page }) => {
  let oauthLaunchCalls = 0;
  await page.route('**/api/agents/antigravity/oauth-launch', async (route) => {
    oauthLaunchCalls += 1;
    await route.fulfill({ json: { ok: true } });
  });

  const config = runtimeConfig('antigravity');
  await seedBrowserConfig(page, config);
  await putAppConfig(page, config);

  const projectId = projectIdFor('antigravity-ui');
  const { conversationId } = await createProjectViaApi(
    page,
    projectId,
    'Antigravity rate limit recovery',
  );
  await seedFailedRun(page, {
    projectId,
    conversationId,
    agentId: 'antigravity',
    detail: 'Switch to another Antigravity model before retrying this run.',
    code: 'RATE_LIMITED',
  });

  await gotoProject(page, projectId);

  const launchTerminal = page.getByRole('button', { name: /Switch model in terminal/i }).first();
  await expect(launchTerminal).toBeVisible({ timeout: T.long });
  await expect(
    page.getByRole('button', { name: /^Retry$|^重试$|^重試$/i }).first(),
  ).toBeVisible();
  await launchTerminal.click();
  await expect.poll(() => oauthLaunchCalls).toBe(1);
});

function runtimeConfig(agentId: 'antigravity' | 'claude' | 'codex') {
  return {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId,
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    privacyDecisionAt: 1,
    mediaProviders: {},
    agentModels: {
      [agentId]: { model: 'default', reasoning: 'default' },
    },
  };
}

function projectIdFor(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    .replace(/[^A-Za-z0-9._-]/g, '-');
}

async function stubCatalogsEmpty(page: Page) {
  await page.route('**/api/skills', async (route) => {
    await route.fulfill({ json: { skills: [] } });
  });
  await page.route('**/api/design-templates', async (route) => {
    await route.fulfill({ json: { designTemplates: [] } });
  });
  await page.route('**/api/design-systems', async (route) => {
    await route.fulfill({ json: { designSystems: [] } });
  });
}

async function seedFailedRun(
  page: Page,
  input: {
    projectId: string;
    conversationId: string;
    agentId: string;
    agentName?: string;
    detail: string;
    code: string;
  },
) {
  const userMessage = await page.request.put(
    `/api/projects/${input.projectId}/conversations/${input.conversationId}/messages/u-${input.projectId}`,
    {
      data: {
        role: 'user',
        content: 'please recover this failed run',
        createdAt: Date.now() - 2_000,
      },
    },
  );
  expect(userMessage.ok(), `upsert user message: ${await userMessage.text()}`).toBeTruthy();

  const assistantMessage = await page.request.put(
    `/api/projects/${input.projectId}/conversations/${input.conversationId}/messages/a-${input.projectId}`,
    {
      data: {
        role: 'assistant',
        content: '',
        agentId: input.agentId,
        ...(input.agentName ? { agentName: input.agentName } : {}),
        runId: `run-${input.projectId}`,
        runStatus: 'failed',
        createdAt: Date.now() - 1_000,
        startedAt: Date.now() - 1_000,
        preTurnFileNames: [],
        events: [
          {
            kind: 'status',
            label: 'error',
            detail: input.detail,
            code: input.code,
          },
        ],
      },
    },
  );
  expect(
    assistantMessage.ok(),
    `upsert assistant message: ${await assistantMessage.text()}`,
  ).toBeTruthy();
}
