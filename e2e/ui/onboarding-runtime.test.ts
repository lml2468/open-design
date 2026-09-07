import type { Locator, Page } from '@playwright/test';

import { expect, test } from '@/playwright/suite';
import {
  dismissPrivacyDialog,
  STORAGE_KEY,
  waitForLoadingToClear,
} from '@/playwright/app';
import { fulfillAgentsRoute, suppressWhatsNew } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

type OnboardingConfig = {
  mode: 'daemon' | 'api';
  apiKey: string;
  apiProtocol?: string;
  baseUrl: string;
  model: string;
  agentId: string | null;
  skillId: null;
  designSystemId: string | null;
  onboardingCompleted: boolean;
  mediaProviders: Record<string, never>;
  agentModels: Record<string, { model: string; reasoning: string }>;
};

type LocalAgent = {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  version: string;
  models: Array<{ id: string; label: string }>;
};

test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await suppressWhatsNew(page);
});

test('[P0] @critical onboarding Local Agent lets the user pick a model before continuing', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {
    codexModels: [
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'gpt-5.5', label: 'gpt-5.5' },
      { id: 'o3', label: 'o3' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'glm-5', label: 'GLM 5' },
      { id: 'qwen3-235b', label: 'Qwen3 235B' },
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
    ],
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Local Agent/i);

  const localPanel = page.locator('.onboarding-view__setup-panel');
  await expect(localPanel).toBeVisible();
  await selectOnboardingOption(localPanel, 'Model', 'GLM 5');
  await expect(onboardingTrigger(localPanel, 'Model')).toContainText('GLM 5');
  await expect(page.getByRole('button', { name: /^Continue$/i })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );

  await page.getByRole('button', { name: /^Back$|返回/i }).click();
  await expectModelSourceChooser(page);
  await expect(page.getByRole('radio', { name: /Local Agent/i })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('[P0] onboarding Local Agent completes setup with the selected model', async ({ page }) => {
  const config = await wireOnboardingMocks(page, {
    codexModels: [
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'glm-5', label: 'GLM 5' },
    ],
  });

  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 12,
        model: 'glm-5',
        agentName: 'Codex CLI',
        sample: 'Connected',
      },
    });
  });
  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Local Agent/i);

  const localPanel = page.locator('.onboarding-view__setup-panel');
  await selectOnboardingOption(localPanel, 'Model', 'GLM 5');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);
  await page.getByRole('button', { name: /^Continue$/i }).click();

  await expectOnboardingFinished(page);
  await pollStoredConfig(page).toMatchObject({
    mode: 'daemon',
    agentId: 'codex',
    agentModels: { codex: { model: 'glm-5' } },
    onboardingCompleted: true,
  });
});

test('[P0] onboarding Local Agent stays gated when no local CLI is available', async ({ page }) => {
  const config = await wireOnboardingMocks(page, { localAgents: [] });
  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Local Agent/i);

  await expect(page.getByText('Local CLI')).toBeVisible();
  await expect(page.getByText(/No agents detected|No local CLI detected/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Continue$/i })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('[P0] onboarding Local Agent stays gated while the local scan is running', async ({ page }) => {
  const config = await wireOnboardingMocks(page, { agentsDelayMs: 20_000 });
  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Local Agent/i);

  await expect(page.getByRole('button', { name: /Scanning|扫描中/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Continue$/i })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('[P0] onboarding Back returns to the source chooser and preserves the BYOK choice', async ({ page }) => {
  const config = await wireOnboardingMocks(page);
  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Bring Your Own Key/i);

  await expect(onboardingByokPanel(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Continue$/i })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByRole('button', { name: /^Back$/i }).click();

  await expectModelSourceChooser(page);
  await expect(page.getByRole('radio', { name: /Bring Your Own Key/i })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('[P0] @critical onboarding BYOK fetches models, tests the provider, and completes setup', async ({ page }) => {
  const config = await wireOnboardingMocks(page);
  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 14,
        models: [
          { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        ],
      },
    });
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 27,
        model: 'claude-opus-4-8',
        sample: 'Connected',
      },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Bring Your Own Key/i);

  const byokPanel = onboardingByokPanel(page);
  await fillInlineField(page, 'API key', 'test-api-key');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /Fetch models/i }).click();
  await expect(page.getByText(/Fetched 2 models\./)).toBeVisible();
  await selectOnboardingOption(byokPanel, 'Model', 'claude-opus-4-8');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);
  await page.getByRole('button', { name: /^Continue$/i }).click();

  await expectOnboardingFinished(page);
  await pollStoredConfig(page).toMatchObject({
    mode: 'api',
    apiKey: 'test-api-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-4-8',
    onboardingCompleted: true,
  });
});

