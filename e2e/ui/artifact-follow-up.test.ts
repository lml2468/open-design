import type { Page } from '@playwright/test';

import {
  createProjectViaApi,
  gotoProject,
  putAppConfig,
  seedBrowserConfig,
  sendPrompt,
} from '@/playwright/app';
import {
  routeAgents,
  routeSuccessfulRuns,
  suppressWhatsNew,
} from '@/playwright/mock-factory';
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';

const KIMI_AGENT = {
  id: 'kimi',
  name: 'Kimi CLI',
  bin: 'kimi',
  available: true,
  version: 'test',
  models: [{ id: 'default', label: 'Default' }],
};

const KIMI_CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: 'kimi',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
  agentModels: { kimi: { model: 'default', reasoning: 'default' } },
};

const KIMI_ARTIFACT_RUN = [
  'event: stdout',
  `data: ${JSON.stringify({
    chunk: '<artifact identifier="kimi-follow-up" type="text/html" title="Kimi artifact"><!doctype html><html><body><h1>Kimi artifact</h1></body></html></artifact>',
  })}`,
  '',
  'event: end',
  'data: {"code":0,"status":"succeeded","artifactCount":1}',
  '',
  '',
].join('\n');

test('[P1] Kimi artifact follow-ups continue through the selected local runtime', async ({ page }) => {
  test.setTimeout(T.xlong);

  await suppressWhatsNew(page);
  await routeAgents(page, [KIMI_AGENT]);
  await seedBrowserConfig(page, KIMI_CONFIG);
  await putAppConfig(page, KIMI_CONFIG);
  const projectId = `kimi-follow-up-${Date.now()}`;
  const runs = await routeSuccessfulRuns(page, {
    runIdPrefix: 'kimi-follow-up',
    eventBody: async (requestIndex) => {
      if (requestIndex === 1) {
        const response = await page.request.post(`/api/projects/${projectId}/files`, {
          data: {
            name: 'kimi-follow-up.html',
            content: '<!doctype html><html><body><h1>Kimi artifact</h1></body></html>',
            artifactManifest: {
              version: 1,
              kind: 'html',
              title: 'Kimi artifact',
              entry: 'kimi-follow-up.html',
              renderer: 'html',
              status: 'complete',
              exports: ['html'],
              primary: true,
              metadata: { identifier: 'kimi-follow-up' },
            },
          },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
      }
      return KIMI_ARTIFACT_RUN;
    },
  });

  await createProjectViaApi(page, projectId, 'Kimi artifact follow-up');
  await gotoProject(page, projectId);

  await sendPrompt(page, 'Create a Kimi artifact');
  await runs.expectCount(1);
  await expect(artifactPreview(page).getByRole('heading', { name: 'Kimi artifact' })).toBeVisible({
    timeout: T.long,
  });

  await sendPrompt(page, 'Refine the Kimi artifact');
  await runs.expectCount(2, {
    timeout: T.long,
    message: 'the Kimi follow-up should reach POST /api/runs through the selected runtime',
  });
});

function artifactPreview(page: Page) {
  return page.frameLocator(
    '[data-testid="artifact-preview-frame"]:visible, '
    + '[data-testid="artifact-preview-frame-url-load"]:visible, '
    + '[data-testid="artifact-preview-frame-srcdoc"]:visible, '
    + '[data-testid="live-artifact-preview-frame"]:visible',
  );
}
