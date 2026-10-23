// What every transform of one run shares: the project, the layout, the
// import habits of each package, and the counts the command prints.

import type { Project } from "ts-morph";
import { usesJsExtension } from "./imports";
import type { Layout } from "./layout";

/** The counts a run prints when it finishes. */
export interface Stats {
  services: number;
  methods: number;
  /** Functions that only called method modules' register functions (and each other), removed. */
  aggregatorsRemoved: number;
  contracts: number;
  schemasMoved: number;
  /** Moved local declarations written once for several method modules: the same code under one name. */
  schemasMerged: number;
  /** Moved local declarations written as `<name>Of<Module>`, since the contract had another of their name. */
  schemasRenamed: number;
  todoSchemas: number;
  clientCalls: number;
  wrappersDeleted: number;
  /** Module functions that write through a Prisma client parameter, typed to take the tracked client. */
  writersTyped: number;
}

/** One run of the codemod. */
export interface RunContext {
  readonly project: Project;
  readonly layout: Layout;
  /** Whether new relative imports end in `.js`, per package. */
  readonly js: { readonly shared: boolean; readonly api: boolean; readonly web: boolean };
  readonly stats: Stats;
  /** Absolute paths of the files the run created, and of those it deleted. */
  readonly created: Set<string>;
  readonly deleted: Set<string>;
  /** Problems the command prints to stderr, one line each. */
  readonly warnings: string[];
}

export function createContext(project: Project, layout: Layout): RunContext {
  return {
    project,
    layout,
    js: {
      shared: usesJsExtension(project, layout.shared.src),
      api: usesJsExtension(project, layout.api.src),
      web: layout.web === undefined ? false : usesJsExtension(project, layout.web.src),
    },
    stats: {
      services: 0,
      methods: 0,
      aggregatorsRemoved: 0,
      contracts: 0,
      schemasMoved: 0,
      schemasMerged: 0,
      schemasRenamed: 0,
      todoSchemas: 0,
      clientCalls: 0,
      wrappersDeleted: 0,
      writersTyped: 0,
    },
    created: new Set(),
    deleted: new Set(),
    warnings: [],
  };
}
