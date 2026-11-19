/**
 * Translates OpenAI /v1/chat/completions requests & responses to/from Google Gemini format.
 */

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'developer';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  reasoning_effort?: string;
}

function extractTextContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n');
}

export function openAIToGeminiRequest(body: OpenAIChatRequest): Record<string, unknown> {
  const systemParts: Array<{ text: string }> = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  for (const msg of body.messages ?? []) {
    const text = extractTextContent(msg.content);
    if (!text) continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      systemParts.push({ text });
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      });
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.max_tokens === 'number') generationConfig.maxOutputTokens = body.max_tokens;
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;

  const payload: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    payload.systemInstruction = { parts: systemParts };
  }
  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }
  return payload;
}

export function geminiToOpenAIResponse(geminiData: Record<string, unknown>, model: string): Record<string, unknown> {
  const candidates = (geminiData.candidates as Array<Record<string, unknown>> | undefined) ?? [];
  const first = candidates[0] ?? {};
  const contentObj = (first.content as Record<string, unknown> | undefined) ?? {};
  const parts = (contentObj.parts as Array<Record<string, unknown>> | undefined) ?? [];

  let text = '';
  let reasoning = '';
  for (const part of parts) {
    if (typeof part.text !== 'string') continue;
    if (part.thought === true) {
      reasoning += part.text;
    } else {
      text += part.text;
    }
  }

  const finishReasonRaw = String(first.finishReason ?? 'STOP').toUpperCase();
  const finishReason = finishReasonRaw === 'MAX_TOKENS' ? 'length' : 'stop';
  const usageMeta = (geminiData.usageMetadata as Record<string, number> | undefined) ?? {};

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: usageMeta.promptTokenCount ?? 0,
      completion_tokens: usageMeta.candidatesTokenCount ?? 0,
      total_tokens: usageMeta.totalTokenCount ?? 0,
    },
  };
}

/**
 * Converts a Google Gemini SSE stream into an OpenAI-compatible SSE stream.
 */
export function transformGeminiSseToOpenAISse(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sepIdx: number;
          while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);

            for (const line of frame.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payloadStr = trimmed.slice(5).trim();
              if (!payloadStr || payloadStr === '[DONE]') continue;

              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(payloadStr) as Record<string, unknown>;
              } catch {
                continue;
              }

              const candidates = (parsed.candidates as Array<Record<string, unknown>> | undefined) ?? [];
              const first = candidates[0];
              if (!first) continue;

              const parts =
                ((first.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined) ?? [];

              let contentDelta = '';
              let reasoningDelta = '';
              for (const part of parts) {
                if (typeof part.text !== 'string') continue;
                if (part.thought === true) reasoningDelta += part.text;
                else contentDelta += part.text;
              }

              const delta: Record<string, unknown> = {};
              if (reasoningDelta) delta.reasoning_content = reasoningDelta;
              if (contentDelta) delta.content = contentDelta;

              const finishRaw = first.finishReason ? String(first.finishReason).toUpperCase() : null;
              const finishReason = finishRaw === 'MAX_TOKENS' ? 'length' : finishRaw ? 'stop' : null;

              const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta,
                    finish_reason: finishReason,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
