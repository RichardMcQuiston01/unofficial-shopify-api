// POST /api/webhooks
import { createWebhookHandler } from '../../../../webhooks.js';
import { context } from '../../context.js';

// Build the handler once so its delivery log survives between requests.
const handle: (request: Request) => Promise<Response> =
  createWebhookHandler(context());

export const POST = (request: Request): Promise<Response> => handle(request);
