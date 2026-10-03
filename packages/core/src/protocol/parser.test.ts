import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { Decoder, Encoder, PacketType, type Packet } from "socket.io-parser";
import { afterEach, describe, expect, it } from "vitest";
import { createJsonParser, type JsonParser } from "./parser";
import { countUtf8Bytes, utf8ByteLength } from "./utf8";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function row(n: number): Record<string, unknown> {
  return {
    id: `task_${n}`,
    projectId: "project_1",
    title: `Task ${n}`,
    status: n % 3 === 0 ? "done" : "todo",
    ordinal: n,
    assigneeId: n % 2 === 0 ? null : "user_1",
    labels: ["a", "b"],
    meta: { depth: { deeper: [n, null, true, { leaf: "x" }] } },
  };
}

const UNICODE =
  "héllo wörld · 你好 · مرحبا · 🎉 · \u{1f469}\u200d\u{1f469}\u200d\u{1f467} · e\u0301 · \u2028\u2029 · \ufeff";

const FIXTURES: [label: string, packet: Packet][] = [
  ["CONNECT to the main namespace", { type: PacketType.CONNECT, nsp: "/" }],
  [
    "CONNECT with the v5 handshake",
    {
      type: PacketType.CONNECT,
      nsp: "/",
      data: { token: "jwt.abc.def", qd: { protocol: 5, client: "5.0.0-alpha.0" } },
    },
  ],
  [
    "CONNECT reply in a custom namespace",
    { type: PacketType.CONNECT, nsp: "/admin", data: { sid: "Hd8ezQ8b-3TNVkWhAAAB" } },
  ],
  ["DISCONNECT", { type: PacketType.DISCONNECT, nsp: "/" }],
  ["DISCONNECT from a custom namespace", { type: PacketType.DISCONNECT, nsp: "/admin" }],
  [
    "CONNECT_ERROR with data",
    {
      type: PacketType.CONNECT_ERROR,
      nsp: "/",
      data: { message: "refused", data: { code: "PROTOCOL_MISMATCH", expected: 5 } },
    },
  ],
  [
    "CONNECT_ERROR as a string",
    { type: PacketType.CONNECT_ERROR, nsp: "/admin", data: "Invalid namespace" },
  ],
  [
    "an event",
    {
      type: PacketType.EVENT,
      nsp: "/",
      data: ["qd:changed", { s: "taskService", topic: "byProject:p1" }],
    },
  ],
  ["an event with no arguments", { type: PacketType.EVENT, nsp: "/", data: ["qd:rotate"] }],
  [
    "an event that expects an ack",
    {
      type: PacketType.EVENT,
      nsp: "/",
      id: 0,
      data: ["qd:call", { id: 1, s: "taskService", m: "get", i: { id: "t1" } }],
    },
  ],
  ["an event with a numeric name", { type: PacketType.EVENT, nsp: "/", data: [42, "x"] }],
  [
    "an ack",
    {
      type: PacketType.ACK,
      nsp: "/",
      id: 12,
      data: [{ ok: true, d: row(1), v: 1_759_400_000_000 }],
    },
  ],
  ["an ack with no arguments", { type: PacketType.ACK, nsp: "/", id: 3, data: [] }],
  [
    "an ack with several arguments",
    { type: PacketType.ACK, nsp: "/", id: 4, data: [null, "two", 3] },
  ],
  [
    "empty data: empty objects, arrays and strings",
    { type: PacketType.EVENT, nsp: "/", data: ["empty", {}, [], [[]], { a: {} }, ""] },
  ],
  [
    "nested objects and arrays",
    {
      type: PacketType.EVENT,
      nsp: "/",
      data: [
        "qd:c",
        {
          s: "taskService",
          c: "byProject",
          scope: "p1",
          rev: 1_759_400_000_007,
          deltas: [
            { t: "added", item: row(3), index: ["task_3", 1_759_400_000_007, "done", 3] },
            { t: "patched", id: "task_1", d: { title: "Renamed", meta: { tags: [["x"]] } } },
            { t: "removed", id: "task_2" },
            { t: "reset" },
          ],
        },
      ],
    },
  ],
  [
    "unicode",
    { type: PacketType.EVENT, nsp: "/", data: ["chat", { text: UNICODE, [UNICODE]: [UNICODE] }] },
  ],
  [
    "lone surrogates",
    { type: PacketType.EVENT, nsp: "/", data: ["chat", "\ud800 x \udfff y \udbff\udfff"] },
  ],
  [
    "characters JSON escapes",
    {
      type: PacketType.EVENT,
      nsp: "/",
      data: ["chat", 'quote " backslash \\ \n\r\t\b\f nul \u0000 \u001f \u007f </script>'],
    },
  ],
  [
    "numbers",
    {
      type: PacketType.EVENT,
      nsp: "/",
      data: [
        "n",
        0,
        -0,
        1.5,
        -1e-7,
        1e21,
        Number.MAX_SAFE_INTEGER,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ],
    },
  ],
  [
    "undefined and null values",
    {
      type: PacketType.EVENT,
      nsp: "/",
      data: ["n", null, { a: undefined, b: null }, [undefined, null]],
    },
  ],
  [
    "values with toJSON",
    {
      type: PacketType.EVENT,
      nsp: "/",
      data: ["d", new Date(0), { toJSON: (): unknown => ({ replaced: true }) }],
    },
  ],
  [
    "an event in a custom namespace",
    {
      type: PacketType.EVENT,
      nsp: "/admin",
      data: ["qd:e", { t: "r", s: "taskService", id: "t1", rev: 9 }],
    },
  ],
  [
    "an event with an ack id in a custom namespace",
    { type: PacketType.EVENT, nsp: "/admin", id: 31, data: ["qd:sub", { s: "a", ids: ["1"] }] },
  ],
  [
    "an ack in a custom namespace",
    {
      type: PacketType.ACK,
      nsp: "/tenant-42",
      id: 5,
      data: [{ ok: false, e: { code: "FORBIDDEN", message: "No" } }],
    },
  ],
  ["an ack id of 2^31", { type: PacketType.ACK, nsp: "/", id: 2 ** 31, data: [{ ok: true }] }],
  [
    "the largest safe ack id",
    { type: PacketType.ACK, nsp: "/admin", id: Number.MAX_SAFE_INTEGER, data: [{ ok: true }] },
  ],
  [
    "a 2,000-row response",
    {
      type: PacketType.ACK,
      nsp: "/",
      id: 77,
      data: [{ ok: true, d: Array.from({ length: 2000 }, (_, n) => row(n)) }],
    },
  ],
];