test('[P0] onboarding BYOK retries validation after a failed Continue', async ({ page }) => {
  const config = await wireOnboardingMocks(page);
  let connectionOk = false;
  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 14,
        models: [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
      },
    });
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: connectionOk
        ? {
            ok: true,
            kind: 'success',
            latencyMs: 18,
            model: 'claude-sonnet-4-5',
            sample: 'Connected',
          }
        : {
            ok: false,
            kind: 'error',
            latencyMs: 18,
            error: 'Invalid API key',
          },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Bring Your Own Key/i);
  const byokPanel = onboardingByokPanel(page);
  const continueButton = page.getByRole('button', { name: /^Continue$/i });

  await fillInlineField(page, 'API key', 'bad-api-key');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /Fetch models/i }).click();
  await expect(page.getByText(/Fetched 1 model/)).toBeVisible();
  await selectOnboardingOption(byokPanel, 'Model', 'Claude Sonnet 4.5');
  await continueButton.click();
  await expect(page.getByText(/Invalid API key|Connection failed|failed/i)).toBeVisible();

  connectionOk = true;
  await fillInlineField(page, 'API key', 'good-api-key');
  await continueButton.click();
  await expectOnboardingFinished(page);
});

test('[P0] onboarding BYOK exposes the Anthropic key and persists its protocol', async ({ page }) => {
  const config = await wireOnboardingMocks(page);
  let connectionBody: Record<string, unknown> | null = null;
  await page.route('**/api/test/connection', async (route) => {
    connectionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 19,
        model: 'claude-sonnet-4-5',
        sample: 'Connected',
      },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Bring Your Own Key/i);
  await expect(page.getByRole('tab', { name: /^Anthropic$/i })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const apiKeyField = onboardingField(page, 'API key');
  const apiKeyInput = apiKeyField.locator('input');
  await expect(apiKeyInput).toHaveAttribute('type', 'password');
  await fillInlineField(page, 'API key', 'anthropic-test-key');
  await apiKeyField.getByRole('button', { name: /^Show$/i }).click();
  await expect(apiKeyInput).toHaveAttribute('type', 'text');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await selectOnboardingOption(onboardingByokPanel(page), 'Model', 'claude-sonnet-4-5');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);

  await expect.poll(() => connectionBody).toMatchObject({
    mode: 'provider',
    protocol: 'anthropic',
    apiKey: 'anthropic-test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
  });

  await page.getByRole('button', { name: /^Continue$/i }).click();
  await expectOnboardingFinished(page);
  await pollStoredConfig(page).toMatchObject({
    mode: 'api',
    apiProtocol: 'anthropic',
    apiKey: 'anthropic-test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    onboardingCompleted: true,
  });
});

test('[P0] onboarding BYOK invalidates a successful test when connection settings change', async ({ page }) => {
  const config = await wireOnboardingMocks(page);
  await page.route('**/api/provider/models', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 12,
        models: [
          { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        ],
      },
    });
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 17,
        model: 'claude-sonnet-4-5',
        sample: 'Connected',
      },
    });
  });

  await seedOnboardingConfig(page, config);
  await gotoOnboarding(page);
  await openModelSourceSetup(page, /Bring Your Own Key/i);
  const byokPanel = onboardingByokPanel(page);
  const continueButton = page.getByRole('button', { name: /^Continue$/i });

  await fillInlineField(page, 'API key', 'valid-api-key');
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /Fetch models/i }).click();
  await expect(page.getByText(/Fetched 2 models/)).toBeVisible();
  await selectOnboardingOption(byokPanel, 'Model', 'Claude Sonnet 4.5');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);

  await fillInlineField(page, 'API key', 'changed-api-key');
  await expect(page.getByText(/Connected\. Replied/i)).toHaveCount(0);
  await expect(continueButton).not.toHaveAttribute('aria-disabled', 'true');

  await fillInlineField(page, 'Base URL', 'https://api.changed.example');
  await expect(page.getByText(/Connected\. Replied/i)).toHaveCount(0);
  await fillInlineField(page, 'Base URL', 'https://api.anthropic.com');
  await page.getByRole('button', { name: /^Test$/i }).click();
  await expectConnectionSuccess(page);
  await selectOnboardingOption(byokPanel, 'Model', 'Claude Opus 4.8');
  await expect(page.getByText(/Connected\. Replied/i)).toHaveCount(0);
});

