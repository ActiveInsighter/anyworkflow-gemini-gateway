const BASE_COOLDOWN_MS = 20_000;
const MAX_COOLDOWN_MS = 300_000;

export type QuotaErrorKind = 'rate_limit' | 'daily_exhausted' | 'permanent_invalid' | 'none';

export function parseApiKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Parses group assignments like "0:proj-a,1:proj-a,2:proj-b" or "proj-a,proj-a,proj-b".
 * Keys without an explicit group get their own isolated bucket (`key:<index>`).
 */
export function parseKeyGroups(keyCount: number, rawGroups: string | undefined): string[] {
  const buckets = Array.from({ length: keyCount }, (_, i) => `key:${i}`);
  if (!rawGroups || !rawGroups.trim()) return buckets;

  const trimmed = rawGroups.trim();
  const tokens = trimmed.split(/[\s,;]+/).filter(Boolean);
  if (tokens.every((t) => t.includes(':'))) {
    for (const token of tokens) {
      const [idxRaw, group] = token.split(':', 2);
      const idx = Number.parseInt(idxRaw ?? '', 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < keyCount && group) {
        buckets[idx] = `group:${group.trim()}`;
      }
    }
    return buckets;
  }

  for (let i = 0; i < Math.min(keyCount, tokens.length); i++) {
    const g = tokens[i];
    if (g) buckets[i] = `group:${g.trim()}`;
  }
  return buckets;
}

export function classifyUpstreamError(status: number, payload: unknown): QuotaErrorKind {
  if (status === 400 || status === 401 || status === 403) {
    const text = JSON.stringify(payload ?? '').toLowerCase();
    if (
      status === 401 ||
      text.includes('api_key_invalid') ||
      text.includes('api key not valid') ||
      text.includes('permission_denied') ||
      text.includes('account_deactivated')
    ) {
      return 'permanent_invalid';
    }
    return 'none';
  }

  if (status === 429) {
    const text = JSON.stringify(payload ?? '').toLowerCase();
    if (
      text.includes('perday') ||
      text.includes('per_day') ||
      text.includes('daily') ||
      text.includes('rpd') ||
      text.includes('generaterequestsperday')
    ) {
      return 'daily_exhausted';
    }
    return 'rate_limit';
  }

  return 'none';
}

export function computeCooldownMs(consecutive429: number, retryAfterSeconds?: number): number {
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.ceil(retryAfterSeconds * 1000), MAX_COOLDOWN_MS);
  }
  const exp = Math.min(Math.max(consecutive429, 0), 5);
  return Math.min(BASE_COOLDOWN_MS * Math.pow(2, exp), MAX_COOLDOWN_MS);
}

export function maskApiKey(key: string): string {
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