// A small seeded generator (mulberry32), so the fuzz cases are the same on every run.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALPHABET = [
  "a",
  "Z",
  "0",
  " ",
  '"',
  "\\",
  "\n",
  "é",
  "你",
  "🎉",
  "\u0000",
  "\ud800",
  "/",
  ",",
];

function randomString(next: () => number): string {
  const length = Math.floor(next() * 8);
  return Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join("");
}

function randomValue(next: () => number, depth: number): unknown {
  const kinds = depth > 3 ? 5 : 7;
  const kind = Math.floor(next() * kinds);
  if (kind === 0) return null;
  if (kind === 1) return next() < 0.5;
  if (kind === 2) return Math.floor(next() * 2e6) - 1e6 + (next() < 0.3 ? next() : 0);
  if (kind === 3) return randomString(next);
  if (kind === 4) return undefined;
  const size = Math.floor(next() * 4);
  if (kind === 5) return Array.from({ length: size }, () => randomValue(next, depth + 1));
  return Object.fromEntries(
    Array.from({ length: size }, () => [randomString(next), randomValue(next, depth + 1)]),
  );
}

function randomPacket(next: () => number): Packet {
  const nsp = ["/", "/admin", "/tenant-42"][Math.floor(next() * 3)] ?? "/";
  const id = next() < 0.5 ? undefined : Math.floor(next() * Number.MAX_SAFE_INTEGER);
  const args = Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, 0));
  return next() < 0.5
    ? { type: PacketType.EVENT, nsp, id, data: [randomString(next) || "e", ...args] }
    : { type: PacketType.ACK, nsp, id: id ?? 0, data: args };
}

