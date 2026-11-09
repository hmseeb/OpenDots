import { expect, it } from 'vitest';
import {
  buildPrompt,
  chatRequest,
  completion,
  parseModel,
  parseTurn,
  streamChunks,
  turnSchema,
} from '../src/cli-bridge/protocol.js';

const request = chatRequest.parse({
  model: 'claude:opus',
  stream: true,
  messages: [
    { role: 'system', content: 'Be Dot.' },
    { role: 'user', content: [{ type: 'text', text: 'Save a page' }] },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'save', arguments: '{"t":"x"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'saved' },
  ],
  tools: [
    {
      type: 'function',
      function: { name: 'save', parameters: { type: 'object' } },
    },
  ],
});

it('routes model prefixes to the right CLI', () => {
  expect(parseModel('claude:opus')).toEqual({ cli: 'claude', model: 'opus' });
  expect(parseModel('codex:default')).toEqual({
    cli: 'codex',
    model: undefined,
  });
  expect(() => parseModel('gpt-4o')).toThrow(/claude:|codex:/);
});

it('renders system, tools and the tool round-trip into the prompt', () => {
  const { system, prompt } = buildPrompt(request);
  expect(system).toContain('Be Dot.');
  expect(system).toContain('"name":"save"');
  expect(prompt).toContain('[user]\nSave a page');
  expect(prompt).toContain('[assistant called save as c1]\n{"t":"x"}');
  expect(prompt).toContain('[tool result for c1]\nsaved');
  expect(
    turnSchema(request).properties.tool_calls.items.properties.name,
  ).toEqual({
    type: 'string',
    enum: ['save'],
  });
});

it('maps a CLI turn to OpenAI tool calls, both whole and streamed', () => {
  const turn = parseTurn(
    '{"text":"","tool_calls":[{"name":"save","arguments":{"t":"y"}}]}',
  );
  expect(turn.tool_calls[0].arguments).toBe('{"t":"y"}');
  const done = completion('claude:opus', turn);
  expect(done.choices[0].finish_reason).toBe('tool_calls');
  expect(done.choices[0].message.content).toBeNull();
  const sse = streamChunks('claude:opus', turn);
  expect(sse).toContain('"tool_calls":[{"index":0,');
  expect(sse.trim().endsWith('data: [DONE]')).toBe(true);
  expect(
    completion('m', parseTurn({ text: 'hi', tool_calls: [] })).choices[0]
      .finish_reason,
  ).toBe('stop');
});
