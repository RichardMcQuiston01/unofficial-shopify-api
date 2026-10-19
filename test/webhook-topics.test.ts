import { describe, expect, it } from 'vitest';

import { fromGraphqlTopic, toGraphqlTopic } from '../src/index.js';

describe('topics', () => {
  it.each([
    ['products/update', 'PRODUCTS_UPDATE'],
    ['app/uninstalled', 'APP_UNINSTALLED'],
    ['fulfillment_events/create', 'FULFILLMENT_EVENTS_CREATE'],
    ['PRODUCTS_UPDATE', 'PRODUCTS_UPDATE'],
    [' orders/paid ', 'ORDERS_PAID'],
  ])('toGraphqlTopic(%j) is %s', (input: string, expected: string) => {
    expect(toGraphqlTopic(input)).toBe(expected);
  });

  it('fromGraphqlTopic restores the final separator only', () => {
    expect(fromGraphqlTopic('PRODUCTS_UPDATE')).toBe('products/update');
    expect(fromGraphqlTopic('APP_UNINSTALLED')).toBe('app/uninstalled');
    expect(fromGraphqlTopic('SINGLE')).toBe('single');
  });
});
