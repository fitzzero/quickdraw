// Type tests for protocol v5. `bun run typecheck` checks this file, and
// vitest's typecheck mode reports each block as a test. Root exports are
// imported from the package root, the way an app does; the parser from its
// own module (the `./parser` export).

import type { Server } from "socket.io";
import type { Socket as ClientSocket } from "socket.io-client";
import type { Packet } from "socket.io-parser";
import { describe, expectTypeOf, test } from "vitest";
import {
  CLIENT_EVENTS,
  PROTOCOL_VERSION,
  QuickdrawError,
  SERVER_EVENTS,
  fromWire,
  httpStatus,
  isCallEnvelope,
  isCancel,
  isProtocolMismatch,
  isQdHandshake,
  toWire,
  type CallEnvelope,
  type CallReply,
  type CancelFrame,
  type ChangedFrame,
  type ChannelFrame,
  type ClientEventName,
  type ClientToServerEvents,
  type CollectionDelta,
  type CollectionItemsReply,
  type CollectionSubscribeReply,
  type EntityFrame,
  type EntitySubscribeReply,
  type AccessLevel,
  type ErrorCode,
  type HelloFrame,
  type HelloLimits,
  type HelloSubscriptionLimits,
  type ProtocolMismatch,
  type QdHandshake,
  type ServerEventName,
  type ServerToClientEvents,
  type Version,
  type WireError,
  type WireIndexRow,
} from "../index";
import { createJsonParser, type JsonParser } from "./parser";

describe("errors", () => {
  test("the codes are the nine of RFC 0003 section 3", () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "VALIDATION"
      | "RATE_LIMITED"
      | "CANCELLED"
      | "TIMEOUT"
      | "INTERNAL"
    >();
  });

  test("a QuickdrawError takes a known code and a message", () => {
    expectTypeOf(new QuickdrawError("NOT_FOUND", "Gone").code).toEqualTypeOf<ErrorCode>();
    expectTypeOf(new QuickdrawError("VALIDATION", "Bad", { issues: [] }).data).toBeUnknown();
    expectTypeOf(QuickdrawError).constructorParameters.toEqualTypeOf<
      [code: ErrorCode, message: string, data?: unknown]
    >();
    // @ts-expect-error a code outside the table
    expectTypeOf(new QuickdrawError("TEAPOT", "short and stout")).toBeObject();
    // @ts-expect-error the message is required
    expectTypeOf(new QuickdrawError("NOT_FOUND")).toBeObject();
    // @ts-expect-error a code outside the table has no status
    httpStatus("TEAPOT");
    expectTypeOf(httpStatus).returns.toBeNumber();
  });

  test("toWire and fromWire convert between the error and its wire form", () => {
    expectTypeOf(toWire).parameter(0).toBeUnknown();
    expectTypeOf(toWire).returns.toEqualTypeOf<WireError>();
    expectTypeOf(fromWire).parameter(0).toBeUnknown();
    expectTypeOf(fromWire).returns.toEqualTypeOf<QuickdrawError>();
  });
});

