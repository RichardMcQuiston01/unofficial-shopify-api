// GET /api/auth/install?shop=example.myshopify.com
import { beginInstall } from '../../../../../oauth.js';
import { context } from '../../../context.js';

export const GET = (request: Request): Response =>
  beginInstall(request, context());
