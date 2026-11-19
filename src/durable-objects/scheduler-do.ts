import { DurableObject } from 'cloudflare:workers';
import { executeDecisionModel } from '../executors/decision.ts';
import { postToPocketBase } from '../integrations/pocketbase.ts';
import { callGeminiUpstream } from '../providers/gemini.ts';
import { dispatchGitHubWorkflow } from '../providers/github-actions.ts';
import { classifyModel } from '../router/classifier.ts';
import { nextCronRun, validateTimeZone } from '../schedule/cron.ts';
import type { Env, ModelCategory, ScheduleInput, ScheduleRecord } from '../types.ts';

type ScheduleRow = {
  [key: string]: SqlStorageValue;
  id: string;
  name: string;
  enabled: number;
  cron: string | null;
  run_at: string | null;
  timezone: string;
  category: ModelCategory;
  model: string;
  prompt: string;
  system_prompt: string;
  thinking_level: string;
  schema_json: string | null;
  workflow: string | null;
  webhook_url: string | null;
  pocketbase_job_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function rowToRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    cron: row.cron,
    runAt: row.run_at,
    timezone: row.timezone,
    category: row.category,
    model: row.model,
    prompt: row.prompt,
    systemPrompt: row.system_prompt,
    thinkingLevel: row.thinking_level,
    schemaJson: row.schema_json,
    workflow: row.workflow,
    webhookUrl: row.webhook_url,
    pocketbaseJobId: row.pocketbase_job_id,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SchedulerDO extends DurableObject<Env> {
  private initialized = false;

  private ensureSchema(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron TEXT,
        run_at TEXT,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        category TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        thinking_level TEXT NOT NULL DEFAULT '',
        schema_json TEXT,
        workflow TEXT,
        webhook_url TEXT,
        pocketbase_job_id TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );
    `);
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/schedules') {
        const rows = this.ctx.storage.sql
          .exec<ScheduleRow>(`SELECT * FROM schedules ORDER BY created_at DESC`)
          .toArray();
        return Response.json({ items: rows.map(rowToRecord) });
      }

      if (request.method === 'POST' && url.pathname === '/schedules') {
        const input = (await request.json()) as ScheduleInput;
        const record = await this.upsertSchedule(input);
        return Response.json({ schedule: record }, { status: 201 });
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/schedules/')) {
        const id = url.pathname.slice('/schedules/'.length);
        this.ctx.storage.sql.exec(`DELETE FROM schedules WHERE id = ?`, id);
        await this.syncNextAlarm();
        return Response.json({ deleted: true, id });
      }

      if (request.method === 'POST' && url.pathname.endsWith('/trigger')) {
        const id = url.pathname.slice('/schedules/'.length, -'/trigger'.length);
        const row = this.ctx.storage.sql
          .exec<ScheduleRow>(`SELECT * FROM schedules WHERE id = ?`, id)
          .toArray()[0];
        if (!row) return Response.json({ error: 'Schedule not found' }, { status: 404 });
        const result = await this.executeSchedule(row);
        return Response.json(result);
      }

      if (request.method === 'GET' && url.pathname === '/runs') {
        const scheduleId = url.searchParams.get('scheduleId');
        const rows = scheduleId
          ? this.ctx.storage.sql
              .exec(`SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 50`, scheduleId)
              .toArray()
          : this.ctx.storage.sql
              .exec(`SELECT * FROM schedule_runs ORDER BY started_at DESC LIMIT 50`)
              .toArray();
        return Response.json({ items: rows });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  private async upsertSchedule(input: ScheduleInput): Promise<ScheduleRecord> {
    if (!input.name?.trim() || !input.model?.trim() || !input.prompt?.trim()) {
      throw new Error('name, model, and prompt are required');
    }
    if (!input.cron && !input.runAt) {
      throw new Error('Either cron or runAt must be provided');
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const id = input.id?.trim() || crypto.randomUUID();
    const enabled = input.enabled !== false;
    const timezone = validateTimeZone(input.timezone || 'Asia/Shanghai');
    const category = classifyModel(input.model, input.category);

    let nextRunAt: string | null = null;
    if (enabled) {
      if (input.cron) {
        nextRunAt = nextCronRun(input.cron, timezone, nowMs);
      } else if (input.runAt) {
        const parsed = Date.parse(input.runAt);
        if (!Number.isFinite(parsed)) throw new Error(`Invalid runAt timestamp: ${input.runAt}`);
        nextRunAt = new Date(parsed).toISOString();
      }
    }

    const schemaJson = input.schema ? JSON.stringify(input.schema) : null;

    this.ctx.storage.sql.exec(
      `INSERT INTO schedules (
        id, name, enabled, cron, run_at, timezone, category, model, prompt,
        system_prompt, thinking_level, schema_json, workflow, webhook_url,
        pocketbase_job_id, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        cron = excluded.cron,
        run_at = excluded.run_at,
        timezone = excluded.timezone,
        category = excluded.category,
        model = excluded.model,
        prompt = excluded.prompt,
        system_prompt = excluded.system_prompt,
        thinking_level = excluded.thinking_level,
        schema_json = excluded.schema_json,
        workflow = excluded.workflow,
        webhook_url = excluded.webhook_url,
        pocketbase_job_id = excluded.pocketbase_job_id,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at`,
      id,
      input.name.trim(),
      enabled ? 1 : 0,
      input.cron?.trim() || null,
      input.runAt?.trim() || null,
      timezone,
      category,
      input.model.trim(),
      input.prompt,
      input.systemPrompt || '',
      input.thinkingLevel || '',
      schemaJson,
      input.workflow || null,
      input.webhookUrl || null,
      input.pocketbaseJobId || null,
      nextRunAt,
      nowIso,
      nowIso,
    );

    await this.syncNextAlarm();
    const saved = this.ctx.storage.sql
      .exec<ScheduleRow>(`SELECT * FROM schedules WHERE id = ?`, id)
      .toArray()[0]!;
    return rowToRecord(saved);
  }

  private async syncNextAlarm(): Promise<void> {
    const nextRow = this.ctx.storage.sql
      .exec<{ next_run_at: string }>(
        `SELECT next_run_at FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at ASC LIMIT 1`,
      )
      .toArray()[0];

    if (!nextRow) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const ms = Date.parse(nextRow.next_run_at);
    if (Number.isFinite(ms)) {
      await this.ctx.storage.setAlarm(Math.max(ms, Date.now() + 100));
    }
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const due = this.ctx.storage.sql
      .exec<ScheduleRow>(
        `SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC`,
        nowIso,
      )
      .toArray();

    for (const row of due) {
      // Advance schedule before execution to prevent duplicate runs
      if (row.cron) {
        try {
          const nextIso = nextCronRun(row.cron, row.timezone, nowMs);
          this.ctx.storage.sql.exec(
            `UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?`,
            nextIso,
            nowIso,
            row.id,
          );
        } catch (err) {
          this.ctx.storage.sql.exec(
            `UPDATE schedules SET enabled = 0, next_run_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
            err instanceof Error ? err.message : String(err),
            nowIso,
            row.id,
          );
        }
      } else {
        this.ctx.storage.sql.exec(
          `UPDATE schedules SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?`,
          nowIso,
          row.id,
        );
      }

      await this.executeSchedule(row);
    }

    await this.syncNextAlarm();
  }

  private async executeSchedule(row: ScheduleRow): Promise<unknown> {
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    let status = 'succeeded';
    let output: unknown = null;
    let errorMsg: string | null = null;

    try {
      if (row.category === 'agent') {
        output = await dispatchGitHubWorkflow(this.env, {
          workflow: row.workflow || undefined,
          inputs: {
            request_id: row.pocketbase_job_id || `sched-${row.id}-${Date.now()}`,
            model: row.model,
            ...(row.thinking_level ? { thinking_level: row.thinking_level } : {}),
          },
        });
      } else if (row.category === 'decision') {
        const schema = row.schema_json ? (JSON.parse(row.schema_json) as Record<string, unknown>) : undefined;
        const res = await executeDecisionModel(this.env, {
          model: row.model,
          prompt: row.prompt,
          systemPrompt: row.system_prompt || undefined,
          thinkingLevel: row.thinking_level || undefined,
          schema,
        });
        if (res.status >= 400) {
          status = 'failed';
          errorMsg = JSON.stringify(res.data);
        }
        output = res.data;
      } else {
        const payload: Record<string, unknown> = {
          contents: [{ role: 'user', parts: [{ text: row.prompt }] }],
        };
        if (row.system_prompt) {
          payload.systemInstruction = { parts: [{ text: row.system_prompt }] };
        }
        const upstream = await callGeminiUpstream(this.env, {
          model: row.model,
          action: 'generateContent',
          body: payload,
        });
        const data = await upstream.json().catch(() => null);
        if (!upstream.ok) {
          status = 'failed';
          errorMsg = JSON.stringify(data);
        }
        output = data;
      }

      if (row.webhook_url) {
        await fetch(row.webhook_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scheduleId: row.id, name: row.name, status, output, error: errorMsg }),
        }).catch(() => {});
      }

      if (row.pocketbase_job_id && row.category !== 'agent') {
        await postToPocketBase(this.env, `/api/anyworkflow/gemini/jobs/${row.pocketbase_job_id}/settle`, {
          status,
          output,
          error: errorMsg,
        }).catch(() => {});
      }
    } catch (err) {
      status = 'failed';
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    const finishedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE schedules SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      finishedAt,
      status,
      errorMsg,
      finishedAt,
      row.id,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO schedule_runs (id, schedule_id, category, status, output_json, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      row.id,
      row.category,
      status,
      output ? JSON.stringify(output).slice(0, 64_000) : null,
      errorMsg,
      startedAt,
      finishedAt,
    );
    // Keep table bounded to latest 200 runs
    this.ctx.storage.sql.exec(
      `DELETE FROM schedule_runs WHERE id NOT IN (SELECT id FROM schedule_runs ORDER BY started_at DESC LIMIT 200)`,
    );

    return { runId, scheduleId: row.id, category: row.category, status, output, error: errorMsg };
  }
}
