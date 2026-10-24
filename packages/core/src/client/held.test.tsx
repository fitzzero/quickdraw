// A call made while its socket has no hello of its own (RFC 0003 sections
// 6, 8.2 and 11.1): the connection holds it, never in Socket.IO's send
// buffer, and sends it only once that hello names the user the call was
// made as. A session cookie can name someone else at a reconnect without
// the app knowing, and only the new socket's hello says so. Against a real
// server whose `save` and `read` answer whom they ran for. A test that
// changes the principal it rendered with changes whom the next connect
// speaks for, as a cookie would; holding the server's hello back opens the
// window between a connect and its hello, as a browser's separate frames
// do.

import { QueryClient } from "@tanstack/react-query";
import { act, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { QuickdrawError, defineContract, mutation, query } from "../index";
import { initQuickdraw, type Principal } from "../server/index";
import { deferred, tick } from "../server/__tests__/fixtures";
import { renderWithQuickdraw } from "../testing/client";
import { createTestApp, type TestApp } from "../testing/index";
import { callHoldOf, type QuickdrawConnection } from "./connection";
import { createQuickdrawClient } from "./createClient";
import { useJoin } from "./join";
import { useQuickdraw } from "./provider";
import { outgoing } from "./__tests__/fixtures";

const server = initQuickdraw<{ principal: Principal }>();

const notes = defineContract("noteService", {
  methods: {
    save: mutation({
      input: z.object({ text: z.string() }),
      output: z.object({ by: z.string(), text: z.string() }),
    }),
    read: query({
      input: z.object({ text: z.string() }),
      output: z.object({ by: z.string(), text: z.string() }),
    }),
  },
});

/** Every call the server ran, in order: `<method>:<text> as <user>`. */
const ran: string[] = [];
/** Every save the server finished, by whom. */
const saved: { readonly by: string; readonly text: string }[] = [];

const noteService = server.defineService(notes, {
  methods: {
    save: {
      access: "authenticated",
      handler: ({ input, ctx }) => {
        ran.push(`save:${input.text} as ${ctx.principal.userId}`);
        saved.push({ by: ctx.principal.userId, text: input.text });
        return { by: ctx.principal.userId, text: input.text };
      },
    },
    read: {
      access: "authenticated",
      handler: ({ input, ctx }) => {
        ran.push(`read:${input.text} as ${ctx.principal.userId}`);
        return { by: ctx.principal.userId, text: input.text };
      },
    },
  },
});

const qd = createQuickdrawClient({ notes });
const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  ran.length = 0;
  saved.length = 0;
});

/** Whom the connection's hello names, as a render shows it. */
function Who() {
  const { userId, hello } = useQuickdraw();
  return <p>{hello === null ? "no hello" : `as ${userId ?? "anonymous"}`}</p>;
}

/** A test app whose `authenticate` refuses `refused`, and trusts any other principal. */
async function appRefusing(refused?: string) {
  const app = await createTestApp({
    services: [noteService],
    auth: {
      authenticate: ({ auth }) => {
        const { principal } = auth as { readonly principal?: Principal };
        if (refused !== undefined && principal?.userId === refused) {
          throw new QuickdrawError("UNAUTHENTICATED", "refused");
        }
        return principal ?? null;
      },
    },
  });
  apps.push(app as unknown as TestApp);
  return app;
}

/**
 * `principal` signed in on a test app, its hello arrived. The test changes
 * `principal` to change whom the next connect speaks for.
 */
async function signedIn(principal = { userId: "ada" }, ui = <Who />) {
  const app = await appRefusing();
  const view = await renderWithQuickdraw(ui, { app, as: principal, client: qd });
  await helloFor(view.connection, principal.userId);
  return { app, view };
}

async function helloFor(connection: QuickdrawConnection, userId: string): Promise<void> {
  await waitFor(() => {
    expect(connection.getState().hello?.userId).toBe(userId);
  });
}

