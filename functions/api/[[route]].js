// Cloudflare Pages Function: every /api/* request goes to the router.
import { handle } from "../_lib/routes.js";

export const onRequest = ({ request, env }) => handle(request, env);
