import type { Env } from '../types.ts';

export interface DispatchWorkflowParams {
  repo?: string;
  workflow?: string;
  ref?: string;
  inputs: Record<string, string>;
}

export interface DispatchWorkflowResult {
  dispatched: true;
  repo: string;
  workflow: string;
  ref: string;
  requestId: string;
}

export async function dispatchGitHubWorkflow(
  env: Env,
  params: DispatchWorkflowParams,
): Promise<DispatchWorkflowResult> {
  const token = env.GITHUB_ACTIONS_TOKEN;
  if (!token) {
    throw new Error('GITHUB_ACTIONS_TOKEN secret is not configured');
  }

  const repo = params.repo || env.GITHUB_AGENT_REPO || 'ActiveInsighter/Agent-gemeni';
  const workflow = params.workflow || env.GITHUB_AGENT_WORKFLOW || 'gemini-text.yml';
  const ref = params.ref || env.GITHUB_AGENT_REF || 'main';
  const requestId = params.inputs.request_id || crypto.randomUUID();

  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'anyworkflow-gemini-gateway/1.0',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ref,
      inputs: {
        ...params.inputs,
        request_id: requestId,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub workflow_dispatch failed (${res.status}): ${errText}`);
  }

  return {
    dispatched: true,
    repo,
    workflow,
    ref,
    requestId,
  };
}

export async function getGitHubWorkflowRunsByRequestId(
  env: Env,
  requestId: string,
  repoOverride?: string,
  workflowOverride?: string,
): Promise<unknown> {
  const token = env.GITHUB_ACTIONS_TOKEN;
  if (!token) {
    throw new Error('GITHUB_ACTIONS_TOKEN secret is not configured');
  }
  const repo = repoOverride || env.GITHUB_AGENT_REPO || 'ActiveInsighter/Agent-gemeni';
  const workflow = workflowOverride || env.GITHUB_AGENT_WORKFLOW || 'gemini-text.yml';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=20`;

  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'anyworkflow-gemini-gateway/1.0',
      'x-github-api-version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub list runs failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    workflow_runs?: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
      updated_at: string;
    }>;
  };

  const matched = (data.workflow_runs ?? []).filter((r) => r.name.includes(requestId));
  return {
    requestId,
    repo,
    workflow,
    runs: matched.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      htmlUrl: r.html_url,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  };
}
