// A socket's backlog (`backlog.ts`) as a volatile stream's frames meet it
// (`streamPushes.ts`), on stand-in sockets whose connections drain only when
// the test says so: a frame skips a socket whose connection is backed up
// and still goes to the others in the room, in one broadcast; relay
// messages and volatile frames fill one count; a drain empties it.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { streamRoom } from "../../contract/names";
import type { RelayForwardFrame } from "../../protocol/envelope";
import { PEER_RELAY_FAST_BACKLOG } from "../../protocol/version";
import type { Hub } from "../emit/hub";
import { backedUp, countSend } from "./backlog";
import { sendRelay } from "./peerDelivery";
import { StreamSeeds } from "./seeds";
import { sendItems, type Served } from "./streamPushes";
import type { QuickdrawServerSocket } from "../transports/types";

const GAME = "game:1";
const ROOM = streamRoom("worldService", "world", "w1");

/** One broadcast: the sockets it skipped, and its frame. */
interface Broadcast {
  readonly except: readonly string[];
  readonly frame: unknown;
}

/** A server whose sockets are stand-ins in one stream room and one app room. */
function server(ids: readonly string[]) {
  const broadcasts: Broadcast[] = [];
  const relayed: string[] = [];
  const sockets = new Map(
    ids.map((id) => {
      const socket = {
        id,
        connected: true,
        data: { protocol: 5, principal: { userId: id }, appRooms: { [GAME]: true } },
        conn: new EventEmitter(),
        emit: (_event: string, frame: RelayForwardFrame) => relayed.push(`${id}:${frame[3]}`),
      };
      return [id, socket] as const;
    }),
  );
  const room = new Set(ids);
  const operator = (except: readonly string[]) => ({
    except: (more: readonly string[]) => operator([...except, ...more]),
    emit: (_event: string, frame: unknown) => broadcasts.push({ except, frame }),
  });
  const hub = {
    io: {
      sockets: { sockets, adapter: { rooms: new Map([[ROOM, room]]) } },
      local: { to: () => operator([]) },
    },
    probe: { local: () => true },
  } as unknown as Hub;
  const served = {
    service: { name: "worldService" },
    stream: { name: "world", seed: 0, volatile: true },
  } as unknown as Served;
  const push = (...items: number[]): void => {
    sendItems(hub, new StreamSeeds(), served, "w1", items);
  };
  const socketOf = (id: string) => sockets.get(id) as unknown as QuickdrawServerSocket;
  return { hub, room, broadcasts, relayed, push, socketOf };
}

const frame = (n: number) => ["worldService", "world", "w1", n];

describe("a volatile stream's frames", () => {
  it("skip a socket whose connection is backed up, and go to the others in one broadcast each", () => {
    const { room, broadcasts, push, socketOf } = server(["a", "b"]);
    // b joins the room once a is backed up. Nothing drains: a's count only grows.
    room.delete("b");
    push(...Array.from({ length: PEER_RELAY_FAST_BACKLOG }, (_, n) => n));
    expect(backedUp(socketOf("a"))).toBe(true);
    room.add("b");
    push(64, 65);
    // One slow subscriber costs the room's others nothing: b gets both, and is counted for them.
    expect(broadcasts.slice(-2)).toEqual([
      { except: ["a"], frame: frame(64) },
      { except: ["a"], frame: frame(65) },
    ]);
    expect(backedUp(socketOf("b"))).toBe(false);
    // A drain empties a's count: the next frame reaches both.
    socketOf("a").conn.emit("drain");
    push(66);
    expect(broadcasts.at(-1)).toEqual({ except: [], frame: frame(66) });
    expect(broadcasts).toHaveLength(PEER_RELAY_FAST_BACKLOG + 3);
  });

  it("fill one count with the relay messages to the same socket", () => {
    const { hub, relayed, push, socketOf } = server(["a", "b"]);
    for (let n = 1; n < PEER_RELAY_FAST_BACKLOG; n += 1) {
      countSend(socketOf("b"));
    }
    push(0);
    // b's 64th message was that frame: a `fast` relay message to it is dropped, a `rel` one is not.
    sendRelay(hub, "b", [GAME, "a", "fast", "dropped"]);
    sendRelay(hub, "b", [GAME, "a", "rel", "kept"]);
    sendRelay(hub, "a", [GAME, "b", "fast", "to a"]);
    expect(relayed).toEqual(["b:kept", "a:to a"]);
  });
});
