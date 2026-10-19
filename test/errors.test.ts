import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  ConfigurationError,
  GraphqlError,
  NetworkError,
  ShopifyError,
  ThrottledError,
  UserError,
  WebhookVerificationError,
} from '../src/index.js';

describe('errors', () => {
  it('sets name, code, context and cause', () => {
    const cause: Error = new Error('root');
    const error: NetworkError = new NetworkError('Request failed', {
      context: { operation: 'getProduct', status: 502, requestId: 'abc' },
      cause,
    });
    expect(error).toBeInstanceOf(ShopifyError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NetworkError');
    expect(error.code).toBe('NETWORK');
    expect(error.context.requestId).toBe('abc');
    expect(error.cause).toBe(cause);
  });

  it('defaults context to an empty object', () => {
    expect(new ConfigurationError('bad shop').context).toEqual({});
  });

  it.each([
    [new ConfigurationError('x'), 'CONFIGURATION'],
    [new AuthenticationError('x'), 'AUTHENTICATION'],
    [new WebhookVerificationError('x'), 'WEBHOOK_VERIFICATION'],
  ])('%s has the expected code', (error: ShopifyError, code: string) => {
    expect(error.code).toBe(code);
  });

  it('exposes retryAfterMs on ThrottledError', () => {
    const error: ThrottledError = new ThrottledError('slow down', {
      retryAfterMs: 2000,
    });
    expect(error.code).toBe('THROTTLED');
    expect(error.retryAfterMs).toBe(2000);
  });

  it('exposes GraphQL error details', () => {
    const error: GraphqlError = new GraphqlError('failed', {
      errors: [{ message: 'Field missing' }],
    });
    expect(error.code).toBe('GRAPHQL');
    expect(error.errors).toHaveLength(1);
  });

  it('exposes user error details', () => {
    const error: UserError = new UserError('invalid', {
      userErrors: [{ message: 'Title blank', field: ['title'] }],
    });
    expect(error.code).toBe('USER_ERROR');
    expect(error.userErrors[0]?.field).toEqual(['title']);
  });
});
