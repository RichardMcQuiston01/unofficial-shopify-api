/**
 * Webhook topics appear in two spellings: `products/update` in delivery
 * headers and `PRODUCTS_UPDATE` in the GraphQL `WebhookSubscriptionTopic`
 * enum. These convert between them.
 */

/** `products/update` → `PRODUCTS_UPDATE`. Already-converted values pass through. */
export function toGraphqlTopic(topic: string): string {
  return topic.trim().toUpperCase().replace(/[/.]/g, '_');
}

/**
 * `PRODUCTS_UPDATE` → `products/update`. Only the first underscore separating
 * the resource from the action is turned back into a slash, which is how
 * Shopify names topics (`inventory_levels/connect` cannot be recovered from
 * the enum alone), so prefer keeping the header spelling where you have it.
 */
export function fromGraphqlTopic(topic: string): string {
  const lower: string = topic.trim().toLowerCase();
  const index: number = lower.lastIndexOf('_');
  return index === -1
    ? lower
    : `${lower.slice(0, index)}/${lower.slice(index + 1)}`;
}
