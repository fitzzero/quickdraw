// Type tests for a script's holdings (RFC 0003 section 11.5): `holdCollection`,
// `holdEntity` and `holdStream` take their types from the contract, as the
// typed client's `useCollection`, `useEntity` and `useStream` do.
// `bun run typecheck` checks this file, and vitest's typecheck mode reports
// each block as a test; nothing here runs.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineContract, mutation, type EntityOf, type ItemOf } from "../../index";
import type { QuickdrawError } from "../../protocol/errors";
import { taskContract } from "../../server/collections/__tests__/fixture";
import {
  holdCollection,
  holdEntity,
  holdStream,
  type CollectionHolding,
  type CollectionSnapshot,
  type EntitySnapshot,
  type Holding,
  type LiveStore,
  type StreamSnapshot,
} from "../core";

declare const live: LiveStore;

const lobby = defineContract("lobbyService", {
  methods: { enter: mutation({ input: z.object({ room: z.string() }), output: z.boolean() }) },
  streams: {
    logs: { item: z.object({ line: z.string() }), scope: "room", access: "authenticated" },
    load: { item: z.number(), access: "public" },
  },
});

type Entity = EntityOf<typeof taskContract>;
type Tile = ItemOf<typeof taskContract, "board">;
type TileRow = Pick<Tile, "id" | "status" | "ordinal" | "assigneeId">;

const nothing = (): void => undefined;

describe("a script's holdings", () => {
  test("holdCollection is typed by the scope, the item, the index fields and the views", () => {
    const board = holdCollection(
      live,
      { contract: taskContract, collection: "board", scope: "p1", view: "mine", load: "all" },
      (scope) => {
        expectTypeOf(scope).toEqualTypeOf<CollectionSnapshot<Tile, TileRow>>();
        expectTypeOf(scope.items).toEqualTypeOf<readonly Tile[]>();
        expectTypeOf(scope.index).toEqualTypeOf<readonly TileRow[] | undefined>();
        expectTypeOf(scope.byId).toEqualTypeOf<ReadonlyMap<string, Tile>>();
        expectTypeOf(scope.error).toEqualTypeOf<QuickdrawError | null>();
      },
    );
    expectTypeOf(board).toEqualTypeOf<CollectionHolding<Tile, TileRow>>();
    expectTypeOf(board.current()).toEqualTypeOf<CollectionSnapshot<Tile, TileRow>>();
    expectTypeOf(board.loadItems).toEqualTypeOf<(ids: readonly string[]) => Promise<void>>();
    expectTypeOf(board.release).toEqualTypeOf<() => void>();
    const view = { contract: taskContract, collection: "board", scope: "p1" } as const;
    // @ts-expect-error not a view of the board
    holdCollection(live, { ...view, view: "theirs" }, nothing);
    // @ts-expect-error byProject declares no views
    holdCollection(live, { ...view, collection: "byProject", view: "mine" }, nothing);
    // @ts-expect-error not a collection of the contract
    holdCollection(live, { ...view, collection: "nope" }, nothing);
    // @ts-expect-error only "all" may be asked for
    holdCollection(live, { ...view, load: "some" }, nothing);
    // @ts-expect-error a scope is the scope column's value, a string
    holdCollection(live, { ...view, scope: 1 }, nothing);
  });

  test("holdEntity is typed by the contract's entity, and takes only a contract that has one", () => {
    const row = holdEntity(live, { contract: taskContract, id: "t1" }, (shown) => {
      expectTypeOf(shown).toEqualTypeOf<EntitySnapshot<Entity>>();
      expectTypeOf(shown.data).toEqualTypeOf<Entity | undefined>();
    });
    expectTypeOf(row).toEqualTypeOf<Holding<EntitySnapshot<Entity>>>();
    // @ts-expect-error the lobby has no entity
    holdEntity(live, { contract: lobby, id: "t1" }, nothing);
    // @ts-expect-error an id is a string
    holdEntity(live, { contract: taskContract, id: 1 }, nothing);
  });

  test("holdStream takes a scoped stream's scope, and none for a global stream", () => {
    const logs = holdStream(live, { contract: lobby, stream: "logs", scope: "r1" }, (feed) => {
      expectTypeOf(feed).toEqualTypeOf<StreamSnapshot<{ line: string }>>();
      expectTypeOf(feed.items).toEqualTypeOf<readonly { line: string }[]>();
    });
    expectTypeOf(logs).toEqualTypeOf<Holding<StreamSnapshot<{ line: string }>>>();
    const load = holdStream(live, { contract: lobby, stream: "load", max: 10 }, (feed) => {
      expectTypeOf(feed.items).toEqualTypeOf<readonly number[]>();
    });
    expectTypeOf(load.current().items).toEqualTypeOf<readonly number[]>();
    // @ts-expect-error a scoped stream needs its scope
    holdStream(live, { contract: lobby, stream: "logs" }, nothing);
    // @ts-expect-error a global stream takes none
    holdStream(live, { contract: lobby, stream: "load", scope: "r1" }, nothing);
    // @ts-expect-error not a stream of the contract
    holdStream(live, { contract: lobby, stream: "nope" }, nothing);
  });
});
