import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MEDIA_PROVIDERS,
  canonicalMediaModelId,
  findMediaModel,
} from '../../src/media/models.js';

describe('image model defaults', () => {
  it('uses OpenAI gpt-image-2 as the only default image route', () => {
    expect(IMAGE_MODELS.filter((model) => model.default).map((model) => model.id)).toEqual([
      'gpt-image-2',
    ]);
    expect(MEDIA_PROVIDERS.every((provider) => provider.id.length > 0)).toBe(true);
    expect(IMAGE_MODELS.every((model) => MEDIA_PROVIDERS.some((provider) => provider.id === model.provider))).toBe(true);
  });

  it('does not retain removed Cloud model aliases', () => {
    expect(canonicalMediaModelId('codex-gpt-image-2')).toBe('codex-gpt-image-2');
    expect(findMediaModel('codex-gpt-image-2')).toBeNull();
    expect(findMediaModel('nano-banana-2')).toBeNull();
  });

  it('preserves explicit OpenAI BYOK model selection', () => {
    expect(canonicalMediaModelId('gpt-image-2')).toBe('gpt-image-2');
    expect(findMediaModel('gpt-image-2')?.provider).toBe('openai');
  });
});