async function wireOnboardingMocks(
  page: Page,
  options: {
    agentsDelayMs?: number;
    codexModels?: Array<{ id: string; label: string }>;
    localAgents?: LocalAgent[];
  } = {},
): Promise<OnboardingConfig> {
  const config: OnboardingConfig = {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId: null,
    skillId: null,
    designSystemId: null,
    onboardingCompleted: false,
    mediaProviders: {},
    agentModels: {},
  };

  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { projects: [] } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { config } });
      return;
    }
    if (route.request().method() === 'PUT') {
      Object.assign(config, route.request().postDataJSON() as Partial<OnboardingConfig>);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.continue();
  });

  const localAgents = options.localAgents ?? [{
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: 'test',
    models: options.codexModels ?? [{ id: 'default', label: 'Default' }],
  }];
  await page.route('**/api/agents**', async (route) => {
    if (options.agentsDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.agentsDelayMs));
    }
    await fulfillAgentsRoute(route, localAgents);
  });
  await page.route('**/api/test/connection', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        kind: 'success',
        latencyMs: 12,
        model: 'default',
        agentName: 'Codex CLI',
        sample: 'Connected',
      },
    });
  });

  return config;
}

async function gotoOnboarding(page: Page) {
  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);
  await expectModelSourceChooser(page);
}

async function expectModelSourceChooser(page: Page) {
  await expect(
    page.getByRole('heading', { name: /Choose your model source|选择模型来源/i }),
  ).toBeVisible({ timeout: T.long });
  await expect(page.getByRole('radiogroup')).toBeVisible();
}

async function openModelSourceSetup(page: Page, sourceName: RegExp) {
  const source = page.getByRole('radio', { name: sourceName });
  await expect(source).toBeVisible();
  await source.click();
  await page.getByRole('button', { name: /^Continue$/i }).click();
}

async function seedOnboardingConfig(page: Page, config: OnboardingConfig) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: STORAGE_KEY, value: config },
  );
}

async function expectOnboardingFinished(page: Page) {
  await dismissPrivacyDialog(page);
  const goHome = page.getByRole('button', { name: /Go to home/i });
  if (await goHome.isVisible().catch(() => false)) {
    await goHome.click();
  } else {
    const finishSetup = page.getByRole('button', { name: /Finish setup/i });
    if (await finishSetup.isVisible().catch(() => false)) await finishSetup.click();
  }
  await expect(page).not.toHaveURL(/\/onboarding$/);
  await dismissPrivacyDialog(page);
  await expect(page.getByTestId('home-view')).toBeVisible();
}

function onboardingByokPanel(page: Page) {
  return page.locator('.onboarding-view__setup-panel').filter({
    has: page.getByText('API providers', { exact: true }),
  });
}

async function expectConnectionSuccess(page: Page) {
  await expect(page.getByText(/Connected\. Replied in \d+ ms|.+ replied in \d+ ms/)).toBeVisible();
}

function pollStoredConfig(page: Page) {
  return expect.poll(() =>
    page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || '{}'), STORAGE_KEY),
  );
}

type OnboardingLocatorRoot = Page | Locator;

function onboardingField(root: OnboardingLocatorRoot, label: string) {
  return root.locator('.onboarding-view__select-field, .onboarding-view__inline-field').filter({
    hasText: new RegExp(label, 'i'),
  }).first();
}

function onboardingTrigger(root: OnboardingLocatorRoot, label: string) {
  return onboardingField(root, label).getByRole('button');
}

async function selectOnboardingOption(
  root: OnboardingLocatorRoot,
  label: string,
  option: string,
) {
  const field = onboardingField(root, label);
  const listbox = field.getByRole('listbox', { name: new RegExp(label, 'i') });
  if (!(await listbox.isVisible().catch(() => false))) {
    await field.getByRole('button').click();
  }
  await listbox
    .getByRole('option')
    .filter({ hasText: new RegExp(option, 'i') })
    .first()
    .click();
}

async function fillInlineField(page: Page, label: string, value: string) {
  await onboardingField(page, label).locator('input').fill(value);
}
