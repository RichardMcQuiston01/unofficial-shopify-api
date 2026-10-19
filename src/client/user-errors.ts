import { UserError, type UserErrorDetail } from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';

/** Any mutation payload that may carry `userErrors`. */
export interface WithUserErrors {
  readonly userErrors?: readonly UserErrorDetail[] | null;
}

/**
 * Shopify reports validation failures inside a successful HTTP 200 response
 * as `userErrors`. This turns a non-empty list into an `Err`.
 */
export function checkUserErrors<T extends WithUserErrors>(
  payload: T,
  operation: string
): Result<T, UserError> {
  const userErrors: readonly UserErrorDetail[] = payload.userErrors ?? [];
  if (userErrors.length === 0) return ok(payload);
  const summary: string = userErrors
    .map((detail: UserErrorDetail): string => {
      const field: string =
        detail.field !== null && detail.field !== undefined
          ? ` (${detail.field.join('.')})`
          : '';
      return `${detail.message}${field}`;
    })
    .join('; ');
  return err(
    new UserError(`${operation} was rejected by Shopify: ${summary}`, {
      userErrors,
      context: { operation },
    })
  );
}
