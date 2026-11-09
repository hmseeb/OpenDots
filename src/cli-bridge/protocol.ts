import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// OpenAI Chat Completions subset that OpenDots (TanStack AI + research.ts) sends.
const part = z.object({ type: z.string(), text: z.string().optional() });
const content = z.union([z.string(), z.array(part), z.null()]).optional();
export const chatRequest = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
        content,
        tool_call_id: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.unknown().optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z.unknown().optional(),
});
export type ChatRequest = z.infer<typeof chatRequest>;

export interface Turn {
  text: string;
  tool_calls: { name: string; arguments: string }[];
}

export function parseModel(model: string): {
  cli: 'claude' | 'codex';
  model?: string;
} {
  const [cli, ...rest] = model.split(':');
  if (cli !== 'claude' && cli !== 'codex')
    throw new Error(
      `Model must start with "claude:" or "codex:" (got "${model}").`,
    );
  const name = rest.join(':');
  return { cli, model: name && name !== 'default' ? name : undefined };
}

const text = (value: z.infer<typeof content>) =>
  typeof value === 'string'
    ? value
    : (value ?? []).map((p) => p.text ?? '').join('');

/** JSON schema the CLI must answer with; tool names are restricted when tools exist. */
export function turnSchema(request: ChatRequest) {
  const names = toolsAllowed(request)
    ? request.tools!.map((t) => t.function.name)
    : [];
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      tool_calls: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: names.length
              ? { type: 'string', enum: names }
              : { type: 'string' },
            arguments: { type: 'string' },
          },
          required: ['name', 'arguments'],
        },
      },
    },
    required: ['text', 'tool_calls'],
  };
}

export function toolsAllowed(request: ChatRequest) {
  return !!request.tools?.length && request.tool_choice !== 'none';
}

/** Splits the OpenAI conversation into a system prompt and a plain transcript. */
export function buildPrompt(request: ChatRequest): {
  system: string;
  prompt: string;
} {
  const system: string[] = [
    'You are the language model behind an OpenAI-compatible Chat Completions API.',
    'You have NO built-in tools: never run commands, read files, or browse. Answer only through the required JSON schema.',
  ];
  if (toolsAllowed(request)) {
    system.push(
      'The application exposes the functions below. To call one, add {"name", "arguments"} to tool_calls, where arguments is a JSON-encoded string that matches its parameters. You may call several at once. The application runs them and sends results back in the next turn, so when you call tools put at most one short sentence in text. When no function is needed, answer in text and leave tool_calls empty. Never repeat text that an earlier assistant turn in the transcript already said; continue from it.',
      request.tool_choice === 'required'
        ? 'You must call at least one function in this turn.'
        : '',
      `Functions: ${JSON.stringify(
        request.tools!.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      )}`,
    );
  } else system.push('Answer in text and leave tool_calls empty.');
  const transcript: string[] = [];
  for (const m of request.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(text(m.content));
      continue;
    }
    if (m.role === 'tool') {
      transcript.push(
        `[tool result for ${m.tool_call_id ?? 'call'}]\n${text(m.content)}`,
      );
      continue;
    }
    const body = text(m.content);
    if (body) transcript.push(`[${m.role}]\n${body}`);
    for (const call of m.tool_calls ?? [])
      transcript.push(
        `[assistant called ${call.function.name} as ${call.id}]\n${call.function.arguments}`,
      );
  }
  transcript.push('[write the next assistant turn]');
  return {
    system: system.filter(Boolean).join('\n\n'),
    prompt: transcript.join('\n\n'),
  };
}

export function parseTurn(raw: unknown): Turn {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const parsed = z
    .object({
      text: z.string().default(''),
      tool_calls: z
        .array(z.object({ name: z.string(), arguments: z.unknown() }))
        .default([]),
    })
    .parse(value);
  return {
    text: parsed.text,
    tool_calls: parsed.tool_calls.map((c) => ({
      name: c.name,
      arguments:
        typeof c.arguments === 'string'
          ? c.arguments
          : JSON.stringify(c.arguments ?? {}),
    })),
  };
}

export function completion(model: string, turn: Turn) {
  const calls = turn.tool_calls.map((c) => ({
    id: `call_${randomUUID().replace(/-/g, '')}`,
    type: 'function' as const,
    function: c,
  }));
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: calls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** The whole turn as OpenAI SSE chunks (the CLIs return a finished turn, not tokens). */
export function streamChunks(model: string, turn: Turn): string {
  const done = completion(model, turn);
  const message = done.choices[0].message;
  const base = {
    id: done.id,
    object: 'chat.completion.chunk',
    created: done.created,
    model,
  };
  const chunks = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            ...(message.content ? { content: message.content } : {}),
            ...(message.tool_calls
              ? {
                  tool_calls: message.tool_calls.map((call, index) => ({
                    index,
                    ...call,
                  })),
                }
              : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: done.choices[0].finish_reason },
      ],
    },
    { ...base, choices: [], usage: done.usage },
  ];
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}