describe("call frames", () => {
  test("a reply narrows to data, not modified, or an error", () => {
    const reply = {} as CallReply<{ id: string }>;
    if (!reply.ok) {
      expectTypeOf(reply.e).toEqualTypeOf<WireError>();
    } else if (reply.nm) {
      expectTypeOf(reply.v).toEqualTypeOf<Version>();
    } else {
      expectTypeOf(reply.d).toEqualTypeOf<{ id: string }>();
      expectTypeOf(reply.v).toEqualTypeOf<Version | undefined>();
    }
  });

  test("the guards narrow untrusted values", () => {
    const value: unknown = {};
    if (isCallEnvelope(value)) {
      expectTypeOf(value).toEqualTypeOf<CallEnvelope>();
      expectTypeOf(value.i).toBeUnknown();
    }
    if (isCancel(value)) {
      expectTypeOf(value).toEqualTypeOf<CancelFrame>();
    }
    if (isQdHandshake(value)) {
      expectTypeOf(value).toEqualTypeOf<QdHandshake>();
    }
    if (isProtocolMismatch(value)) {
      expectTypeOf(value.code).toEqualTypeOf<"PROTOCOL_MISMATCH">();
      expectTypeOf(value).toEqualTypeOf<ProtocolMismatch>();
    }
  });

  test("the protocol version is the literal 5", () => {
    expectTypeOf<typeof PROTOCOL_VERSION>().toEqualTypeOf<5>();
    expectTypeOf<HelloFrame["protocol"]>().toEqualTypeOf<5>();
  });

  test("the hello names the socket's user and grants, and announces the subscription lane", () => {
    expectTypeOf<HelloFrame["userId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<HelloFrame["serviceAccess"]>().toEqualTypeOf<
      Readonly<Record<string, AccessLevel>>
    >();
    expectTypeOf<HelloLimits["subscriptions"]>().toEqualTypeOf<HelloSubscriptionLimits>();
    expectTypeOf<keyof HelloSubscriptionLimits>().toEqualTypeOf<"maxInFlight" | "maxQueued">();
    expectTypeOf<keyof HelloFrame>().toEqualTypeOf<
      "protocol" | "server" | "serverId" | "limits" | "features" | "userId" | "serviceAccess"
    >();
  });
});

describe("live data frames", () => {
  test("entity frames narrow on t", () => {
    const frame = {} as EntityFrame<{ id: string; title: string }>;
    if (frame.t === "u") {
      expectTypeOf(frame.d).toEqualTypeOf<{ id: string; title: string }>();
    } else if (frame.t === "p") {
      expectTypeOf(frame.d).toEqualTypeOf<Partial<{ id: string; title: string }>>();
    } else {
      expectTypeOf(frame).not.toHaveProperty("d");
    }
  });

  test("a collection reply is a snapshot, a resume or a failure", () => {
    const reply = {} as CollectionSubscribeReply<{ id: string }>;
    if (reply.ok && reply.resumed) {
      expectTypeOf(reply.deltas[0]).toExtend<{ t: string } | undefined>();
    } else if (reply.ok) {
      expectTypeOf(reply.items).toEqualTypeOf<readonly { id: string }[]>();
      expectTypeOf(reply.cursor).toEqualTypeOf<string | null>();
      expectTypeOf(reply.index).toEqualTypeOf<readonly WireIndexRow[] | undefined>();
      expectTypeOf(reply.indexTruncated).toEqualTypeOf<true | undefined>();
    }
  });

  test("an index row is [id, rev, ...fields], and an added delta may carry one", () => {
    expectTypeOf<WireIndexRow[0]>().toBeString();
    expectTypeOf<WireIndexRow[1]>().toBeNumber();
    const delta = {} as CollectionDelta<{ id: string }>;
    if (delta.t === "added") {
      expectTypeOf(delta.index).toEqualTypeOf<WireIndexRow | undefined>();
    }
  });

  test("qd:col:items answers items, and qd:changed carries a topic and a revision, no data", () => {
    const items = {} as CollectionItemsReply<{ id: string }>;
    if (items.ok) {
      expectTypeOf(items.items).toEqualTypeOf<readonly { id: string }[]>();
    }
    expectTypeOf<keyof ChangedFrame>().toEqualTypeOf<"s" | "topic" | "rev">();
    expectTypeOf<ChangedFrame["rev"]>().toBeNumber();
  });

  test("qd:sub answers each id with a row, not modified or an error", () => {
    const reply = {} as EntitySubscribeReply<{ id: string }>;
    if (reply.ok) {
      const [first] = reply.r;
      if (first?.ok && !first.nm) {
        expectTypeOf(first.d).toEqualTypeOf<{ id: string }>();
        expectTypeOf(first.rev).toBeNumber();
      }
    }
  });

  test("a channel frame is [service, channel, payload]", () => {
    expectTypeOf<ChannelFrame<{ chatId: string }>>().toEqualTypeOf<
      readonly [s: string, channel: string, payload: { chatId: string }]
    >();
  });
});

describe("event maps", () => {
  test("are keyed by exactly the names in CLIENT_EVENTS and SERVER_EVENTS", () => {
    expectTypeOf<keyof ClientToServerEvents>().toEqualTypeOf<ClientEventName>();
    expectTypeOf<keyof ServerToClientEvents>().toEqualTypeOf<ServerEventName>();
    expectTypeOf<ClientToServerEvents[typeof CLIENT_EVENTS.call]>().toEqualTypeOf<
      (envelope: CallEnvelope, ack: (reply: CallReply) => void) => void
    >();
    expectTypeOf<ServerToClientEvents[typeof SERVER_EVENTS.hello]>().toEqualTypeOf<
      (frame: HelloFrame) => void
    >();
  });

  test("type a Socket.IO server's sockets", () => {
    const io = {} as Server<ClientToServerEvents, ServerToClientEvents>;
    const hello = {} as HelloFrame;
    io.on("connection", (socket) => {
      socket.on("qd:call", (envelope, ack) => {
        expectTypeOf(envelope).toEqualTypeOf<CallEnvelope>();
        ack({ ok: true, d: { id: "t1" } });
        ack({ ok: true, nm: true, v: 1 });
        ack({ ok: false, e: { code: "FORBIDDEN", message: "No" } });
        // @ts-expect-error a failure carries a known code
        ack({ ok: false, e: { code: "TEAPOT", message: "No" } });
      });
      socket.on("qd:ch", (frame) => {
        expectTypeOf(frame).toEqualTypeOf<ChannelFrame>();
      });
      socket.emit("qd:hello", hello);
      // @ts-expect-error not a protocol v5 event
      socket.emit("qd:nope", {});
    });
  });

  test("type the client's socket", () => {
    const socket = {} as ClientSocket<ServerToClientEvents, ClientToServerEvents>;
    socket.emit("qd:call", { id: 1, s: "taskService", m: "get", i: { id: "t1" } }, (reply) => {
      expectTypeOf(reply).toEqualTypeOf<CallReply>();
    });
    socket.emit("qd:cancel", { id: 1 });
    // @ts-expect-error a call id is a number
    socket.emit("qd:cancel", { id: "1" });
    socket.on("qd:e", (frame) => {
      expectTypeOf(frame).toEqualTypeOf<EntityFrame>();
    });
  });
});

describe("parser", () => {
  test("createJsonParser returns a Socket.IO parser with an optional size hook", () => {
    expectTypeOf(createJsonParser).returns.toEqualTypeOf<JsonParser>();
    createJsonParser();
    createJsonParser({
      onEncoded: (packet, byteLength) => {
        expectTypeOf(packet).toEqualTypeOf<Packet>();
        expectTypeOf(byteLength).toBeNumber();
      },
    });
  });
});
