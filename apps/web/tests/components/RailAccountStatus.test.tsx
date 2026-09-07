// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RailAccountSyncTip } from '../../src/components/RailAccountStatus';
import { I18nProvider } from '../../src/i18n';

afterEach(cleanup);

describe('RailAccountSyncTip', () => {
  function renderSyncTip() {
    return render(
      <I18nProvider initial="en">
        <RailAccountSyncTip />
      </I18nProvider>,
    );
  }

  it('renders an inert status readout instead of leaving the slot blank', async () => {
    renderSyncTip();
    const status = await screen.findByTestId('entry-rail-account-sync-tip');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Loading');
  });

  it('uses an avatar and name skeleton without interactive controls', async () => {
    renderSyncTip();
    const status = await screen.findByTestId('entry-rail-account-sync-tip');
    expect(status.tagName).toBe('DIV');
    expect(status.querySelector('button')).toBeNull();
    expect(status.querySelector('.entry-rail-account-skeleton__avatar')).not.toBeNull();
    expect(status.querySelector('.entry-rail-account-skeleton__name')).not.toBeNull();
    expect(status.querySelector('strong')).toBeNull();
    expect(status.querySelector('svg')).toBeNull();
  });
});
