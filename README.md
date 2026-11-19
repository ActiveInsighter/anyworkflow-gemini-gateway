# AnyWorkflow Gemini Gateway

基于 **Cloudflare Workers + SQLite Durable Objects** 的统一 AI 网关与调度中心，服务于 `ActiveInsighter/Agent-gemeni`、`AnyWorkflow` 与 `RikkaHub`。

自定义域名：`https://gemini.any1.tech`

## 架构与三类 AI 模型分流

| 类别 | 识别规则 | 执行端 | 说明 |
| --- | --- | --- | --- |
| **1. Agent** | `antigravity*`、`deep-research*`、`agent-*` 或 `/v1/agent/dispatch` | **GitHub Actions** (`Agent-gemeni`) | 长耗时沙盒/工具任务由 Worker 触发 `workflow_dispatch`，跑在 Actions 上 |
| **2. Chat** | 普通对话模型（`gemini-2.5-flash`、`gemini-2.5-pro` 等） | **Cloudflare Worker** | 零冷启动直连上游，原生支持 RikkaHub 官方 Google SSE 流式输出，也兼容 OpenAI `/v1/chat/completions` |
| **3. Decision** | `*decision*` 或 `/v1/decision` | **Cloudflare Worker** | 强制 `application/json` 结构化输出，低延迟完成决策判断 |

## 核心组件

- `src/router/classifier.ts`：三类模型路由分类器。
- `src/durable-objects/key-pool-do.ts`：基于 SQLite Durable Object 的全局密钥轮询池（支持多项目分组配额、RPM 节流、429 指数退避、日配额熔断）。
- `src/durable-objects/scheduler-do.ts`：基于 SQLite Durable Object `alarm()` 的定时调度器（支持 5 位 Cron + 时区、一次性 `runAt`、自动按三类模型分流执行，并支持 Webhook / PocketBase 回写）。
- `src/executors/`：`agent.ts`、`chat.ts`、`decision.ts` 三个完全解耦的执行器。
- `src/providers/`：`gemini.ts`（官方 REST/SSE）、`openai-compat.ts`（OpenAI 协议互转）、`github-actions.ts`（Actions 派发与状态查询）。

## 接口一览

### 1. RikkaHub / 官方 Google Gemini 原生协议（推荐）
- `GET /v1beta/models`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`（与官方完全一致的 SSE 流，保留 `thought`、`thoughtSignature`、`usageMetadata`）

### 2. OpenAI 兼容协议
- `GET /v1/models`
- `POST /v1/chat/completions`（支持 `stream: true`）

### 3. 专用端点
- `POST /v1/agent/dispatch` / `GET /v1/agent/runs/:requestId`：手动派发与查询 Agent Action 任务
- `POST /v1/decision`：结构化 JSON 决策调用
- `GET /healthz`：健康检查

### 4. 管理端点（需 `ADMIN_AUTH_TOKEN` 或 `GATEWAY_AUTH_TOKEN`）
- `GET /admin/keys/status`：查看所有 Key 桶的健康状态、今日用量与冷却倒计时
- `POST /admin/keys/reset`：重置冷却/禁用状态
- `GET /admin/schedules` / `POST /admin/schedules` / `DELETE /admin/schedules/:id` / `POST /admin/schedules/:id/trigger` / `GET /admin/schedules/runs`

## 本地开发与测试

```bash
npm ci
npm run typecheck
npm test
```
