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
});
