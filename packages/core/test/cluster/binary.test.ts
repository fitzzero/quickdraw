// A stream's binary items across two nodes behind a real Valkey, on a server
// that sends binary (`binary: true`). Pushed on node B, a volatile stream's
// and a seeded stream's `Buffer`, `Uint8Array` and `ArrayBuffer` items, and
// one inside an object, reach a subscriber on node A as binary with the same
// bytes a subscriber on node B gets from the push on its own node, and node
// A keeps them as binary in the seed a later subscriber there gets. The push
// reaches node A as a server-side event, which the Redis adapter sends as
// JSON (`src/server/cluster/binary.ts` carries the binary beside it).

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../../src/contract/defineContract";
import { frames, settle, streamSub } from "../../src/server/realtime/__tests__/fixture";
import { initQuickdraw, type Principal } from "../../src/server/index";
import { createTestApp, type TestApp } from "../../src/testing/index";
import { nodesOf } from "./nodes";

const qd = initQuickdraw<{ principal: Principal }>();

const binContract = defineContract("binService", {
  streams: {
    ticks: { item: z.unknown(), volatile: true, access: "public" },
    log: { item: z.unknown(), seed: 4, access: "public" },
  },
});

const binService = qd.defineService(binContract, { methods: {} });

const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

/** A received value with each binary value as its bytes, everything else as it is. */
function bytesOf(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return { bytes: [...new Uint8Array(value)] };
  }
  if (ArrayBuffer.isView(value)) {
    return { bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
  }
  if (Array.isArray(value)) {
    return value.map(bytesOf);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, bytesOf(inner)]));
  }
  return value;
}

/** True when a received value is binary, as a push on the socket's own node delivers it. */
const isBinary = (value: unknown): boolean =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value);

const pushedItems = () => [
  Buffer.from([1, 2, 3]),
  new Uint8Array([4, 5, 6]),
  new Uint8Array([7, 8, 9]).buffer,
  { n: 1, bytes: Buffer.from([10]) },
];

const expected = [
  { bytes: [1, 2, 3] },
  { bytes: [4, 5, 6] },
  { bytes: [7, 8, 9] },
  { n: 1, bytes: { bytes: [10] } },
];

describe("a stream's binary items across nodes", () => {
  for (const stream of ["ticks", "log"] as const) {
    it(`reach node A from a push on node B as they reach node B's own subscriber: ${stream}`, async () => {
      const app = await createTestApp({ services: [binService], binary: true });
      apps.push(app as unknown as TestApp);
      const nodeB = nodesOf(app)[1].app as unknown as typeof app;
      const onA = await app.connect(null);
      const onB = await nodeB.connect(null);
      const itemsOnA = frames<readonly unknown[]>(onA, "qd:stream");
      const itemsOnB = frames<readonly unknown[]>(onB, "qd:stream");
      for (const connection of [onA, onB]) {
        expect(await streamSub(connection, stream, undefined, "binService")).toMatchObject({
          ok: true,
        });
      }
      // `app.server.stream` pushes on node B, the writer.
      app.server.stream(binContract, stream).pushMany(pushedItems());
      await settle(onA);
      await settle(onB);
      const onNodeA = itemsOnA.map((frame) => frame[3]);
      const onNodeB = itemsOnB.map((frame) => frame[3]);
      expect(bytesOf(onNodeB)).toEqual(expected);
      expect(bytesOf(onNodeA)).toEqual(expected);
      expect(onNodeA.slice(0, 3).map(isBinary)).toEqual([true, true, true]);
      expect(isBinary((onNodeA[3] as { readonly bytes: unknown }).bytes)).toBe(true);
    });
  }

  it("keeps them as binary in node A's seed", async () => {
    const app = await createTestApp({ services: [binService], binary: true });
    apps.push(app as unknown as TestApp);
    app.server.stream(binContract, "log").pushMany(pushedItems());
    const later = await app.connect(null);
    // Node B's push reached node A first: `settle` waits for it before the subscribe.
    await settle(later);
    const reply = await streamSub(later, "log", undefined, "binService");
    expect(bytesOf(reply)).toEqual({ ok: true, seed: expected });
    expect((reply.seed as readonly unknown[]).slice(0, 3).map(isBinary)).toEqual([
      true,
      true,
      true,
    ]);
  });
});
