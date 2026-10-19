import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createConsoleLogger, noopLogger } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('noopLogger does nothing', () => {
    expect(() => {
      noopLogger.debug('a');
      noopLogger.info('a');
      noopLogger.warn('a');
      noopLogger.error('a');
    }).not.toThrow();
  });

  it('filters messages below the configured level', () => {
    const info: MockInstance = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    const warn: MockInstance = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    createConsoleLogger('warn').info('hidden');
    createConsoleLogger('warn').warn('shown');
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[shopify:warn] shown');
  });

  it('passes context through', () => {
    const error: MockInstance = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    createConsoleLogger('debug').error('failed', { shop: 'a.myshopify.com' });
    expect(error).toHaveBeenCalledWith('[shopify:error] failed', {
      shop: 'a.myshopify.com',
    });
  });

  it('silent suppresses everything', () => {
    const error: MockInstance = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    createConsoleLogger('silent').error('nope');
    expect(error).not.toHaveBeenCalled();
  });
});
