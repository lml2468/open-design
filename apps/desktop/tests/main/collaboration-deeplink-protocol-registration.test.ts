import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  isPackaged: true,
  on: vi.fn(),
  setAsDefaultProtocolClient: vi.fn(),
  whenReady: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return electron.isPackaged; },
    on: electron.on,
    setAsDefaultProtocolClient: electron.setAsDefaultProtocolClient,
    whenReady: electron.whenReady,
  },
}));

const realPlatform = process.platform;

async function registerOn(platform: NodeJS.Platform, isPackaged: boolean, protocolClientPath?: string) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  electron.isPackaged = isPackaged;
  vi.resetModules();
  const { registerCollaborationDeeplink } = await import('../../src/main/collaboration-deeplink.js');
  registerCollaborationDeeplink({ navigate: vi.fn(), protocolClientPath });
}

beforeEach(() => {
  electron.on.mockClear();
  electron.setAsDefaultProtocolClient.mockClear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: realPlatform });
});

describe('collaboration deeplink protocol registration', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])('does not claim the scheme from a %s dev run', async (platform) => {
    await registerOn(platform, false);
    expect(electron.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('claims the scheme for a packaged macOS app', async () => {
    await registerOn('darwin', true);
    expect(electron.setAsDefaultProtocolClient).toHaveBeenCalledWith('opendesign');
  });

  it('uses the stable launcher for a packaged Windows app', async () => {
    const launcher = 'C:\\OpenDesign\\OpenDesign.exe';
    await registerOn('win32', true, launcher);
    expect(electron.setAsDefaultProtocolClient).toHaveBeenCalledWith('opendesign', launcher);
  });
});
