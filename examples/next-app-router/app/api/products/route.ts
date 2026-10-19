// GET /api/products (called by the embedded app's frontend with an App Bridge ID token)
import { authenticateAdmin, unauthorized } from '../../../../embedded.js';
import { listProducts } from '../../../../products.js';
import { context } from '../../context.js';

// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js requires the HTTP method name.
export async function GET(request: Request): Promise<Response> {
  const authenticated: Awaited<ReturnType<typeof authenticateAdmin>> =
    await authenticateAdmin(request, context());
  if (!authenticated.ok) return unauthorized(authenticated.error);

  const products: Awaited<ReturnType<typeof listProducts>> = await listProducts(
    authenticated.value.client
  );
  if (!products.ok)
    return new Response(products.error.message, { status: 502 });
  return Response.json(products.value);
}
