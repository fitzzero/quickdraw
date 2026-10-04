// The search kit tests' app, on the read/write kit tests' harness and board
// (`../../crud/__tests__/fixture.ts`): a task service made of the search
// kit's methods only. `search` looks in titles and the Admin-only notes and
// keeps to the scopes of `board`, an indexed collection of cards in pages of
// 2; `searchByLabel` looks in titles and keeps to the scopes of `byLabel`,
// the tasks a label is on through the TaskLabel junction. The client tests
// (`src/client/live/search.test.tsx`) serve it too.
//
//            owner   access list    members                 level on its tasks
//   P1       ada     di: Read       bo: Moderate, cy: Read  ada Admin, bo Moderate, cy and di Read
//   P2       ed      -              -                       ed Admin
//   T1 in P1, T2 in P2

import { defineContract, via } from "../../../../index";
import { createTestApp, type TestApp } from "../../../../testing/index";
import { labelContract, labelService } from "../../../collections/__tests__/fixture";
import { projectContract, projectService, qd } from "../../../emit/__tests__/live";
import { inherit, search, type CallRecord, type SearchStrategy } from "../../../index";
import { cardSchema, kitApp, taskEntity } from "../../crud/__tests__/fixture";

export { addTasks, as, cardSchema, CARD_KEYS } from "../../crud/__tests__/fixture";

const boardSearch = search.contract({
  entity: taskEntity,
  item: cardSchema,
  fields: ["title", "notes"],
  scope: "board",
});

const labelSearch = search.contract({
  entity: taskEntity,
  item: cardSchema,
  fields: ["title"],
  scope: "byLabel",
  minLength: 1,
});

export const searchContract = defineContract("taskService", {
  entity: taskEntity,
  projections: { card: cardSchema },
  fields: { notes: "Admin" },
  methods: { search: boardSearch.search, searchByLabel: labelSearch.search },
  collections: {
    board: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      index: ["status", "ordinal"],
      limit: 2,
    },
    byLabel: {
      scope: via({ model: "taskLabel", entry: "taskId", scope: "labelId" }),
      item: "card",
      order: [["id", "asc"]],
    },
  },
});

/** Options of {@link defineSearchService}. */
export interface SearchServiceOptions {
  readonly strategy?: SearchStrategy;
}

/** The kit's task service: the search kit's methods, for any signed-in caller. */
export function defineSearchService(options: SearchServiceOptions = {}) {
  return qd.defineService(searchContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { board: { anchor: projectContract }, byLabel: { anchor: labelContract } },
    methods: {
      ...search.handlers(searchContract, {
        access: "authenticated",
        ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
      }),
    },
  });
}

/**
 * The suite's harness: call once per test file. Each file gets a PGlite
 * database, each test a freshly seeded board; apps started with `start` are
 * closed after the test.
 */
export function searchApp() {
  const kit = kitApp();
  return {
    harness: kit.harness,
    board: kit.board,
    track: kit.track,
    /** Starts an app serving the project, label and search services; `records` are its completed calls. */
    async start(options: SearchServiceOptions = {}) {
      const service = defineSearchService(options);
      const records: CallRecord[] = [];
      const app = await createTestApp({
        services: [projectService, labelService, service],
        db: kit.harness().db,
        onCall: (record) => records.push(record),
      });
      kit.track(app as unknown as TestApp);
      return { app, service, records };
    },
  };
}

/** The ids of a page's items, in order. */
export function idsOf(page: { readonly items: readonly { readonly id: string }[] }): string[] {
  return page.items.map((item) => item.id);
}
