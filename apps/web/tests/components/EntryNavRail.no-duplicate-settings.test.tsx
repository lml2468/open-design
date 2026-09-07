// @vitest-environment jsdom
//
// Settings has one stable local destination. It no longer moves between the
// rail and a Vela account menu based on cloud identity.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

function renderRail(onOpenSettings = vi.fn()) {
  render(
    <I18nProvider initial="en">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        onOpenSettings={onOpenSettings}
      />
    </I18nProvider>,
  );
  return onOpenSettings;
}

afterEach(() => {
  cleanup();
});

describe('EntryNavRail settings entry', () => {
  it('renders exactly one local settings item and opens settings', () => {
    const onOpenSettings = renderRail();

    const settings = screen.getAllByTestId('entry-settings-button');
    expect(settings).toHaveLength(1);
    fireEvent.click(settings[0]!);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps settings after the local navigation destinations', () => {
    renderRail();

    const settings = screen.getByTestId('entry-settings-button');
    expect(settings).toBeTruthy();
    expect(screen.getByTestId('entry-nav-plugins').compareDocumentPosition(settings)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
