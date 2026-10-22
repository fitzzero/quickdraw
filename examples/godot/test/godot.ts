// The Godot check, `bun run check:godot` (after `bun run build` at the
// repository root): starts the game server (`game.ts`), runs the GDScript
// client headless through `smoke.gd` with Godot 4 (`GODOT`, else `godot` on
// the PATH), sends `qd:rotate` (a window of `ROTATE_WITHIN_MS`, which the
// script knows too) when the script asks, plays the player "bo" who offers
// the client a peer link over the relay when it asks (`offerLink`), and
// passes when every check of the script held and the client wrote exactly the
// frames of `frames.ts`, the ones the Node wire test writes too, its peer
// link's clock pings aside. It also plays a newer
// server, as a later revision of protocol 5 may be (docs/protocol-v5.md, "What
// a client must do"): every `qd:hello` carries a field more, and when the
// script asks it sends frames with elements appended and fields added.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { io as connectSocket, type Socket } from "socket.io-client";
import { isClockFrame, sessionWith } from "./frames";
import { startServer, WORLD, type GameServer } from "./game";

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 60_000;
/** The `qd:rotate` window; `smoke.gd`'s `ROTATE_WITHIN_MS` is the same. */
const ROTATE_WITHIN_MS = 1000;

interface Run {
  readonly code: number;
  /** What the client wrote, pongs aside. */
  readonly sent: readonly string[];
  /** The script's `RESULT` line. */
  readonly result: { readonly checks?: number; readonly failures?: readonly string[] } | undefined;
  /** The socket id of the player who offered the client a link. */
  readonly peer: string | undefined;
}

/** The text of a link message carrying `data`. */
const linkText = (data: unknown): string => JSON.stringify([0, data]);

/**
 * The player "bo", for the script's peer link: joins the world, finds the
 * client's socket ("ada"), and offers it a link over the relay, as a client
 * without WebRTC does. Once the client answers, bo says hello on `rel`; once
 * the client says hello back, bo closes the link. Resolves with bo's socket.
 */
async function offerLink(server: GameServer): Promise<Socket> {
  const bo = connectSocket(server.url, {
    forceNew: true,
    transports: ["websocket"],
    auth: { token: "bo", qd: { protocol: 5, client: "harness" } },
  });
  await new Promise((resolve) => {
    bo.once("qd:hello", resolve);
  });
  await bo
    .timeout(5000)
    .emitWithAck("qd:call", { id: 0, s: "gameService", m: "join", i: { name: "bo" } });
  const ada = [...server.server.io.sockets.sockets.values()].find(
    (socket) => socket.data.principal?.userId === "ada",
  );
  if (ada === undefined) {
    throw new Error("offerLink: the client is not connected");
  }
  bo.on("qd:peer", (frame: { readonly from: string; readonly sig: { readonly relay?: true } }) => {
    if (frame.from === ada.id && frame.sig.relay === true) {
      bo.emit("qd:relay", [WORLD, ada.id, "rel", linkText({ hi: "ada" })]);
    }
  });
  bo.on("qd:relay", (frame: readonly string[]) => {
    if (frame[1] === ada.id && frame[3] === linkText({ hi: "bo" })) {
      bo.emit("qd:peer", { room: WORLD, to: ada.id, sig: { bye: true } });
    }
  });
  bo.emit("qd:peer", { room: WORLD, to: ada.id, sig: { relay: true } });
  return bo;
}

/** Adds a field to every `qd:hello` the server sends, as a later revision of protocol 5 may. */
function helloWithFieldMore(server: GameServer): void {
  server.server.io.use((socket, next) => {
    const emit = socket.emit.bind(socket) as (event: string, ...args: unknown[]) => boolean;
    (socket as unknown as { emit: typeof emit }).emit = (event, ...args) =>
      event === "qd:hello"
        ? emit(event, { ...(args[0] as object), future: { added: true } }, ...args.slice(1))
        : emit(event, ...args);
    next();
  });
}

/** Frames a later revision of protocol 5 may send: an element appended to arrays, a field added to objects. */
function sendLaterRevision(server: GameServer): void {
  const { io } = server.server;
  io.emit("qd:stream", ["gameService", "ticks", null, { n: 101 }, "future", { y: 2 }]);
  io.emit("qd:event", ["gameService", "moved", { userId: "bo", dx: 7, dy: 0 }, "future"]);
  io.emit("qd:presence", { room: "world:main", users: ["ada", "bo"], future: 1 });
  io.emit("qd:changed", { s: "gameService", topic: "service", rev: 1, future: 2 });
  io.emit("qd:revoked", { kind: "entity", reason: "access", s: "gameService", id: "x", future: 3 });
}

/** Runs `smoke.gd` against `server`, echoing Godot's output and answering its `STEP` lines. */
function runGodot(server: GameServer): Promise<Run> {
  const godot = process.env.GODOT ?? "godot";
  const child = spawn(godot, ["--headless", "--path", PROJECT, "--script", "res://test/smoke.gd"], {
    env: { ...process.env, QD_URL: server.url, QD_TRACE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const sent: string[] = [];
  let result: Run["result"];
  let peer: Socket | undefined;
  createInterface({ input: child.stdout }).on("line", (line) => {
    process.stdout.write(`${line}\n`);
    if (line.startsWith(">> ")) {
      sent.push(line.slice(3));
    } else if (line === "STEP rotate") {
      server.server.rotate({ withinMs: ROTATE_WITHIN_MS });
    } else if (line === "STEP later") {
      sendLaterRevision(server);
    } else if (line === "STEP peer") {
      offerLink(server).then(
        (socket) => {
          peer = socket;
        },
        (error: unknown) => {
          process.stderr.write(`check:godot: the peer link's player failed: ${String(error)}\n`);
        },
      );
    } else if (line.startsWith("RESULT ")) {
      result = JSON.parse(line.slice("RESULT ".length)) as Run["result"];
    }
  });
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      peer?.disconnect();
      resolve({ code: code ?? 1, sent, result, peer: peer?.id });
    });
  });
}

/** The frames that differ from the session (with its peer link to `peer`), by position, clock pings aside. */
function differences(written: readonly string[], peer: string): string[] {
  const sent = written.filter((frame) => !isClockFrame(frame));
  const session = sessionWith(peer);
  const length = Math.max(sent.length, session.length);
  return Array.from({ length }, (_, index) => index).flatMap((index) =>
    sent[index] === session[index]
      ? []
      : [
          `frame ${index}: wrote ${sent[index] ?? "nothing"}, expected ${session[index] ?? "nothing"}`,
        ],
  );
}

async function main(): Promise<number> {
  const server = await startServer();
  helloWithFieldMore(server);
  try {
    const run = await runGodot(server);
    const problems = [
      ...(run.code === 0 ? [] : [`godot exited with ${String(run.code)}`]),
      ...(run.result === undefined ? ["the script printed no RESULT"] : []),
      ...(run.result?.failures ?? []).map((failure) => `check failed: ${failure}`),
      ...(run.peer === undefined ? ["the peer link's player never offered"] : []),
      ...differences(run.sent, run.peer ?? ""),
    ];
    if (problems.length > 0) {
      process.stderr.write(`${problems.map((problem) => `check:godot: ${problem}`).join("\n")}\n`);
      return 1;
    }
    process.stdout.write(
      `check:godot: ${String(run.result?.checks)} checks held; the client wrote the ${String(sessionWith(run.peer ?? "").length)} frames of the session\n`,
    );
    return 0;
  } finally {
    await server.close();
  }
}

process.exitCode = await main();
