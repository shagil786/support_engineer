import { describe, it, expect } from 'vitest';
import { learningEnabledFromEnv } from '../../src/config';

describe('LEARNING_ENABLED', () => {
  it('is disabled by default', () => {
    expect(learningEnabledFromEnv({}).enabled).toBe(false);
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: undefined }).enabled).toBe(false);
  });

  it('is enabled only for explicit true/1', () => {
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'true' }).enabled).toBe(true);
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'TRUE' }).enabled).toBe(true);
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: '1' }).enabled).toBe(true);
  });

  it('stays off for other values', () => {
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'false' }).enabled).toBe(false);
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: '0' }).enabled).toBe(false);
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'yes' }).enabled).toBe(false);
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: '' }).enabled).toBe(false);
  });

  it('parses LEARNING_INTERVAL_MS only when enabled and valid (>= 1000)', () => {
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'true', LEARNING_INTERVAL_MS: '60000' })).toEqual({ enabled: true, intervalMs: 60000 });
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'true', LEARNING_INTERVAL_MS: '500' })).toEqual({ enabled: true });
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'true', LEARNING_INTERVAL_MS: 'nope' })).toEqual({ enabled: true });
    expect(learningEnabledFromEnv({ LEARNING_ENABLED: 'true', LEARNING_INTERVAL_MS: undefined })).toEqual({ enabled: true });
    expect(learningEnabledFromEnv({ LEARNING_INTERVAL_MS: '60000' })).toEqual({ enabled: false });
  });
});
