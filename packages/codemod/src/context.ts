// What every transform of one run shares: the project, the layout, the
// import habits of each package, and the counts the command prints.

import type { Project } from "ts-morph";
import { usesJsExtension } from "./imports";
import type { Layout } from "./layout";

/** The counts a run prints when it finishes. */
export interface Stats {
  services: number;
  methods: number;
  contracts: number;
  schemasMoved: number;
  todoSchemas: number;
  clientCalls: number;
  wrappersDeleted: number;
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
      contracts: 0,
      schemasMoved: 0,
      todoSchemas: 0,
      clientCalls: 0,
      wrappersDeleted: 0,
    },
    created: new Set(),
    deleted: new Set(),
  };
}
