import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastValueFrom, toArray, Observable } from 'rxjs';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { expect, it } from 'vitest';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';

class EchoAgent extends AbstractAgent {
  run(input: RunAgentInput) {
    return new Observable<BaseEvent>((sub) => {
      const id = `reply-${input.runId}`;
      sub.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      sub.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: id,
        role: 'assistant',
      } as BaseEvent);
      sub.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: id,
        delta: 'hello',
      } as BaseEvent);
      sub.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: id,
      } as BaseEvent);
      sub.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      sub.complete();
    });
  }
}

it('persists threads, messages and replayable events across runner restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = new SqliteAgentRunner(path);
    await first.createThread({
      threadId: 't1',
      agentId: 'dot',
      name: 'First chat',
    });
    const agent = new EchoAgent({ agentId: 'dot', threadId: 't1' });
    const user = { id: 'u1', role: 'user' as const, content: 'hi' };
    agent.messages = [user];
    await lastValueFrom(
      first
        .run({
          threadId: 't1',
          agent,
          input: {
            threadId: 't1',
            runId: 'r1',
            messages: [user],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          },
        })
        .pipe(toArray()),
    );
    expect(await first.isRunning({ threadId: 't1' })).toBe(false);

    const second = new SqliteAgentRunner(path);
    expect(second.listThreads()).toMatchObject([
      { id: 't1', agentId: 'dot', name: 'First chat' },
    ]);
    const messages = second.getThreadMessages('t1');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('hello');
    const replay = await lastValueFrom(
      second.connect({ threadId: 't1' }).pipe(toArray()),
    );
    expect(replay.some((e) => e.type === EventType.RUN_STARTED)).toBe(true);
    expect(replay.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    second.clearThreads();
    expect(second.listThreads()).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
