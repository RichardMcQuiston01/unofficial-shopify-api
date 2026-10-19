import { describe, expect, it } from 'vitest';

import {
  UserError,
  checkUserErrors,
  type Result,
  type WithUserErrors,
} from '../src/index.js';

describe('checkUserErrors', () => {
  it('passes a payload with no userErrors through', () => {
    const payload: { product: { id: string }; userErrors: never[] } = {
      product: { id: 'gid://shopify/Product/1' },
      userErrors: [],
    };
    expect(checkUserErrors(payload, 'productCreate')).toEqual({
      ok: true,
      value: payload,
    });
  });

  it('treats an empty or null list as success', () => {
    expect(checkUserErrors({ userErrors: [] }, 'x').ok).toBe(true);
    expect(checkUserErrors({ userErrors: null }, 'x').ok).toBe(true);
  });

  it('turns userErrors into a descriptive UserError', () => {
    const result: Result<WithUserErrors, UserError> = checkUserErrors(
      {
        userErrors: [
          { message: "Title can't be blank", field: ['input', 'title'] },
          { message: 'Handle taken', field: null },
        ],
      },
      'productCreate'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UserError);
      expect(result.error.message).toBe(
        "productCreate was rejected by Shopify: Title can't be blank (input.title); Handle taken"
      );
      expect(result.error.userErrors).toHaveLength(2);
      expect(result.error.context.operation).toBe('productCreate');
    }
  });
});