const stock = new Encoder();

function stockText(packet: Packet): string {
  const [text]: unknown[] = stock.encode(packet);
  if (typeof text !== "string") {
    throw new TypeError("the stock encoder wrote binary for a fixture");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

describe("the JSON parser's encoder", () => {
  const encoder = new (createJsonParser().Encoder)();

  it.each(FIXTURES)("writes %s byte for byte as the stock encoder does", (_label, packet) => {
    const written = encoder.encode(packet);
    expect(written).toEqual(stock.encode(packet));
    expect(written).toHaveLength(1);
    const [text] = written;
    expect(typeof text).toBe("string");
    expect(Buffer.from(String(text), "utf8").equals(Buffer.from(stockText(packet), "utf8"))).toBe(
      true,
    );
  });

  it("matches the stock encoder on 500 generated events and acks", () => {
    const next = seeded(20_261_002);
    for (let n = 0; n < 500; n += 1) {
      const packet = randomPacket(next);
      expect(encoder.encode(packet), `generated packet ${n}`).toEqual([stockText(packet)]);
    }
  });

  it("does not change the packet it encodes", () => {
    const packet: Packet = {
      type: PacketType.ACK,
      nsp: "/",
      id: 1,
      data: [{ ok: true, d: row(1) }],
    };
    const before = structuredClone(packet);
    encoder.encode(packet);
    expect(packet).toEqual(before);
  });

  it("returns a fresh parser per call, each with the stock decoder", () => {
    const first = createJsonParser();
    const second = createJsonParser();
    expect(first.Encoder).not.toBe(second.Encoder);
    expect(first.Decoder).toBe(Decoder);
    expect(new first.Encoder()).toBeInstanceOf(Encoder);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("binary arguments", () => {
  const encoder = new (createJsonParser().Encoder)();

  it.each([
    ["Buffer", Buffer.from("hi")],
    ["Uint8Array", new Uint8Array([1, 2])],
    ["Float64Array", new Float64Array(2)],
    ["ArrayBuffer", new ArrayBuffer(4)],
    ["DataView", new DataView(new ArrayBuffer(2))],
    ["Blob", new Blob(["hi"])],
  ])("throw a TypeError when an event argument is a binary %s", (_label, value) => {
    const packet: Packet = { type: PacketType.EVENT, nsp: "/", data: ["upload", "a.png", value] };
    expect(() => encoder.encode(packet)).toThrow(TypeError);
    expect(() => encoder.encode(packet)).toThrow(
      /^Argument 2 of event "upload" is binary \(\w+\), which the JSON-only Socket\.IO parser cannot send\. Use the stock Socket\.IO parser/,
    );
  });

  it("throw for a binary acknowledgement argument, naming the acknowledgement", () => {
    const packet: Packet = { type: PacketType.ACK, nsp: "/", id: 7, data: [new Uint8Array(1)] };
    expect(() => encoder.encode(packet)).toThrow(
      "Argument 1 of acknowledgement 7 is binary (Uint8Array)",
    );
  });

  it("are not looked for inside an argument: JSON.stringify writes them", () => {
    const packet: Packet = {
      type: PacketType.EVENT,
      nsp: "/",
      data: ["upload", { file: Buffer.from("hi") }],
    };
    expect(encoder.encode(packet)).toEqual([
      '2["upload",{"file":{"type":"Buffer","data":[104,105]}}]',
    ]);
  });
});

// ---------------------------------------------------------------------------
// onEncoded
// ---------------------------------------------------------------------------

describe("onEncoded", () => {
  it("reports every packet with the UTF-8 byte length of what was written", () => {
    const reports: { packet: Packet; bytes: number }[] = [];
    const encoder = new (createJsonParser({
      onEncoded: (packet, bytes) => {
        reports.push({ packet, bytes });
      },
    }).Encoder)();

    for (const [, packet] of FIXTURES) {
      const [text] = encoder.encode(packet);
      const report = reports.at(-1);
      expect(report?.packet).toBe(packet);
      expect(report?.bytes).toBe(Buffer.byteLength(String(text), "utf8"));
    }
    expect(reports).toHaveLength(FIXTURES.length);
  });

  it("counts bytes, not characters", () => {
    let reported = 0;
    const encoder = new (createJsonParser({
      onEncoded: (_packet, bytes) => {
        reported = bytes;
      },
    }).Encoder)();
    const [text] = encoder.encode({ type: PacketType.EVENT, nsp: "/", data: ["chat", UNICODE] });
    expect(reported).toBe(Buffer.byteLength(String(text), "utf8"));
    expect(reported).toBeGreaterThan(String(text).length);
  });

  it("never throws into the encoder: a failing hook is ignored and the packet is still written", () => {
    const encoder = new (createJsonParser({
      onEncoded: () => {
        throw new Error("metrics are down");
      },
    }).Encoder)();
    const packet: Packet = { type: PacketType.ACK, nsp: "/", id: 2, data: [{ ok: true, d: 1 }] };
    expect(encoder.encode(packet)).toEqual([stockText(packet)]);
  });
});

describe("UTF-8 byte length", () => {
  const samples: [label: string, sample: string][] = [
    ["an empty string", ""],
    ["ASCII", "ascii only"],
    ["mixed scripts, emoji and combining marks", UNICODE],
    ["the 1-, 2- and 3-byte boundaries", "\u007f\u0080\u07ff\u0800\uffff"],
    ["surrogate pairs", "🎉".repeat(3)],
    ["a lone high surrogate", "\ud83c"],
    ["a lone low surrogate", "\udf89"],
    ["a high surrogate followed by ASCII", "a\ud83cb"],
    ["a reversed pair", "\udf89\ud83c"],
    ["a high surrogate before a pair", "\ud83c🎉"],
    ["a long string", "x".repeat(10_000) + "é"],
  ];

  it.each(samples)(
    "counts %s as Buffer.byteLength does, with and without Buffer",
    (_label, sample) => {
      const expected = Buffer.byteLength(sample, "utf8");
      expect(utf8ByteLength(sample)).toBe(expected);
      expect(countUtf8Bytes(sample)).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

describe("the JSON parser's decoder", () => {
  function decode(text: string): Packet {
    const decoder = new (createJsonParser().Decoder)();
    let decoded: Packet | undefined;
    decoder.on("decoded", (packet: Packet) => {
      decoded = packet;
    });
    decoder.add(text);
    if (decoded === undefined) {
      throw new Error(`nothing decoded from ${text}`);
    }
    return decoded;
  }

  const roundTrips = FIXTURES.filter(([label]) =>
    [
      "an event that expects an ack",
      "an ack",
      "nested objects and arrays",
      "unicode",
      "an event in a custom namespace",
      "an ack in a custom namespace",
      "the largest safe ack id",
    ].includes(label),
  );

  it.each(roundTrips)("reads back %s as it was sent", (_label, packet) => {
    const [text] = new (createJsonParser().Encoder)().encode(packet);
    const decoded = decode(String(text));
    expect(decoded).toEqual({
      type: packet.type,
      nsp: packet.nsp,
      ...(packet.id === undefined ? {} : { id: packet.id }),
      data: JSON.parse(JSON.stringify(packet.data)),
    });
  });
});

// ---------------------------------------------------------------------------
// Real sockets
// ---------------------------------------------------------------------------

describe("over a real Socket.IO connection", () => {
  const servers: Server[] = [];
  const clients: ClientSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  });

  async function listen(parser: JsonParser | undefined): Promise<{ io: Server; url: string }> {
    const httpServer = createServer();
    const io = new Server(httpServer, parser === undefined ? {} : { parser });
    servers.push(io);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const { port } = httpServer.address() as AddressInfo;
    return { io, url: `http://127.0.0.1:${port}` };
  }

  function open(url: string, parser: JsonParser | undefined): ClientSocket {
    const client = connect(url, {
      forceNew: true,
      transports: ["websocket"],
      ...(parser === undefined ? {} : { parser }),
    });
    clients.push(client);
    return client;
  }

  function nextEvent(socket: ClientSocket, event: string): Promise<unknown> {
    return new Promise((resolve) => {
      socket.once(event, resolve);
    });
  }

  type Ack = (reply: unknown) => void;
  const payload = {
    text: UNICODE,
    nested: { list: [1, null, "x", { deep: true }] },
    rows: [row(1)],
  };
  const expected: unknown = JSON.parse(JSON.stringify(payload));

  it.each([
    ["both ends use the JSON parser", true, true],
    ["only the server uses it", true, false],
    ["only the client uses it", false, true],
  ])("exchanges events and acks both ways when %s", async (_label, onServer, onClient) => {
    const { io, url } = await listen(onServer ? createJsonParser() : undefined);
    const serverAsked = new Promise<unknown>((resolve, reject) => {
      io.on("connection", (socket) => {
        socket.on("echo", (value: unknown, ack: Ack) => {
          ack({ ok: true, d: value });
        });
        socket.emit("greeting", payload);
        socket.timeout(5000).emitWithAck("ask", payload).then(resolve, reject);
      });
    });

    const client = open(url, onClient ? createJsonParser() : undefined);
    const greeting = nextEvent(client, "greeting");
    client.on("ask", (value: unknown, ack: Ack) => {
      ack({ ok: true, d: value });
    });

    await expect(greeting).resolves.toEqual(expected);
    await expect(client.timeout(5000).emitWithAck("echo", payload)).resolves.toEqual({
      ok: true,
      d: expected,
    });
    await expect(serverAsked).resolves.toEqual({ ok: true, d: expected });
  });

  it("broadcasts through the adapter, which encodes once for every recipient", async () => {
    const { io, url } = await listen(createJsonParser());
    const client = open(url, createJsonParser());
    await nextEvent(client, "connect");
    const news = nextEvent(client, "news");
    io.emit("news", payload);
    await expect(news).resolves.toEqual(expected);
  });

  it("works in a custom namespace", async () => {
    const { io, url } = await listen(createJsonParser());
    io.of("/admin").on("connection", (socket) => {
      socket.on("echo", (value: unknown, ack: Ack) => {
        ack(value);
      });
    });
    const client = open(`${url}/admin`, createJsonParser());
    await expect(client.timeout(5000).emitWithAck("echo", payload)).resolves.toEqual(expected);
  });

  it("reports the size of each packet the server writes, the ack included", async () => {
    const reports: { packet: Packet; bytes: number }[] = [];
    const { io, url } = await listen(
      createJsonParser({
        onEncoded: (packet, bytes) => {
          reports.push({ packet, bytes });
        },
      }),
    );
    io.on("connection", (socket) => {
      socket.on("echo", (value: unknown, ack: Ack) => {
        ack({ ok: true, d: value });
      });
    });
    const client = open(url, undefined);
    await client.timeout(5000).emitWithAck("echo", payload);

    const acks = reports.filter(({ packet }) => packet.type === PacketType.ACK);
    expect(acks).toHaveLength(1);
    const ack = acks[0] ?? { packet: { type: PacketType.ACK, nsp: "/" }, bytes: Number.NaN };
    expect(ack.packet.data).toEqual([{ ok: true, d: expected }]);
    expect(ack.bytes).toBe(Buffer.byteLength(stockText(ack.packet), "utf8"));
    expect(reports.some(({ packet }) => packet.type === PacketType.CONNECT)).toBe(true);
  });
});
