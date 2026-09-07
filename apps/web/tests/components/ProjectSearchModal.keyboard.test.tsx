// @vitest-environment jsdom

// The ⌘K palette is reached and driven from the keyboard, so ↑/↓ must move the
// highlight and Enter must open the highlighted project — all without moving
// focus off the search input, which would stall typing.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectSearchModal } from '../../src/components/ProjectSearchModal';
import { I18nProvider } from '../../src/i18n';
import type { Project } from '../../src/types';

afterEach(() => cleanup());

function project(id: string, name: string, updatedAt: number): Project {
  return {
    id,
    name,
    createdAt: updatedAt,
    updatedAt,
    metadata: {},
  } as unknown as Project;
}

// Deliberately unsorted: the palette ranks by recency, so the rendered order
// (and therefore what ↑/↓ walk through) is newest-first, not input order.
const PROJECTS = [
  project('older', 'Older deck', 1_000),
  project('newest', 'Newest deck', 3_000),
  project('middle', 'Middle deck', 2_000),
];

function renderPalette(
  onOpenProject = vi.fn(),
  onClose = vi.fn(),
  projects = PROJECTS,
) {
  render(
    <I18nProvider>
      <ProjectSearchModal
        projects={projects}
        onOpenProject={onOpenProject}
        onClose={onClose}
      />
    </I18nProvider>,
  );
  return { onOpenProject, onClose };
}

function activeName(): string | undefined {
  const active = document.querySelector('.project-search-results .project-search-item.is-active');
  return active?.querySelector('.project-search-item-name')?.textContent?.trim();
}

describe('ProjectSearchModal keyboard navigation', () => {
  it('highlights the top match first and walks the list with the arrow keys', () => {
    renderPalette();
    const input = screen.getByTestId('project-search-input');

    expect(activeName()).toBe('Newest deck');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeName()).toBe('Middle deck');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeName()).toBe('Older deck');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeName()).toBe('Middle deck');
  });

  it('wraps around at both ends', () => {
    renderPalette();
    const input = screen.getByTestId('project-search-input');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeName()).toBe('Older deck');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeName()).toBe('Newest deck');
  });

  it('opens the highlighted project on Enter and closes the palette', () => {
    const onOpenProject = vi.fn();
    const onClose = vi.fn();
    renderPalette(onOpenProject, onClose);
    const input = screen.getByTestId('project-search-input');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onOpenProject).toHaveBeenCalledWith('middle');
    expect(onClose).toHaveBeenCalled();
  });

  it('restarts the highlight at the top match when the query re-ranks the list', () => {
    renderPalette();
    const input = screen.getByTestId('project-search-input');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeName()).toBe('Older deck');

    fireEvent.change(input, { target: { value: 'Middle' } });

    // The stale index would have pointed past the end of the filtered list.
    expect(activeName()).toBe('Middle deck');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('project-search-item-middle')).toBeTruthy();
  });

  it('ignores the arrow keys when nothing matches', () => {
    renderPalette();
    const input = screen.getByTestId('project-search-input');

    fireEvent.change(input, { target: { value: 'no-such-project' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(activeName()).toBeUndefined();
  });

  it('uses the local project route for cover URLs', () => {
    const localProject = {
      ...project('local-project', 'Local project', 4_000),
      metadata: {
        entryFile: 'cover.png',
        kind: 'image',
      },
    } as Project;
    renderPalette(vi.fn(), vi.fn(), [localProject]);

    const image = screen.getByTestId('project-search-item-local-project').querySelector('img');
    expect(image?.getAttribute('src')).toBe(
      '/api/projects/local-project/raw/cover.png?v=4000',
    );
  });
});
