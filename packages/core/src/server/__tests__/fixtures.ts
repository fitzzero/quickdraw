// Shared fixtures for the server tests: a task contract, principals, a
// logger that records its entries, and a dispatcher wired to them.

import { z } from "zod";
import { defineContract, listOf, mutation, nullable, query, type Logger } from "../../index";
import {
  createDispatcher,
  initQuickdraw,
  type AnyService,
  type CallRecord,
  type DispatchRequest,
  type PipelineOptions,
  type Principal,
} from "../index";

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  done: z.boolean(),
});
export const cardSchema = taskSchema.pick({ id: true, title: true });
export type TaskRow = z.output<typeof taskSchema>;

export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    find: query({ input: z.object({ id: z.string() }), output: nullable("entity") }),
    list: query({
      input: z.object({ projectId: z.string(), limit: z.number().int().positive().default(2) }),
      output: listOf("card"),
    }),
    count: query({ input: z.object({ projectId: z.string() }), output: z.number() }),
    rename: mutation({
      input: z.object({ id: z.string(), title: z.string().min(1) }),
      output: "entity",
    }),
  },
});

export const project = defineContract("projectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
});

export function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return { id: "t1", projectId: "p1", title: "Write the RFC", done: false, ...overrides };
}

export interface AppPrincipal extends Principal {
  readonly kind: "user" | "agent";
}

export const alice: AppPrincipal = { userId: "alice", kind: "user" };
export const bob: AppPrincipal = { userId: "bob", kind: "user" };

export function granted(
  principal: AppPrincipal,
  serviceAccess: AppPrincipal["serviceAccess"],
): AppPrincipal {
  return { ...principal, serviceAccess };
}

export interface FakeDb {
  readonly label: "fake-db";
}

export const db: FakeDb = { label: "fake-db" };

export const qd = initQuickdraw<{ db: FakeDb; principal: AppPrincipal }>();

/** Implementations of every task method, for tests that override only one or two. */
export const taskDefaults = {
  get: { access: "public", handler: () => taskRow() },
  find: { access: "public", handler: () => null },
  list: { access: "public", handler: () => [{ id: "t1", title: "a card" }] },
  count: { access: "public", handler: () => 0 },
  rename: { access: "authenticated", handler: () => taskRow() },
} as const;

export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

export interface CapturingLogger extends Logger {
  readonly entries: LogEntry[];
  /** The entries of one level. */
  at(level: LogEntry["level"]): LogEntry[];
}

export function captureLogger(): CapturingLogger {
  const entries: LogEntry[] = [];
  const write =
    (level: LogEntry["level"]) =>
    (message: string, meta?: Record<string, unknown>): void => {
      entries.push({ level, message, meta });
    };
  const logger: CapturingLogger = {
    entries,
    at: (level) => entries.filter((entry) => entry.level === level),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: () => logger,
  };
  return logger;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Waits for pending promise callbacks and timers of zero delay. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A dispatcher over `services` with a recording logger and completion records. */
export function setup(services: readonly AnyService[], options: PipelineOptions = {}) {
  const logger = captureLogger();
  const records: CallRecord[] = [];
  const dispatcher = createDispatcher({
    services,
    db,
    logger,
    onCall: (record) => records.push(record),
    ...options,
  });
  const call = (request: Partial<DispatchRequest> & Pick<DispatchRequest, "method">) =>
    dispatcher.call({
      service: "taskService",
      input: undefined,
      principal: alice,
      transport: "socket",
      ...request,
    });
  return { dispatcher, logger, records, call };
}
