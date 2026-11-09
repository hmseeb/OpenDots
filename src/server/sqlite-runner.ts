import { DatabaseSync } from 'node:sqlite';
import { ReplaySubject, type Observable } from 'rxjs';
import {
  EventType,
  compactEvents,
  type BaseEvent,
  type Message,
  type RunStartedEvent,
} from '@ag-ui/client';
import { finalizeRunEvents } from '@copilotkit/shared';
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from '@copilotkit/runtime/v2';

interface Live {
  runId: string;
  agent: AgentRunnerRunRequest['agent'];
  subject: ReplaySubject<BaseEvent>;
  control: { stopRequested: boolean };
}

/**
 * Durable replacement for CopilotKit Intelligence thread storage.
 * Mirrors the SDK's InMemoryAgentRunner (same run/connect/finalize semantics and
 * local REST thread endpoints) but persists every completed run to SQLite.
 */
export class SqliteAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private db: DatabaseSync;
  private live = new Map<string, Live>();

  constructor(path: string) {
    super();
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_threads (id TEXT PRIMARY KEY, agentId TEXT NOT NULL, name TEXT, messages TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL, agentId TEXT NOT NULL, events TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS local_runs_thread ON local_runs(threadId, seq);`);
  }

  /** Same shape as CopilotKitIntelligence.createThread / getOrCreateThread. */
  async createThread(input: {
    threadId: string;
    agentId: string;
    name: string;
  }) {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO local_threads (id, agentId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(input.threadId, input.agentId, input.name, now, now);
    return { id: input.threadId };
  }
  getOrCreateThread(input: {
    threadId: string;
    agentId: string;
    name: string;
  }) {
    return this.createThread(input);
  }

  private events(threadId: string): BaseEvent[] {
    const rows = this.db
      .prepare('SELECT events FROM local_runs WHERE threadId = ? ORDER BY seq')
      .all(threadId) as { events: string }[];
    return rows.flatMap((row) => JSON.parse(row.events) as BaseEvent[]);
  }

  private saveRun(
    threadId: string,
    run: {
      runId: string;
      agentId: string;
      events: BaseEvent[];
      messages: Message[];
    },
  ) {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO local_threads (id, agentId, name, createdAt, updatedAt) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET updatedAt = excluded.updatedAt',
      )
      .run(threadId, run.agentId, now, now);
    if (run.messages.length)
      this.db
        .prepare('UPDATE local_threads SET messages = ? WHERE id = ?')
        .run(JSON.stringify(run.messages), threadId);
    this.db
      .prepare(
        'INSERT INTO local_runs (threadId, runId, agentId, events, createdAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(threadId, run.runId, run.agentId, JSON.stringify(run.events), now);
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent, input } = request;
    if (this.live.has(threadId)) throw new Error('Thread already running');
    const historicIds = new Set<string>();
    for (const event of this.events(threadId)) {
      if ('messageId' in event && typeof event.messageId === 'string')
        historicIds.add(event.messageId);
      if (event.type === EventType.RUN_STARTED)
        for (const m of (event as RunStartedEvent).input?.messages ?? [])
          historicIds.add(m.id);
    }
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const control = { stopRequested: false };
    this.live.set(threadId, { runId: input.runId, agent, subject, control });
    const current: BaseEvent[] = [];

    const finalize = (interruptionMessage?: string) => {
      const appended = finalizeRunEvents(current, {
        stopRequested: control.stopRequested,
        ...(interruptionMessage !== undefined ? { interruptionMessage } : {}),
      });
      for (const event of appended) subject.next(event);
      // Persist unless the run failed before emitting anything.
      if (interruptionMessage === undefined || current.length > 0)
        this.saveRun(threadId, {
          runId: input.runId,
          agentId: agent.agentId ?? 'default',
          events: compactEvents(current),
          messages: Array.isArray(agent.messages) ? [...agent.messages] : [],
        });
      this.live.delete(threadId);
      subject.complete();
    };

    void (async () => {
      try {
        await agent.runAgent(input, {
          onEvent: ({ event }) => {
            if (event.type === EventType.RUN_STARTED) {
              const started = event as RunStartedEvent;
              if (!started.input)
                started.input = {
                  ...input,
                  ...(input.messages
                    ? {
                        messages: input.messages.filter(
                          (m) => !historicIds.has(m.id),
                        ),
                      }
                    : {}),
                };
            }
            subject.next(event);
            current.push(event);
          },
        });
        finalize();
      } catch (error) {
        finalize(error instanceof Error ? error.message : String(error));
      }
    })();
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const out = new ReplaySubject<BaseEvent>(Infinity);
    const emitted = new Set<string>();
    for (const event of compactEvents(this.events(request.threadId))) {
      out.next(event);
      if ('messageId' in event && typeof event.messageId === 'string')
        emitted.add(event.messageId);
    }
    const live = this.live.get(request.threadId);
    if (live)
      live.subject.subscribe({
        next: (event) => {
          if (
            'messageId' in event &&
            typeof event.messageId === 'string' &&
            emitted.has(event.messageId)
          )
            return;
          out.next(event);
        },
        complete: () => out.complete(),
        error: (err) => out.error(err),
      });
    else out.complete();
    return out.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest) {
    return Promise.resolve(this.live.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest) {
    const live = this.live.get(request.threadId);
    if (!live || live.control.stopRequested) return Promise.resolve(false);
    if (request.runId !== undefined && live.runId !== request.runId)
      return Promise.resolve(false);
    live.control.stopRequested = true;
    try {
      live.agent.abortRun();
      return Promise.resolve(true);
    } catch {
      live.control.stopRequested = false;
      return Promise.resolve(false);
    }
  }

  // Local REST thread endpoints (GET /threads, /threads/:id/messages, ...).
  listThreads() {
    const rows = this.db
      .prepare(
        'SELECT id, agentId, name, createdAt, updatedAt FROM local_threads WHERE EXISTS (SELECT 1 FROM local_runs r WHERE r.threadId = local_threads.id) ORDER BY updatedAt DESC',
      )
      .all() as {
      id: string;
      agentId: string;
      name: string | null;
      createdAt: number;
      updatedAt: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      agentId: row.agentId,
      organizationId: '',
      createdById: '',
      archived: false,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }
  getThreadMessages(threadId: string): Message[] {
    const row = this.db
      .prepare('SELECT messages FROM local_threads WHERE id = ?')
      .get(threadId) as { messages: string } | undefined;
    return row ? (JSON.parse(row.messages) as Message[]) : [];
  }
  getThreadEvents(threadId: string): BaseEvent[] {
    return compactEvents(this.events(threadId));
  }
  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i].type === EventType.STATE_SNAPSHOT) {
        const snapshot = (events[i] as { snapshot?: unknown }).snapshot;
        return snapshot &&
          typeof snapshot === 'object' &&
          !Array.isArray(snapshot)
          ? { ...(snapshot as Record<string, unknown>) }
          : null;
      }
    return null;
  }
  // The runtime exposes POST /threads/clear; never wipe durable history from a client call.
  clearThreads() {}
}
