// Type tests for `createServer`'s `cluster` option: the node-redis client an
// app already has for the Socket.IO Redis adapter is accepted as it is.

import type { createClient } from "redis";
import { describe, expectTypeOf, test } from "vitest";
import type { ClusterOptions, ServerOnlyOptions } from "../index";

describe("cluster.client", () => {
  test("takes a node-redis client", () => {
    expectTypeOf<ReturnType<typeof createClient>>().toExtend<
      NonNullable<ClusterOptions["client"]>
    >();
  });

  test("is createServer's cluster option", () => {
    expectTypeOf<NonNullable<ServerOnlyOptions["cluster"]>>().toEqualTypeOf<ClusterOptions>();
  });
});
