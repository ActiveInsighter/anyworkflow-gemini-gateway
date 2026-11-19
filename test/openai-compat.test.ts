import assert from 'node:assert/strict';
import test from 'node:test';
import {
  geminiToOpenAIResponse,
  openAIToGeminiRequest,
  transformGeminiSseToOpenAISse,
} from '../src/providers/openai-compat.ts';

test('openAIToGeminiRequest maps system and user/assistant turns', () => {
  const res = openAIToGeminiRequest({
    model: 'gemini-2.5-flash',
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ],
  });
  assert.deepEqual(res.systemInstruction, { parts: [{ text: 'Be concise.' }] });
  assert.equal((res.contents as Array<unknown>).length, 3);
  assert.deepEqual(res.generationConfig, { temperature: 0.3 });
});

test('geminiToOpenAIResponse extracts thought and answer text', () => {
  const res = geminiToOpenAIResponse(
    {
      candidates: [
        {
          content: {
            parts: [
              { text: 'thinking...', thought: true },
              { text: 'final answer' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
    'gemini-2.5-flash',
  );
  const choices = res.choices as Array<{ message: { content: string; reasoning_content?: string }; finish_reason: string }>;
  assert.equal(choices[0]?.message.content, 'final answer');
  assert.equal(choices[0]?.message.reasoning_content, 'thinking...');
  assert.equal(choices[0]?.finish_reason, 'stop');
});

test('transformGeminiSseToOpenAISse streams chunks and terminates with [DONE]', async () => {
  const encoder = new TextEncoder();
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\n' +
            'data: {"candidates":[{"content":{"parts":[{"text":"world"}]},"finishReason":"STOP"}]}\n\n',
        ),
      );
      controller.close();
    },
  });

  const outStream = transformGeminiSseToOpenAISse(input, 'gemini-2.5-flash');
  const text = await new Response(outStream).text();
  assert.match(text, /"content":"Hello "/);
  assert.match(text, /"content":"world"/);
  assert.match(text, /data: \[DONE\]/);
});
