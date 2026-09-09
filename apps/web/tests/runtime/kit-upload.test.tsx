// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({
  fetchProjectFileText: vi.fn(),
  uploadProjectFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

vi.mock('../../src/providers/registry', () => registryMocks);

import {
  useKitModuleUpload,
  type KitModuleUpload,
} from '../../src/runtime/kit-upload';

let latestUpload: KitModuleUpload | null = null;

function Harness({
  onError,
}: {
  onError?: (module: 'logo' | 'image' | 'font', message: string) => void;
}) {
  latestUpload = useKitModuleUpload({
    projectId: 'project-a',
    title: 'Acme',
    onError,
  });
  return null;
}

afterEach(() => {
  cleanup();
  latestUpload = null;
  vi.clearAllMocks();
});

describe('useKitModuleUpload local reads', () => {
  it('reads the existing brand before patching it', async () => {
    const existingBrand = {
      name: 'Acme',
      tagline: 'Never erase this',
      description: 'Existing description',
      sourceUrl: 'https://acme.test',
      logo: { primary: 'logos/old.svg', alternates: [], notes: 'keep' },
      colors: [{ role: 'accent', name: 'Brand', hex: '#123456', usage: 'buttons' }],
      typography: {
        display: { family: 'Inter', fallbacks: [], weights: [400] },
        body: { family: 'Inter', fallbacks: [], weights: [400] },
      },
      voice: {
        adjectives: ['clear'],
        tone: 'direct',
        messagingPillars: ['quality'],
        vocabulary: { use: ['simple'], avoid: ['vague'] },
      },
      imagery: {
        style: 'editorial',
        subjects: ['people'],
        treatment: 'natural',
        avoid: ['stock'],
        samples: [],
      },
      layout: {
        radius: '8px',
        borderWeight: '1px',
        spacing: '8px',
        postureRules: ['calm'],
      },
    };
    registryMocks.uploadProjectFile.mockResolvedValue({
      name: 'logos/new.svg',
      size: 10,
      mtime: 1,
      kind: 'image',
      mime: 'image/svg+xml',
    });
    registryMocks.fetchProjectFileText.mockImplementation(
      async (_projectId: string, name: string) =>
        name === 'brand.json' ? JSON.stringify(existingBrand) : null,
    );
    registryMocks.writeProjectTextFile.mockResolvedValue({ name: 'brand.json' });

    render(<Harness />);
    await act(async () => {
      await latestUpload?.uploadModule(
        'logo',
        new File(['svg'], 'new.svg', { type: 'image/svg+xml' }),
      );
    });

    expect(registryMocks.fetchProjectFileText).toHaveBeenCalledWith(
      'project-a',
      'brand.json',
      { cache: 'no-store' },
    );
    const written = JSON.parse(String(registryMocks.writeProjectTextFile.mock.calls[0]?.[2]));
    expect(written).toEqual(expect.objectContaining({
      tagline: 'Never erase this',
      description: 'Existing description',
      sourceUrl: 'https://acme.test',
      colors: existingBrand.colors,
      voice: existingBrand.voice,
    }));
    expect(written.logo).toEqual(expect.objectContaining({
      primary: 'logos/new.svg',
      alternates: ['logos/old.svg'],
      notes: 'keep',
    }));
  });

  it('never replaces a brand with an empty fallback when the read fails', async () => {
    const onError = vi.fn();
    registryMocks.uploadProjectFile.mockResolvedValue({
      name: 'logos/new.svg',
      size: 10,
      mtime: 1,
      kind: 'image',
      mime: 'image/svg+xml',
    });
    registryMocks.fetchProjectFileText.mockResolvedValue(null);

    render(<Harness onError={onError} />);
    await act(async () => {
      await latestUpload?.uploadModule(
        'logo',
        new File(['svg'], 'new.svg', { type: 'image/svg+xml' }),
      );
    });

    expect(registryMocks.writeProjectTextFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('logo', 'brand-read-failed');
  });
});
