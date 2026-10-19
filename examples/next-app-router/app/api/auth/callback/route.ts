// GET /api/auth/callback (the redirect URL registered in the Dev Dashboard)
import { finishInstall } from '../../../../../oauth.js';
import { context } from '../../../context.js';

export const GET = (request: Request): Promise<Response> =>
  finishInstall(request, context());
