export type ModelCategory = 'agent' | 'chat' | 'decision';

export interface Env {
  KEY_POOL: DurableObjectNamespace;
  SCHEDULER: DurableObjectNamespace;

  // Public vars
  GEMINI_API_BASE: string;
  GITHUB_AGENT_REPO: string;
  GITHUB_AGENT_WORKFLOW: string;
  GITHUB_AGENT_REF: string;
  POCKETBASE_URL: string;
  DEFAULT_DECISION_MODEL: string;
  KEY_POOL_RPM_PER_KEY: string;
  KEY_POOL_RPD_PER_KEY: string;
  GEMINI_KEY_GROUPS?: string;

  // Secrets (configured via `wrangler secret put` or GitHub Actions)
  GEMINI_API_KEYS?: string;
  GATEWAY_AUTH_TOKEN?: string;
  ADMIN_AUTH_TOKEN?: string;
  GITHUB_ACTIONS_TOKEN?: string;
  POCKETBASE_SERVER_TOKEN?: string;
}

export interface KeyLease {
  key: string;
  bucketId: string;
  keyHash: string;
  waitMs: number;
}

export interface KeyReportInput {
  keyHash: string;
  status: number;
  retryAfterSeconds?: number;
  errorPayload?: unknown;
}

export interface AgentDispatchRequest {
  requestId?: string;
  model?: string;
  workflow?: string;
  ref?: string;
  diagnosticSeconds?: string;
  thinkingLevel?: string;
  prompt?: string;
  inputs?: Record<string, string>;
}

export interface DecisionRequest {
  model?: string;
  systemPrompt?: string;
  prompt: string;
  schema?: Record<string, unknown>;
  thinkingLevel?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ScheduleInput {
  id?: string;
  name: string;
  enabled?: boolean;
  cron?: string;
  runAt?: string;
  timezone?: string;
  category?: ModelCategory;
  model: string;
  prompt: string;
  systemPrompt?: string;
  thinkingLevel?: string;
  schema?: Record<string, unknown>;
  workflow?: string;
  webhookUrl?: string;
  pocketbaseJobId?: string;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  category: ModelCategory;
  model: string;
  prompt: string;
  systemPrompt: string;
  thinkingLevel: string;
  schemaJson: string | null;
  workflow: string | null;
  webhookUrl: string | null;
  pocketbaseJobId: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