async function settle(ms = 100): Promise<void> {
  await act(async () => {
    await tick(ms);
  });
}

/** Keeps how `promise` ends in `outcomes`: `answered for <user>`, or `<code>: <message>`. */
function noted(outcomes: string[], promise: Promise<{ readonly by: string }>): void {
  promise.then(
    (out) => outcomes.push(`answered for ${out.by}`),
    (error: unknown) =>
      outcomes.push(
        error instanceof QuickdrawError ? `${error.code}: ${error.message}` : String(error),
      ),
  );
}

/** Holds back every `qd:hello` `socket` receives until the returned function lets them in. */
function holdHellos(socket: unknown): () => void {
  const patched = socket as { onevent: (packet: { readonly data?: unknown }) => void };
  const deliver = patched.onevent.bind(patched);
  const waiting: { readonly data?: unknown }[] = [];
  patched.onevent = (packet) => {
    if (Array.isArray(packet.data) && packet.data[0] === "qd:hello") {
      waiting.push(packet);
    } else {
      deliver(packet);
    }
  };
  return () => {
    Reflect.deleteProperty(patched, "onevent");
    for (const packet of waiting.splice(0)) {
      deliver(packet);
    }
  };
}

/** Connects a socket `disconnect()` dropped, without waiting for its hello. */
async function connectAgain(connection: QuickdrawConnection): Promise<void> {
  await act(async () => {
    connection.socket.io.reconnection(true);
    connection.socket.connect();
    await tick();
  });
  await waitFor(() => {
    expect(connection.socket.connected).toBe(true);
  });
}

const changed = "CANCELLED: The user changed before the call was sent";

