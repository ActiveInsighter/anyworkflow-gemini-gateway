import type { Env } from '../types.ts';

export async function postToPocketBase(
  env: Env,
  path: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number; body?: unknown }> {
  const baseUrl = (env.POCKETBASE_URL || '').replace(/\/+$/, '');
  const token = env.POCKETBASE_SERVER_TOKEN;
  if (!baseUrl || !token) {
    return { ok: false, status: 0, body: 'PocketBase not configured' };
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: token,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => '');
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { ok: res.ok, status: res.status, body };
}
