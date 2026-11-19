import { dispatchGitHubWorkflow, getGitHubWorkflowRunsByRequestId } from '../providers/github-actions.ts';
import type { AgentDispatchRequest, Env } from '../types.ts';

/**
 * Class 1 Executor: Agent models (e.g. Antigravity, deep-research).
 * Dispatches execution to GitHub Actions (ActiveInsighter/Agent-gemeni) so long-running
 * sandbox/tool loops run outside Worker limits.
 */
export async function executeAgentDispatch(env: Env, req: AgentDispatchRequest): Promise<Response> {
  const requestId = req.requestId?.trim() || crypto.randomUUID();
  const inputs: Record<string, string> = {
    request_id: requestId,
    ...(req.model ? { model: req.model } : {}),
    ...(req.thinkingLevel ? { thinking_level: req.thinkingLevel } : {}),
    ...(req.diagnosticSeconds ? { diagnostic_seconds: req.diagnosticSeconds } : {}),
    ...(req.inputs ?? {}),
  };

  const result = await dispatchGitHubWorkflow(env, {
    workflow: req.workflow,
    ref: req.ref,
    inputs,
  });

  return Response.json(
    {
      category: 'agent',
      mode: 'github_actions_dispatch',
      ...result,
    },
    {
      status: 202,
      headers: { 'access-control-allow-origin': '*' },
    },
  );
}

export async function queryAgentDispatchStatus(
  env: Env,
  requestId: string,
  workflow?: string,
): Promise<Response> {
  const status = await getGitHubWorkflowRunsByRequestId(env, requestId, undefined, workflow);
  return Response.json(status, {
    headers: { 'access-control-allow-origin': '*' },
  });
}
