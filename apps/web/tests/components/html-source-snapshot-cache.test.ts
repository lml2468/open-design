import { describe, expect, it } from 'vitest';
import {
  HtmlSourceSnapshotCache,
  htmlSourceSnapshotRefreshKey,
} from '../../src/components/html-source-snapshot-cache';

describe('HtmlSourceSnapshotCache', () => {
  it('evicts the least-recently-used entry when the entry cap is exceeded', () => {
    const cache = new HtmlSourceSnapshotCache({ maxEntries: 2, maxUtf16Bytes: 1_000 });

    cache.set({ projectId: 'project', fileName: 'a.html', refreshKey: '1', source: 'a' });
    cache.set({ projectId: 'project', fileName: 'b.html', refreshKey: '1', source: 'b' });
    expect(cache.get('project', 'a.html', '1')?.source).toBe('a');

    cache.set({ projectId: 'project', fileName: 'c.html', refreshKey: '1', source: 'c' });

    expect(cache.get('project', 'b.html', '1')).toBeNull();
    expect(cache.get('project', 'a.html', '1')?.source).toBe('a');
    expect(cache.get('project', 'c.html', '1')?.source).toBe('c');
  });

  it('evicts least-recently-used entries until the UTF-16 byte cap is met', () => {
    const cache = new HtmlSourceSnapshotCache({ maxEntries: 10, maxUtf16Bytes: 10 });

    cache.set({ projectId: 'project', fileName: 'a.html', refreshKey: '1', source: 'abc' });
    cache.set({ projectId: 'project', fileName: 'b.html', refreshKey: '1', source: 'de' });
    expect(cache.get('project', 'a.html', '1')?.source).toBe('abc');

    cache.set({ projectId: 'project', fileName: 'c.html', refreshKey: '1', source: 'fgh' });

    expect(cache.get('project', 'b.html', '1')).toBeNull();
    expect(cache.get('project', 'a.html', '1')).toBeNull();
    expect(cache.get('project', 'c.html', '1')?.source).toBe('fgh');
    expect(cache.utf16Bytes).toBe(6);
  });

  it('does not return a snapshot for a changed content refresh key', () => {
    const cache = new HtmlSourceSnapshotCache({ maxEntries: 2, maxUtf16Bytes: 1_000 });
    cache.set({ projectId: 'project', fileName: 'a.html', refreshKey: 'old', source: 'stale' });

    expect(cache.get('project', 'a.html', 'new')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('supports explicit file and project invalidation', () => {
    const cache = new HtmlSourceSnapshotCache({ maxEntries: 10, maxUtf16Bytes: 1_000 });
    cache.set({ projectId: 'one', fileName: 'a.html', refreshKey: '1', source: 'a' });
    cache.set({ projectId: 'one', fileName: 'b.html', refreshKey: '1', source: 'b' });
    cache.set({ projectId: 'two', fileName: 'a.html', refreshKey: '1', source: 'other' });

    cache.invalidateFile('one', 'a.html');
    expect(cache.get('one', 'a.html', '1')).toBeNull();
    expect(cache.get('one', 'b.html', '1')?.source).toBe('b');

    cache.invalidateProject('one');
    expect(cache.get('one', 'b.html', '1')).toBeNull();
    expect(cache.get('two', 'a.html', '1')?.source).toBe('other');
  });

  it('never serves a same-file snapshot across Projects', () => {
    const cache = new HtmlSourceSnapshotCache({ maxEntries: 10, maxUtf16Bytes: 1_000 });
    cache.set({
      projectId: 'project-a',
      fileName: 'a.html',
      refreshKey: '1',
      source: 'project-a-source',
    });

    expect(cache.get('project-b', 'a.html', '1')).toBeNull();
    expect(cache.get('project-a', 'a.html', '1')?.source).toBe('project-a-source');
  });

  it('builds the refresh key from file content metadata and the file-change generation', () => {
    expect(htmlSourceSnapshotRefreshKey({ mtime: 42, size: 7 }, 3)).toBe('42:7:3');
  });
});
