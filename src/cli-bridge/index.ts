import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPrompt,
  chatRequest,
  completion,
  parseModel,
  parseTurn,
  streamChunks,
  toolsAllowed,
  turnSchema,
  type ChatRequest,
  type Turn,
} from './protocol.js';

// Local OpenAI-compatible endpoint backed by the owner's logged-in `claude` / `codex` CLIs.
const secret = process.env.CLI_BRIDGE_SECRET;
if (!secret || secret.length < 24)
  throw new Error('CLI_BRIDGE_SECRET must be at least 24 characters.');
const host = process.env.CLI_BRIDGE_HOST ?? '127.0.0.1';
const port = Number(process.env.CLI_BRIDGE_PORT ?? 4321);
const timeoutMs = Number(process.env.CLI_BRIDGE_TIMEOUT_MS ?? 180_000);

function run(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              `${command} exited with ${code}: ${(err || out).slice(-600)}`,
            ),
          ),
    );
    child.stdin.end(input);
  });
}

async function turn(request: ChatRequest, signal: AbortSignal): Promise<Turn> {
  const { cli, model } = parseModel(request.model);
  const { system, prompt } = buildPrompt(request);
  const schema = JSON.stringify(turnSchema(request));
  // Empty working directory: the CLIs must not pick up project files or instructions.
  const cwd = await mkdtemp(join(tmpdir(), 'opendots-cli-'));
  try {
    if (cli === 'claude') {
      const out = await run(
        'claude',
        [
          '-p',
          '--output-format',
          'json',
          ...(model ? ['--model', model] : []),
          '--tools',
          '',
          '--strict-mcp-config',
          // User settings keep the owner's auth/router config; hooks would inject unrelated context.
          '--setting-sources',
          'user',
          '--settings',
          '{"disableAllHooks":true}',
          '--no-session-persistence',
          '--system-prompt',
          system,
          '--json-schema',
          schema,
        ],
        prompt,
        cwd,
        signal,
      );
      const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
      };
      if (result.is_error)
        throw new Error(`claude: ${result.result ?? 'request failed'}`);
      return parseTurn(result.structured_output ?? result.result);
    }
    const schemaPath = join(cwd, 'schema.json');
    const outPath = join(cwd, 'out.json');
    await writeFile(schemaPath, schema);
    await run(
      'codex',
      [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        ...(model ? ['-m', model] : []),
        '--output-schema',
        schemaPath,
        '-o',
        outPath,
        '--color',
        'never',
        '-',
      ],
      `${system}\n\n---\n\n${prompt}`,
      cwd,
      signal,
    );
    return parseTurn(await readFile(outPath, 'utf8'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const app = new Hono();
app.use('*', bodyLimit({ maxSize: 8 * 1024 * 1024 }));
app.use('*', async (c, next) => {
  const supplied = Buffer.from(
    c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
  );
  const expected = Buffer.from(secret);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return c.json({ error: { message: 'Unauthorized' } }, 401);
  await next();
});
app.get('/v1/models', (c) =>
  c.json({
    object: 'list',
    data: ['claude:sonnet', 'claude:opus', 'claude:haiku', 'codex:default'].map(
      (id) => ({ id, object: 'model', owned_by: 'local-cli' }),
    ),
  }),
);
app.post('/v1/chat/completions', async (c) => {
  const parsed = chatRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json(
      { error: { message: 'Invalid chat completion request.' } },
      400,
    );
  const request = parsed.data;
  let result: Turn;
  try {
    result = await turn(request, c.req.raw.signal);
    if (!toolsAllowed(request)) result.tool_calls = [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cli-bridge] ${request.model}: ${message}`);
    return c.json({ error: { message } }, 502);
  }
  if (!request.stream) return c.json(completion(request.model, result));
  return new Response(streamChunks(request.model, result), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
});
serve({ fetch: app.fetch, hostname: host, port }, (info) =>
  console.log(
    `OpenDots CLI bridge listening on http://${host}:${info.port}/v1`,
  ),
);
