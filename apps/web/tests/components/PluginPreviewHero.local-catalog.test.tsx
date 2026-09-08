// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { PluginPreviewHero } from '../../src/components/plugin-details/PluginPreviewHero';

afterEach(cleanup);

it('uses the daemon-local plugin example URL for iframe and popout navigation', () => {
  render(
    <PluginPreviewHero
      pluginId="deck-plugin"
      pluginTitle="Deck"
      examples={[{ path: 'examples/overview.html', title: 'Overview' }]}
    />,
  );

  const expected = '/api/plugins/deck-plugin/example/overview';
  expect(screen.getByTestId('plugin-details-hero-iframe').getAttribute('src')).toBe(expected);
  expect(screen.getByTestId('plugin-details-hero-popout').getAttribute('href')).toBe(expected);
});
