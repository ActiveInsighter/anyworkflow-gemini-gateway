import { DurableObject } from 'cloudflare:workers';
import type { Env, KeyLease, KeyReportInput } from '../types.ts';
import {
  classifyUpstreamError,
  computeCooldownMs,
  maskApiKey,
  parseApiKeys,
  parseKeyGroups,
} from './key-pool-logic.ts';

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

type KeyRow = {
  [key: string]: SqlStorageValue;
  key_hash: string;
  bucket_id: string;
  key_index: number;
  minute_window_start: number;
  minute_count: number;
  day_key: string;
  day_count: number;
  cooldown_until: number;
  consecutive_429: number;
  exhausted_day: string;
  disabled_reason: string;
  last_used_at: number;
  total_requests: number;
  total_errors: number;
};

export class KeyPoolDO extends DurableObject<Env> {
  private initialized = false;

  private ensureSchema(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS key_state (
        key_hash TEXT PRIMARY KEY,
        bucket_id TEXT NOT NULL,
        key_index INTEGER NOT NULL,
        minute_window_start INTEGER NOT NULL DEFAULT 0,
        minute_count INTEGER NOT NULL DEFAULT 0,
        day_key TEXT NOT NULL DEFAULT '',
        day_count INTEGER NOT NULL DEFAULT 0,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        consecutive_429 INTEGER NOT NULL DEFAULT 0,
        exhausted_day TEXT NOT NULL DEFAULT '',
        disabled_reason TEXT NOT NULL DEFAULT '',
        last_used_at INTEGER NOT NULL DEFAULT 0,
        total_requests INTEGER NOT NULL DEFAULT 0,
        total_errors INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.initialized = true;
  }

  private async syncKeysFromEnv(): Promise<Array<{ key: string; keyHash: string; bucketId: string; index: number }>> {
    this.ensureSchema();
    const keys = parseApiKeys(this.env.GEMINI_API_KEYS);
    const groups = parseKeyGroups(keys.length, this.env.GEMINI_KEY_GROUPS);
    const entries: Array<{ key: string; keyHash: string; bucketId: string; index: number }> = [];

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const bucketId = groups[i] ?? `key:${i}`;
      const keyHash = await sha256Hex(key);
      entries.push({ key, keyHash, bucketId, index: i });
      this.ctx.storage.sql.exec(
        `INSERT INTO key_state (key_hash, bucket_id, key_index)
         VALUES (?, ?, ?)
         ON CONFLICT(key_hash) DO UPDATE SET bucket_id = excluded.bucket_id, key_index = excluded.key_index`,
        keyHash,
        bucketId,
        i,
      );
    }
    return entries;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/lease') {
        const body = (await request.json().catch(() => ({}))) as { excludeHashes?: string[] };
        const lease = await this.leaseKey(new Set(body.excludeHashes ?? []));
        return Response.json(lease);
      }

      if (request.method === 'POST' && url.pathname === '/report') {
        const body = (await request.json()) as KeyReportInput;
        await this.reportOutcome(body);
        return Response.json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/status') {
        const status = await this.getStatus();
        return Response.json(status);
      }

