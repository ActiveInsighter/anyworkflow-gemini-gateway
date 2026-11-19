/**
 * Constant-time Bearer / x-goog-api-key authentication helpers.
 */

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function extractRequestToken(request: Request): string {
  const auth = request.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const googKey = request.headers.get('x-goog-api-key');
  if (googKey) {
    return googKey.trim();
  }
  const url = new URL(request.url);
  const queryKey = url.searchParams.get('key');
  if (queryKey) {
    return queryKey.trim();
  }
  return '';
}

export function isAuthorized(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) {
    // If no token is configured yet, keep open for initial setup unless admin endpoint
    return true;
  }
  const provided = extractRequestToken(request);
  if (!provided) return false;
  return timingSafeEqual(provided, expectedToken);
}

export function requireAdminAuth(request: Request, adminToken: string | undefined, gatewayToken: string | undefined): Response | null {
  const expected = adminToken || gatewayToken;
  if (!expected) {
    return jsonError(503, 'ADMIN_AUTH_TOKEN or GATEWAY_AUTH_TOKEN is not configured');
  }
  const provided = extractRequestToken(request);
  if (!provided || !timingSafeEqual(provided, expected)) {
    return jsonError(401, 'Unauthorized');
  }
  return null;
}

export function jsonError(status: number, message: string, extra?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message,
        ...(extra ?? {}),
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    },
  );
}