describe("a call made while its socket has no hello of its own", () => {
  it("is held, never buffered, and sent as its user once the first hello comes", async () => {
    const app = await appRefusing();
    const view = await renderWithQuickdraw(<Who />, { app, as: { userId: "ada" }, client: qd });
    const letIn = holdHellos(view.connection.socket);
    const outcomes: string[] = [];
    noted(outcomes, qd.notes.save.call({ text: "before-the-hello" }));
    await waitFor(() => {
      expect(view.connection.socket.connected).toBe(true);
    });
    await settle(30);
    // Connected, and no hello yet: nothing has gone out.
    expect(callHoldOf(view.connection)?.size).toBe(1);
    expect(view.connection.socket.sendBuffer).toEqual([]);
    expect(ran).toEqual([]);
    letIn();
    await helloFor(view.connection, "ada");
    await settle();
    expect(outcomes).toEqual(["answered for ada"]);
    expect(saved).toEqual([{ by: "ada", text: "before-the-hello" }]);
  });

  it("refuses Ada's .call() write made while the socket was down once a cookie names Ed at the reconnect", async () => {
    const principal = { userId: "ada" };
    const { view } = await signedIn(principal);
    await view.disconnect();
    const outcomes: string[] = [];
    noted(outcomes, qd.notes.save.call({ text: "ada-while-down" }));
    expect(callHoldOf(view.connection)?.size).toBe(1);
    expect(view.connection.socket.sendBuffer).toEqual([]);
    principal.userId = "ed";
    await view.reconnect();
    await settle();
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([changed]);
  });

  it("refuses Ada's .call() read made while the socket was down once a cookie names Ed: her code gets no answer of his", async () => {
    const principal = { userId: "ada" };
    const { view } = await signedIn(principal);
    await view.disconnect();
    const outcomes: string[] = [];
    noted(outcomes, qd.notes.read.call({ text: "ada-read" }));
    principal.userId = "ed";
    await view.reconnect();
    await settle();
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([changed]);
  });

  it("refuses a hook's call made while the socket was down once a cookie names Ed at the reconnect", async () => {
    const principal = { userId: "ada" };
    const calls: { save?: ReturnType<typeof qd.notes.save.useMutation> } = {};
    function Saver() {
      const save = qd.notes.save.useMutation();
      calls.save = save;
      return <Who />;
    }
    const { view } = await signedIn(principal, <Saver />);
    await view.disconnect();
    const outcomes: string[] = [];
    act(() => {
      if (calls.save !== undefined) {
        noted(outcomes, calls.save.mutateAsync({ text: "ada-hook-while-down" }));
      }
    });
    // The hook's own check passes on the hello a drop keeps: the socket holds the call.
    await waitFor(() => {
      expect(callHoldOf(view.connection)?.size).toBe(1);
    });
    principal.userId = "ed";
    await view.reconnect();
    await settle();
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([changed]);
  });

  it.each([
    ["sends it as Ada", "ada", ["save:ada-window as ada"], ["answered for ada"]],
    ["refuses it", "ed", [], [changed]],
  ])(
    "holds a .call() made between a reconnect's connect and its hello, then %s when the hello names %s",
    async (_does, next, ranAfter, outcomesAfter) => {
      const principal = { userId: "ada" };
      const { view } = await signedIn(principal);
      await view.disconnect();
      principal.userId = next;
      const letIn = holdHellos(view.connection.socket);
      await connectAgain(view.connection);
      // Connected, its hello not in: the client still shows Ada's, as a drop keeps it.
      expect(view.connection.getState().hello?.userId).toBe("ada");
      const outcomes: string[] = [];
      noted(outcomes, qd.notes.save.call({ text: "ada-window" }));
      await settle(30);
      expect(ran).toEqual([]);
      expect(callHoldOf(view.connection)?.size).toBe(1);
      letIn();
      await helloFor(view.connection, next);
      await settle();
      expect(ran).toEqual(ranAfter);
      expect(outcomes).toEqual(outcomesAfter);
    },
  );

  it("refuses a hook's attempt that starts between a reconnect's connect and its hello, and shows Ada no answer of Ed's", async () => {
    const principal = { userId: "ada" };
    const gate = deferred();
    const seen: string[] = [];
    const calls: { save?: ReturnType<typeof qd.notes.save.useMutation> } = {};
    function Saver() {
      const { userId } = useQuickdraw();
      const save = qd.notes.save.useMutation({
        onMutate: async () => {
          await gate.promise;
        },
      });
      calls.save = save;
      const line = `${save.status} data=${save.data?.by ?? "-"} error=${save.error?.code ?? "-"}`;
      seen.push(`${userId ?? "-"} ${line}`);
      return <p>{`${userId ?? "-"} ${line}`}</p>;
    }
    const { view } = await signedIn(principal, <Saver />);
    const outcomes: string[] = [];
    act(() => {
      if (calls.save !== undefined) {
        noted(outcomes, calls.save.mutateAsync({ text: "ada-window" }));
      }
    });
    await view.disconnect();
    principal.userId = "ed";
    const letIn = holdHellos(view.connection.socket);
    await connectAgain(view.connection);
    // Its onMutate ends now: the attempt starts on a socket whose hello is not in.
    gate.resolve();
    await settle(30);
    expect(ran).toEqual([]);
    letIn();
    await helloFor(view.connection, "ed");
    await settle();
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([changed]);
    // Ada, signed back in: her call's refusal, and no answer of Ed's.
    await view.disconnect();
    principal.userId = "ada";
    await view.reconnect();
    await within(view.container).findByText("ada error data=- error=CANCELLED");
    expect(seen.filter((line) => line.includes("data=ed"))).toEqual([]);
  });

  it("sends the calls held across a drop after the same user's hello, in order, before the joins it runs", async () => {
    function Joined() {
      useJoin(qd.notes.read, { text: "join" });
      return <Who />;
    }
    const { view } = await signedIn({ userId: "ada" }, <Joined />);
    await waitFor(() => {
      expect(ran).toEqual(["read:join as ada"]);
    });
    await view.disconnect();
    const sent = outgoing(view.connection);
    const outcomes: string[] = [];
    noted(outcomes, qd.notes.save.call({ text: "first" }));
    noted(outcomes, qd.notes.read.call({ text: "second" }));
    noted(outcomes, qd.notes.save.call({ text: "third" }));
    await view.reconnect();
    await settle();
    // Nothing lost nor reordered: the held calls went out first, then the join the hello ran.
    const calls = sent
      .filter(([event]) => event === "qd:call")
      .map(([, envelope]) => {
        const { m, i } = envelope as { readonly m: string; readonly i: { readonly text: string } };
        return `${m}:${i.text}`;
      });
    expect(calls).toEqual(["save:first", "read:second", "save:third", "read:join"]);
    expect(outcomes).toEqual(["answered for ada", "answered for ada", "answered for ada"]);
    expect(ran.filter((each) => each.startsWith("save"))).toEqual([
      "save:first as ada",
      "save:third as ada",
    ]);
  });

  it.each([
    ["refuses it", "ed", [changed]],
    ["sends it", "ada", ["answered for ada"]],
  ])(
    "holds a .call() made after the server ended Ada's session, then %s when a cookie signs %s in",
    async (_does, next, outcomesAfter) => {
      const principal = { userId: "ada" };
      const { app, view } = await signedIn(principal);
      app.server.access.disconnectUser("ada");
      await waitFor(() => {
        expect(view.connection.getState().hello).toBeNull();
      });
      principal.userId = next;
      const letIn = holdHellos(view.connection.socket);
      act(() => {
        view.connection.open();
      });
      // Made with no hello, after Ada's session ended: it is hers to send, if anyone's.
      const outcomes: string[] = [];
      noted(outcomes, qd.notes.save.call({ text: "after-ada-ended" }));
      letIn();
      await helloFor(view.connection, next);
      await settle();
      expect(outcomes).toEqual(outcomesAfter);
    },
  );

  it("sends a .call() made after a refused first connect as whoever signs in next", async () => {
    const app = await appRefusing("revoked");
    const principal = { userId: "revoked" };
    const view = await renderWithQuickdraw(<Who />, { app, as: principal, client: qd });
    await waitFor(() => {
      expect(view.connection.getState().status).toBe("refused");
    });
    principal.userId = "ed";
    act(() => {
      view.connection.open();
    });
    // No hello ever named anyone: the session the refusal ended was nobody's.
    const outcomes: string[] = [];
    noted(outcomes, qd.notes.save.call({ text: "after-the-refusal" }));
    await helloFor(view.connection, "ed");
    await settle();
    expect(outcomes).toEqual(["answered for ed"]);
  });

  it("fails a call held across the same user's new token, as the send buffer did", async () => {
    const { view } = await signedIn({ userId: "ada" });
    await view.disconnect();
    const outcomes: string[] = [];
    noted(outcomes, qd.notes.save.call({ text: "held-at-refresh" }));
    act(() => {
      view.connection.setAuth({ principal: { userId: "ada" }, refreshed: true });
    });
    await settle();
    await helloFor(view.connection, "ada");
    await settle();
    expect(outcomes).toEqual(["CANCELLED: The credentials changed before the call was sent"]);
    expect(ran).toEqual([]);
  });

  it("fails a held call unsent once its time runs out, and lets it go", async () => {
    const app = await appRefusing();
    const queryClient = new QueryClient();
    const view = await renderWithQuickdraw(<Who />, {
      app,
      as: { userId: "ada" },
      client: qd,
      queryClient,
    });
    const letIn = holdHellos(view.connection.socket);
    const outcomes: string[] = [];
    noted(outcomes, qd.notes.save.call({ text: "too-late" }, { timeoutMs: 50 }));
    await settle(120);
    expect(outcomes).toEqual(["INTERNAL: No answer: the connection to the server is down"]);
    expect(callHoldOf(view.connection)?.size).toBe(0);
    letIn();
    await helloFor(view.connection, "ada");
    await settle();
    expect(ran).toEqual([]);
  });
});