      if (request.method === 'POST' && url.pathname === '/reset') {
        await this.resetAll();
        return Response.json({ ok: true });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 503 });
    }
  }

  private async leaseKey(excludeHashes: Set<string>): Promise<KeyLease> {
    const entries = await this.syncKeysFromEnv();
    if (entries.length === 0) {
      throw new Error('GEMINI_API_KEYS is not configured');
    }

    const now = Date.now();
    const today = utcDayKey(now);
    const rpmLimit = Math.max(1, Number.parseInt(this.env.KEY_POOL_RPM_PER_KEY || '15', 10) || 15);
    const rpdLimit = Math.max(1, Number.parseInt(this.env.KEY_POOL_RPD_PER_KEY || '1500', 10) || 1500);

    const entryByHash = new Map(entries.map((e) => [e.keyHash, e]));
    const rows = this.ctx.storage.sql
      .exec<KeyRow>(`SELECT * FROM key_state`)
      .toArray()
      .filter((r) => entryByHash.has(r.key_hash));

    // Aggregate bucket-level usage for shared-project groups
    const bucketMinuteUsage = new Map<string, number>();
    const bucketDayUsage = new Map<string, number>();
    const bucketCooldown = new Map<string, number>();

    for (const row of rows) {
      const mCount = now - row.minute_window_start < 60_000 ? row.minute_count : 0;
      const dCount = row.day_key === today ? row.day_count : 0;
      bucketMinuteUsage.set(row.bucket_id, (bucketMinuteUsage.get(row.bucket_id) ?? 0) + mCount);
      bucketDayUsage.set(row.bucket_id, (bucketDayUsage.get(row.bucket_id) ?? 0) + dCount);
      bucketCooldown.set(row.bucket_id, Math.max(bucketCooldown.get(row.bucket_id) ?? 0, row.cooldown_until));
    }

    const candidates = rows.filter((row) => {
      if (excludeHashes.has(row.key_hash)) return false;
      if (row.disabled_reason) return false;
      if (row.exhausted_day === today) return false;
      const dUsed = bucketDayUsage.get(row.bucket_id) ?? 0;
      if (dUsed >= rpdLimit) return false;
      return true;
    });

    if (candidates.length === 0) {
      throw new Error('All configured Gemini API keys are exhausted or disabled');
    }

    // Separate immediately ready keys vs cooling/throttled keys
    const ready = candidates.filter((row) => {
      const cooldown = Math.max(row.cooldown_until, bucketCooldown.get(row.bucket_id) ?? 0);
      const mUsed = bucketMinuteUsage.get(row.bucket_id) ?? 0;
      return cooldown <= now && mUsed < rpmLimit;
    });

    let chosen: KeyRow;
    let waitMs = 0;

    if (ready.length > 0) {
      // Pick least-used today, tie-break by longest idle (oldest last_used_at)
      ready.sort((a, b) => {
        const da = bucketDayUsage.get(a.bucket_id) ?? 0;
        const db = bucketDayUsage.get(b.bucket_id) ?? 0;
        if (da !== db) return da - db;
        return a.last_used_at - b.last_used_at;
      });
      chosen = ready[0]!;
    } else {
      // Pick the candidate with earliest availability
      candidates.sort((a, b) => {
        const ca = Math.max(a.cooldown_until, bucketCooldown.get(a.bucket_id) ?? 0);
        const cb = Math.max(b.cooldown_until, bucketCooldown.get(b.bucket_id) ?? 0);
        return ca - cb;
      });
      chosen = candidates[0]!;
      const cooldownUntil = Math.max(chosen.cooldown_until, bucketCooldown.get(chosen.bucket_id) ?? 0);
      waitMs = Math.max(0, cooldownUntil - now);
    }

    const entry = entryByHash.get(chosen.key_hash)!;
    const sameMinute = now - chosen.minute_window_start < 60_000;
    const nextMinStart = sameMinute ? chosen.minute_window_start : now;
    const nextMinCount = sameMinute ? chosen.minute_count + 1 : 1;
    const nextDayCount = chosen.day_key === today ? chosen.day_count + 1 : 1;

    this.ctx.storage.sql.exec(
      `UPDATE key_state
       SET minute_window_start = ?, minute_count = ?, day_key = ?, day_count = ?,
           last_used_at = ?, total_requests = total_requests + 1
       WHERE key_hash = ?`,
      nextMinStart,
      nextMinCount,
      today,
      nextDayCount,
      now,
      chosen.key_hash,
    );

    return {
      key: entry.key,
      bucketId: chosen.bucket_id,
      keyHash: chosen.key_hash,
      waitMs,
    };
  }

  private async reportOutcome(input: KeyReportInput): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    const today = utcDayKey(now);

    if (input.status >= 200 && input.status < 300) {
      this.ctx.storage.sql.exec(
        `UPDATE key_state SET consecutive_429 = 0, cooldown_until = 0 WHERE key_hash = ?`,
        input.keyHash,
      );
      return;
    }

    const kind = classifyUpstreamError(input.status, input.errorPayload);
    if (kind === 'none') return;

    const row = this.ctx.storage.sql
      .exec<KeyRow>(`SELECT * FROM key_state WHERE key_hash = ?`, input.keyHash)
      .toArray()[0];
    if (!row) return;

    if (kind === 'permanent_invalid') {
      this.ctx.storage.sql.exec(
        `UPDATE key_state SET disabled_reason = ?, total_errors = total_errors + 1 WHERE key_hash = ?`,
        `http_${input.status}`,
        input.keyHash,
      );
      return;
    }

    if (kind === 'daily_exhausted') {
      this.ctx.storage.sql.exec(
        `UPDATE key_state SET exhausted_day = ?, total_errors = total_errors + 1 WHERE key_hash = ?`,
        today,
        input.keyHash,
      );
      return;
    }

    const cooldownMs = computeCooldownMs(row.consecutive_429, input.retryAfterSeconds);
    this.ctx.storage.sql.exec(
      `UPDATE key_state
       SET cooldown_until = ?, consecutive_429 = consecutive_429 + 1, total_errors = total_errors + 1
       WHERE key_hash = ?`,
      now + cooldownMs,
      input.keyHash,
    );
  }

  private async getStatus(): Promise<unknown> {
    const entries = await this.syncKeysFromEnv();
    const now = Date.now();
    const today = utcDayKey(now);
    const entryByHash = new Map(entries.map((e) => [e.keyHash, e]));
    const rows = this.ctx.storage.sql
      .exec<KeyRow>(`SELECT * FROM key_state ORDER BY key_index ASC`)
      .toArray()
      .filter((r) => entryByHash.has(r.key_hash));

    return {
      totalKeys: rows.length,
      today,
      keys: rows.map((r) => {
        const entry = entryByHash.get(r.key_hash)!;
        const coolingDown = r.cooldown_until > now;
        const exhaustedToday = r.exhausted_day === today;
        return {
          index: r.key_index,
          keyHash: r.key_hash,
          maskedKey: maskApiKey(entry.key),
          bucketId: r.bucket_id,
          healthy: !r.disabled_reason && !exhaustedToday && !coolingDown,
          disabledReason: r.disabled_reason || null,
          exhaustedToday,
          cooldownRemainingSec: coolingDown ? Math.ceil((r.cooldown_until - now) / 1000) : 0,
          dayCount: r.day_key === today ? r.day_count : 0,
          totalRequests: r.total_requests,
          totalErrors: r.total_errors,
          lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
        };
      }),
    };
  }

  private async resetAll(): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `UPDATE key_state SET cooldown_until = 0, consecutive_429 = 0, exhausted_day = '', disabled_reason = ''`,
    );
  }
}
