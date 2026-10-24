// A mounted mutation hook across a switch of users (RFC 0003 sections 6,
// 11.2 and 11.4): it shows a call's state (`data`, `error`, `variables`,
// `context`, the failures, the status and its flags) only while the
// connection's hello names the user the call ran as. The next user sees
// none of the last user's, while their hello is awaited or after it: a call
// in flight at the switch, one paused offline, and one made after the
// server ended the session that failed before any hello included; the same
// user sees theirs again once new credentials' hello names them, and
// through a reconnect. Against a real server whose `save` answers who called
// it, refuses `"refuse"`, fails `"flaky"` once, and holds `"hold"` until the
// test lets it answer.

import { QueryClient, onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Component, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QuickdrawError, defineContract, mutation } from "../index";
import { initQuickdraw, type Principal } from "../server/index";
import { deferred, tick, type Deferred } from "../server/__tests__/fixtures";
import { renderWithQuickdraw } from "../testing/client";
import { createTestApp, type TestApp } from "../testing/index";
import { createQuickdrawClient } from "./createClient";
import { methodKeyPrefix } from "./keys";
import { useOverlayView, useRefusedItems, type RefusedItem } from "./live/liveHooks";
import type { OptimisticCache } from "./optimistic";
import { QuickdrawProvider, useQuickdraw } from "./provider";

const server = initQuickdraw<{ principal: Principal }>();

const notes = defineContract("noteService", {
  methods: {
    save: mutation({
      input: z.object({ text: z.string() }),
      output: z.object({ by: z.string(), n: z.number(), text: z.string() }),
    }),
  },
});

/** Every save the server finished, by whom. */
const saved: { readonly by: string; readonly text: string }[] = [];
/** While set, a save whose text starts with `"hold"` waits for it. */
let held: Deferred<void> | undefined;
/** True once a save of `"flaky"` failed: the next one goes through. */
let flaked = false;

const noteService = server.defineService(notes, {
  methods: {
    save: {
      access: "authenticated",
      handler: async ({ input, ctx }) => {
        if (input.text === "refuse") {
          throw new QuickdrawError("FORBIDDEN", "Not yours to save");
        }
        if (input.text === "flaky" && !flaked) {
          flaked = true;
          throw new QuickdrawError("INTERNAL", "Not this time");
        }
        if (input.text.startsWith("hold")) {
          await held?.promise;
        }
        saved.push({ by: ctx.principal.userId, text: input.text });
        return { by: ctx.principal.userId, n: saved.length, text: input.text };
      },
    },
  },
});

const qd = createQuickdrawClient({ notes });
const apps: TestApp[] = [];

afterEach(async () => {
  held?.resolve();
  held = undefined;
  flaked = false;
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  saved.length = 0;
});

/** Every field of TanStack's mutation state, and its flags: what a render shows of a call. */
const STATE = [
  "context",
  "data",
  "error",
  "failureCount",
  "failureReason",
  "isPaused",
  "status",
  "submittedAt",
  "variables",
  "isIdle",
  "isPending",
  "isSuccess",
  "isError",
] as const;

/** The state of a hook that shows no call at all. */
const NO_CALL: Readonly<Record<(typeof STATE)[number], unknown>> = {
  context: undefined,
  data: undefined,
  error: null,
  failureCount: 0,
  failureReason: null,
  isPaused: false,
  status: "idle",
  submittedAt: 0,
  variables: undefined,
  isIdle: true,
  isPending: false,
  isSuccess: false,
  isError: false,
};

/** What each render showed: the user the connection acted for then, a line of it, and the whole state. */
type Seen = [user: string | null, shown: string, state: Readonly<Record<string, unknown>>][];

/** What a render shows of a mutation that has not run, or of one it may not show. */
const IDLE = "idle data=- error=- vars=-";

function Saver({
  text,
  seen,
  throwOnError,
}: {
  readonly text: string;
  readonly seen: Seen;
  readonly throwOnError?: boolean;
}) {
  const { userId } = useQuickdraw();
  const save = qd.notes.save.useMutation({
    // A context the call's callbacks get: part of the state a render shows.
    onMutate: (variables) => ({ sent: variables.text }),
    ...(throwOnError === undefined ? {} : { throwOnError }),
  });
  const data = save.data === undefined ? "-" : `${save.data.by}#${String(save.data.n)}`;
  const shown = `${save.status} data=${data} error=${save.error?.code ?? "-"} vars=${save.variables?.text ?? "-"}`;
  seen.push([userId, shown, Object.fromEntries(STATE.map((key) => [key, save[key]]))]);
  return (
    <>
      <p>{`${userId ?? "-"} ${shown}`}</p>
      <button
        type="button"
        onClick={() => {
          save.mutate({ text });
        }}
      >
        save
      </button>
    </>
  );
}

/**
 * Ada signed in on a test app, with a saver that sends `text`. `principal`
 * is the one the handshake sends: a test that changes it changes who the
 * next connect speaks for without `setAuth`, as a session cookie would.
 */
async function signedIn(text: string, principal = { userId: "ada" }) {
  const app = await createTestApp({ services: [noteService] });
  apps.push(app as unknown as TestApp);
  const seen: Seen = [];
  const view = await renderWithQuickdraw(<Saver text={text} seen={seen} />, {
    app,
    as: principal,
    client: qd,
  });
  const shown = within(view.container);
  // Ada's hello names her before she saves (a call made before it is a test of its own).
  await shown.findByText(`ada ${IDLE}`);
  return { app, view, seen, shown };
}

/** The renders since `from` while the connection acted for anyone but Ada, nobody included. */
const notAda = (seen: Seen, from: number): Seen =>
  seen.slice(from).filter(([user]) => user !== "ada");

/** Each of `renders` showed no call at all: every field of the state is an idle hook's. */
function expectNoCall(renders: Seen): void {
  expect(renders).not.toHaveLength(0);
  const lines = JSON.stringify(renders.map(([, shown]) => shown));
  for (const [, , state] of renders) {
    expect(state, lines).toEqual(NO_CALL);
  }
}

/** New credentials for `userId`, and their hello awaited. */
async function switchTo(view: Awaited<ReturnType<typeof signedIn>>["view"], userId: string) {
  await act(async () => {
    view.connection.setAuth({ principal: { userId } });
    await tick();
  });
  await within(view.container).findByText(new RegExp(`^${userId} `));
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

/** A boundary that records the code of every error a render throws, and shows `caught`. */
function boundaryOf(caught: string[]) {
  return class Boundary extends Component<{ readonly children: ReactNode }, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }
    override componentDidCatch(error: unknown): void {
      caught.push(error instanceof QuickdrawError ? error.code : String(error));
    }
    override render(): ReactNode {
      return this.state.failed ? <p>caught</p> : this.props.children;
    }
  };
}

describe("a mounted mutation hook across a switch of users", () => {
  it("shows the next user none of the last user's result, data and input", async () => {
    const { view, seen, shown } = await signedIn("ada-note");
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("ada success data=ada#1 error=- vars=ada-note");
    const switched = seen.length;
    await switchTo(view, "ed");
    expectNoCall(notAda(seen, switched));
  });

  it("shows the next user none of the last user's refused call", async () => {
    const { view, seen, shown } = await signedIn("refuse");
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("ada error data=- error=FORBIDDEN vars=refuse");
    const switched = seen.length;
    await switchTo(view, "ed");
    expectNoCall(notAda(seen, switched));
  });

  it("never shows the next user a call the last user had in flight at the switch", async () => {
    held = deferred();
    const { view, seen, shown } = await signedIn("hold");
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("ada pending data=- error=- vars=hold");
    const switched = seen.length;
    await switchTo(view, "ed");
    // The server answers Ada's call now, on the socket new credentials closed.
    held.resolve();
    await act(async () => {
      await tick(50);
    });
    expectNoCall(notAda(seen, switched));
    expect(shown.getByText(`ed ${IDLE}`)).toBeTruthy();
  });

  it("never shows the next user a call the last user made offline, paused", async () => {
    // TanStack pauses a mutation while it takes the browser to be offline.
    onlineManager.setOnline(false);
    try {
      const { view, seen, shown } = await signedIn("offline-note");
      fireEvent.click(shown.getByText("save"));
      await shown.findByText("ada pending data=- error=- vars=offline-note");
      expect(seen.at(-1)?.[2]).toMatchObject({ isPaused: true });
      const switched = seen.length;
      await switchTo(view, "ed");
      expectNoCall(notAda(seen, switched));
      // Gone before the browser is back online, so the paused call is never sent.
      view.unmount();
    } finally {
      onlineManager.setOnline(true);
    }
    expect(saved).toEqual([]);
  });

  it("shows a call made after the server ended the session to its viewer, and nobody once the next user signs in", async () => {
    const { app, view, seen, shown } = await signedIn("ada-note");
    app.server.access.disconnectUser("ada");
    await shown.findByText(`- ${IDLE}`);
    // Typed and sent with no session: no socket takes it, and it fails at once, for all to see.
    view.rerender(<Saver text="typed-after-ada-ended" seen={seen} />);
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("- error data=- error=INTERNAL vars=typed-after-ada-ended");
    // Other credentials: the call was made under the last ones, so the next user never sees it.
    const signedInAgain = seen.length;
    await switchTo(view, "ed");
    await act(async () => {
      await tick(50);
    });
    expectNoCall(notAda(seen, signedInAgain));
    expect(saved).toEqual([]);
  });

  it("shows nobody a call that failed after the server ended the session once a cookie signs the next user in", async () => {
    const principal = { userId: "ada" };
    const { app, view, seen, shown } = await signedIn("ada-note", principal);
    app.server.access.disconnectUser("ada");
    await shown.findByText(`- ${IDLE}`);
    view.rerender(<Saver text="typed-after-ada-ended" seen={seen} />);
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("- error data=- error=INTERNAL vars=typed-after-ada-ended");
    // The same credentials, a cookie's, name Ed at the next connect: no epoch changes.
    const signedInAgain = seen.length;
    principal.userId = "ed";
    act(() => {
      view.connection.open();
    });
    await shown.findByText(`ed ${IDLE}`);
    await act(async () => {
      await tick(50);
    });
    expectNoCall(seen.slice(signedInAgain).filter(([user]) => user === "ed"));
    expect(saved).toEqual([]);
  });

  it("shows a call made before the first hello pending, then its answer", async () => {
    held = deferred();
    const app = await createTestApp({ services: [noteService] });
    apps.push(app as unknown as TestApp);
    const seen: Seen = [];
    const view = await renderWithQuickdraw(<Saver text="hold-first-note" seen={seen} />, {
      app,
      as: { userId: "ada" },
      client: qd,
    });
    const shown = within(view.container);
    // Sent at once, before the socket connects: it waits for it, and runs as Ada.
    expect(view.connection.getState().hello).toBeNull();
    const letIn = holdHellos(view.connection.socket);
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("- pending data=- error=- vars=hold-first-note");
    letIn();
    await shown.findByText("ada pending data=- error=- vars=hold-first-note");
    held.resolve();
    await shown.findByText("ada success data=ada#1 error=- vars=hold-first-note");
  });

  it("shows the same user's result again once their new credentials' hello names them", async () => {
    const { view, seen, shown } = await signedIn("ada-note");
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("ada success data=ada#1 error=- vars=ada-note");
    const refreshed = seen.length;
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "ada" }, refreshed: true });
      await tick();
    });
    await shown.findByText("ada success data=ada#1 error=- vars=ada-note");
    expectNoCall(seen.slice(refreshed).filter(([user]) => user === null));
  });

  it("keeps a finished call's result shown through a reconnect", async () => {
    const { view, seen, shown } = await signedIn("ada-note");
    fireEvent.click(shown.getByText("save"));
    const done = "success data=ada#1 error=- vars=ada-note";
    await shown.findByText(`ada ${done}`);
    const before = seen.length;
    await view.disconnect();
    expect(shown.getByText(`ada ${done}`)).toBeTruthy();
    await view.reconnect();
    expect(shown.getByText(`ada ${done}`)).toBeTruthy();
    const since = seen.slice(before).map(([, text]) => text);
    expect(
      since.filter((text) => text !== done),
      JSON.stringify(since),
    ).toEqual([]);
  });

  it("shows a call made while new credentials await their hello to the user it ran as", async () => {
    const { view, shown } = await signedIn("ed-note");
    act(() => {
      view.connection.setAuth({ principal: { userId: "ed" } });
    });
    expect(view.connection.getState().hello).toBeNull();
    // Sent once Ed's socket connects: it runs as Ed.
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("ed success data=ed#1 error=- vars=ed-note");
    expect(saved).toEqual([{ by: "ed", text: "ed-note" }]);
  });

  it.each([
    ["the hook's own option", { own: true, queryClient: undefined }],
    [
      "its QueryClient's default",
      {
        own: false,
        queryClient: new QueryClient({ defaultOptions: { mutations: { throwOnError: true } } }),
      },
    ],
  ])(
    "throws to an error boundary, by %s, only the errors of the user's own calls",
    async (_by, how) => {
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const caught: string[] = [];
        const Boundary = boundaryOf(caught);
        const throwOnError = how.own ? true : undefined;
        held = deferred();
        const app = await createTestApp({ services: [noteService] });
        apps.push(app as unknown as TestApp);
        const seen: Seen = [];
        const view = await renderWithQuickdraw(
          <Boundary>
            <Saver text="hold" seen={seen} throwOnError={throwOnError} />
          </Boundary>,
          { app, as: { userId: "ada" }, client: qd, queryClient: how.queryClient },
        );
        const shown = within(view.container);
        await shown.findByText(`ada ${IDLE}`);
        fireEvent.click(shown.getByText("save"));
        await shown.findByText("ada pending data=- error=- vars=hold");
        // Ada's call fails as the new credentials close her socket: never thrown into Ed's tree.
        await act(async () => {
          view.connection.setAuth({ principal: { userId: "ed" } });
          await tick();
        });
        await waitFor(() => {
          expect(view.connection.getState().hello?.userId).toBe("ed");
        });
        await act(async () => {
          await tick(50);
        });
        expect(caught).toEqual([]);
        expect(shown.getByText(`ed ${IDLE}`)).toBeTruthy();
        // Ed's own refusal still throws.
        view.rerender(
          <Boundary>
            <Saver text="refuse" seen={seen} throwOnError={throwOnError} />
          </Boundary>,
        );
        fireEvent.click(shown.getByText("save"));
        await shown.findByText("caught");
        expect(caught).toEqual(["FORBIDDEN"]);
      } finally {
        quiet.mockRestore();
      }
    },
  );
});

/** How each call a test made through the hook's `mutateAsync` ended, and the callbacks the hook ran. */
interface Calls {
  save: ReturnType<typeof qd.notes.save.useMutation> | undefined;
  /** Each call's code, `"resolved by <user>"` for one that succeeded. */
  readonly outcomes: string[];
  /** The message of each call that failed. */
  readonly messages: string[];
  readonly callbacks: string[];
}

type SaveOptions = Parameters<typeof qd.notes.save.useMutation>[0];

/** A hook the test drives through `calls`, with `options`; each render's line goes to `seen`. */
function Driven({
  calls,
  seen,
  options,
}: {
  readonly calls: Calls;
  readonly seen: Seen;
  readonly options?: SaveOptions;
}) {
  const { userId } = useQuickdraw();
  const save = qd.notes.save.useMutation({
    onError: (error) => calls.callbacks.push(`error ${error.code}`),
    onSettled: (_data, error) => calls.callbacks.push(`settled ${error?.code ?? "ok"}`),
    ...options,
  });
  calls.save = save;
  const data = save.data === undefined ? "-" : `${save.data.by}#${String(save.data.n)}`;
  const shown = `${save.status} data=${data} error=${save.error?.code ?? "-"} vars=${save.variables?.text ?? "-"}`;
  seen.push([userId, shown, {}]);
  return <p>{`${userId ?? "-"} ${shown}`}</p>;
}

/** Sends `input` through the hook's `mutateAsync`, keeping how the call ends. */
function sendInput(calls: Calls, input: { readonly text: string }): void {
  calls.save?.mutateAsync(input).then(
    (out) => calls.outcomes.push(`resolved by ${out.by}`),
    (error: unknown) => {
      calls.outcomes.push(error instanceof QuickdrawError ? error.code : String(error));
      calls.messages.push(error instanceof Error ? error.message : String(error));
    },
  );
}

/** Sends `{ text }` through the hook's `mutateAsync`, keeping how the call ends. */
function send(calls: Calls, text: string): void {
  sendInput(calls, { text });
}

/**
 * Ada signed in on a test app, with a hook the test drives. `principal` is
 * the one the handshake sends: a test that changes it changes who the next
 * connect speaks for without `setAuth`, as a session cookie would.
 */
async function driven(
  options?: SaveOptions,
  principal = { userId: "ada" },
  queryClient?: QueryClient,
) {
  const app = await createTestApp({ services: [noteService] });
  apps.push(app as unknown as TestApp);
  const seen: Seen = [];
  const calls: Calls = { save: undefined, outcomes: [], messages: [], callbacks: [] };
  const view = await renderWithQuickdraw(
    <Driven calls={calls} seen={seen} {...(options === undefined ? {} : { options })} />,
    { app, as: principal, client: qd, ...(queryClient === undefined ? {} : { queryClient }) },
  );
  await within(view.container).findByText(`ada ${IDLE}`);
  return { app, view, seen, calls };
}

/** Waits until the connection's hello names `userId`, then lets what follows settle. */
async function helloFor(view: Awaited<ReturnType<typeof driven>>["view"], userId: string) {
  await waitFor(() => {
    expect(view.connection.getState().hello?.userId).toBe(userId);
  });
}

async function settle(ms = 100): Promise<void> {
  await act(async () => {
    await tick(ms);
  });
}

describe("a call issued as one user, sent only as them", () => {
  it("refuses a call made in the task that switches the user, never sending it as the next", async () => {
    // The optimistic update runs once an attempt is let through: none opens a layer here.
    const opened: string[] = [];
    const { view, calls } = await driven({
      optimistic: (input) => {
        opened.push(input.text);
      },
    });
    act(() => {
      send(calls, "ada-same-tick");
      view.connection.setAuth({ principal: { userId: "ed" } });
    });
    await helloFor(view, "ed");
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
    expect(calls.callbacks).toEqual(["error CANCELLED", "settled CANCELLED"]);
    expect(opened).toEqual([]);
  });

  it("refuses a call made in the click that also changes the provider's credentials", async () => {
    const app = await createTestApp({ services: [noteService] });
    apps.push(app as unknown as TestApp);
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const refusals: string[] = [];
    function Switcher({ onSwitch }: { readonly onSwitch: () => void }) {
      const { userId } = useQuickdraw();
      const save = qd.notes.save.useMutation({ onError: (error) => refusals.push(error.code) });
      return (
        <>
          <p>{`user=${userId ?? "-"} ${save.status}`}</p>
          <button
            type="button"
            onClick={() => {
              save.mutate({ text: "ada-save-and-switch" });
              onSwitch();
            }}
          >
            save and switch
          </button>
        </>
      );
    }
    function App() {
      const [auth, setAuth] = useState({ principal: { userId: "ada" } });
      return (
        <QuickdrawProvider
          client={qd}
          url={app.url}
          auth={auth}
          transports={["websocket"]}
          queryClient={queryClient}
        >
          <Switcher onSwitch={() => setAuth({ principal: { userId: "ed" } })} />
        </QuickdrawProvider>
      );
    }
    const view = render(<App />);
    const shown = within(view.container);
    await shown.findByText(/^user=ada idle/);
    fireEvent.click(shown.getByText("save and switch"));
    await shown.findByText(/^user=ed /);
    await settle();
    expect(saved).toEqual([]);
    expect(refusals).toEqual(["CANCELLED"]);
    view.unmount();
  });

  it("refuses a call paused offline once the browser is back after a switch", async () => {
    const { view, calls } = await driven();
    act(() => {
      onlineManager.setOnline(false);
    });
    try {
      act(() => {
        send(calls, "ada-offline");
      });
      await settle(30);
      act(() => {
        view.connection.setAuth({ principal: { userId: "ed" } });
      });
      await helloFor(view, "ed");
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
  });

  it("refuses the retry of a call in flight at a switch, and asks the app's retry nothing of it", async () => {
    held = deferred();
    const asked: string[] = [];
    const { view, calls } = await driven({
      retry: (failures, error) => {
        asked.push(error.code);
        return failures < 3;
      },
      retryDelay: 5,
    });
    act(() => {
      send(calls, "hold-ada");
    });
    await settle(30);
    act(() => {
      view.connection.setAuth({ principal: { userId: "ed" } });
    });
    await helloFor(view, "ed");
    await settle(60);
    // The server finishes Ada's first attempt, as Ada.
    held.resolve();
    await settle();
    expect(saved).toEqual([{ by: "ada", text: "hold-ada" }]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
    // The dropped socket's INTERNAL is the app's to retry; the refusal ends the call.
    expect(asked).toEqual(["INTERNAL"]);
  });

  it("refuses a call queued behind another of its scope at a switch", async () => {
    held = deferred();
    const { view, calls } = await driven({ scope: { id: "notes" } });
    act(() => {
      send(calls, "hold-first");
      send(calls, "ada-second");
    });
    await settle(30);
    act(() => {
      view.connection.setAuth({ principal: { userId: "ed" } });
    });
    await helloFor(view, "ed");
    await settle(60);
    held.resolve();
    await settle();
    expect(saved).toEqual([{ by: "ada", text: "hold-first" }]);
    expect(calls.outcomes).toEqual(["INTERNAL", "CANCELLED"]);
  });

  it("refuses a call whose async onMutate ends while new credentials await their hello", async () => {
    const gate = deferred();
    const opened: string[] = [];
    const { view, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
      optimistic: (input) => {
        opened.push(input.text);
      },
    });
    act(() => {
      send(calls, "ada-onmutate");
    });
    act(() => {
      view.connection.setAuth({ principal: { userId: "ed" } });
    });
    gate.resolve();
    await settle(30);
    await helloFor(view, "ed");
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
    expect(calls.messages).toEqual(["The credentials changed before the call was sent"]);
    expect(calls.callbacks).toEqual(["error CANCELLED", "settled CANCELLED"]);
    expect(opened).toEqual([]);
  });

  it("refuses a call whose async onMutate ends after the next user's hello, and shows its issuer no answer of theirs", async () => {
    const gate = deferred();
    const { view, seen, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
    });
    act(() => {
      send(calls, "ada-onmutate");
    });
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "ed" } });
      await tick();
    });
    await helloFor(view, "ed");
    gate.resolve();
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
    expect(calls.messages).toEqual(["The user changed before the call was sent"]);
    // Ada back: her call's outcome is hers, and no answer of Ed's.
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "ada" } });
      await tick();
    });
    await within(view.container).findByText("ada error data=- error=CANCELLED vars=ada-onmutate");
    expect(seen.filter(([, text]) => text.includes("data=ed#"))).toEqual([]);
  });

  it("refuses a call made while new credentials awaited their hello, once others replace them", async () => {
    const { view, seen, calls } = await driven();
    act(() => {
      view.connection.setAuth({ principal: { userId: "ed" } });
    });
    act(() => {
      send(calls, "made-for-ed");
      view.connection.setAuth({ principal: { userId: "bo" } });
    });
    await helloFor(view, "bo");
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
    // Bo's hello came under other credentials than the call's: it is not Bo's to see.
    const toBo = seen.filter(([user]) => user === "bo").map(([, text]) => text);
    expect(toBo).not.toHaveLength(0);
    expect(
      toBo.filter((text) => text !== IDLE),
      JSON.stringify(toBo),
    ).toEqual([]);
  });

  it("neither shows nor sends a call made while new credentials awaited their hello as the user of others that replaced them", async () => {
    const gate = deferred();
    const { view, seen, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
    });
    act(() => {
      view.connection.setAuth({ principal: { userId: "ed" } });
    });
    // Made with no hello, under Ed's credentials; still in its onMutate when Bo's replace them.
    act(() => {
      send(calls, "made-for-ed");
    });
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "bo" } });
      await tick();
    });
    await helloFor(view, "bo");
    await settle(30);
    const toBo = seen.filter(([user]) => user === "bo").map(([, text]) => text);
    expect(toBo).not.toHaveLength(0);
    expect(
      toBo.filter((text) => text !== IDLE),
      JSON.stringify(toBo),
    ).toEqual([]);
    gate.resolve();
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
  });

  it("refuses a call whose async onMutate ends after a reconnect that speaks for another user", async () => {
    const gate = deferred();
    const principal = { userId: "ada" };
    const { view, calls } = await driven(
      {
        onMutate: async () => {
          await gate.promise;
        },
      },
      principal,
    );
    act(() => {
      send(calls, "ada-cookie");
    });
    // The same credentials name Ed at the next connect, as a cookie would after another sign-in.
    await view.disconnect();
    principal.userId = "ed";
    await view.reconnect();
    await helloFor(view, "ed");
    gate.resolve();
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
  });

  it("refuses a call paused offline across a session the server ended, when the next connect speaks for another user", async () => {
    const principal = { userId: "ada" };
    const { app, view, calls } = await driven(undefined, principal);
    act(() => {
      onlineManager.setOnline(false);
    });
    try {
      act(() => {
        send(calls, "ada-paused");
      });
      await settle(30);
      app.server.access.disconnectUser("ada");
      await waitFor(() => {
        expect(view.connection.getState().hello).toBeNull();
      });
      // The app opens it again, and the credentials now name Ed.
      principal.userId = "ed";
      act(() => {
        view.connection.open();
      });
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
    await helloFor(view, "ed");
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
  });

  it.each([
    { next: "ed", saves: [], ends: ["CANCELLED"] },
    {
      next: "ada",
      saves: [{ by: "ada", text: "typed-after-ada-ended" }],
      ends: ["resolved by ada"],
    },
  ])(
    "sends a call made after the server ended the session only as its user: a cookie signs $next in",
    async ({ next, saves, ends }) => {
      const gate = deferred();
      const principal = { userId: "ada" };
      const { app, view, calls } = await driven(
        {
          onMutate: async () => {
            await gate.promise;
          },
        },
        principal,
      );
      app.server.access.disconnectUser("ada");
      await waitFor(() => {
        expect(view.connection.getState().hello).toBeNull();
      });
      // Made with no session, and still in its onMutate when the app opens the connection again.
      act(() => {
        send(calls, "typed-after-ada-ended");
      });
      principal.userId = next;
      act(() => {
        view.connection.open();
      });
      await helloFor(view, next);
      gate.resolve();
      await settle();
      expect(saved).toEqual(saves);
      expect(calls.outcomes).toEqual(ends);
    },
  );

  it("refuses a call whose onMutate ends after the server ended the session, before any hello", async () => {
    const gate = deferred();
    const { app, view, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
    });
    act(() => {
      send(calls, "ada-before-end");
    });
    app.server.access.disconnectUser("ada");
    await waitFor(() => {
      expect(view.connection.getState().hello).toBeNull();
    });
    gate.resolve();
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
    expect(calls.messages).toEqual(["The session ended before the call was sent"]);
  });

  it("sends a call across new credentials for the same user, once their hello names them", async () => {
    const gate = deferred();
    const { view, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
    });
    act(() => {
      send(calls, "ada-refresh");
    });
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "ada" }, refreshed: true });
      await tick();
    });
    await helloFor(view, "ada");
    gate.resolve();
    await within(view.container).findByText("ada success data=ada#1 error=- vars=ada-refresh");
    expect(saved).toEqual([{ by: "ada", text: "ada-refresh" }]);
    expect(calls.outcomes).toEqual(["resolved by ada"]);
  });

  it("refuses an attempt that starts while the same user's new credentials await their hello", async () => {
    const gate = deferred();
    const { view, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
    });
    act(() => {
      send(calls, "ada-during-refresh");
      view.connection.setAuth({ principal: { userId: "ada" }, refreshed: true });
    });
    // The refreshed token has no hello yet: nothing says whom it names, so the attempt is refused.
    gate.resolve();
    await settle(30);
    await helloFor(view, "ada");
    await settle();
    expect(saved).toEqual([]);
    expect(calls.outcomes).toEqual(["CANCELLED"]);
    expect(calls.messages).toEqual(["The credentials changed before the call was sent"]);
  });

  it("sends both calls of one input object made across a same-user refresh", async () => {
    const gate = deferred();
    const { view, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
    });
    const input = { text: "same-input" };
    act(() => {
      sendInput(calls, input);
    });
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "ada" }, refreshed: true });
      await tick();
    });
    await helloFor(view, "ada");
    act(() => {
      sendInput(calls, input);
    });
    gate.resolve();
    await settle();
    expect(saved).toEqual([
      { by: "ada", text: "same-input" },
      { by: "ada", text: "same-input" },
    ]);
    expect(calls.outcomes).toEqual(["resolved by ada", "resolved by ada"]);
  });

  it("refuses a call paused offline across a switch while the next user's own call from the hook is sent", async () => {
    const { view, calls } = await driven();
    act(() => {
      onlineManager.setOnline(false);
    });
    try {
      act(() => {
        send(calls, "ada-paused");
      });
      await settle(30);
      act(() => {
        view.connection.setAuth({ principal: { userId: "ed" } });
      });
      await helloFor(view, "ed");
      act(() => {
        send(calls, "ed-own");
      });
      await settle(30);
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
    await settle();
    // Each attempt checks its own call's ticket, not the hook's latest call's.
    expect(saved).toEqual([{ by: "ed", text: "ed-own" }]);
    expect(calls.outcomes).toEqual(["CANCELLED", "resolved by ed"]);
  });

  it("never sends one user's call as the next when both users' calls share an input object", async () => {
    const { view, calls } = await driven();
    const input = { text: "shared-input" };
    act(() => {
      onlineManager.setOnline(false);
    });
    try {
      act(() => {
        sendInput(calls, input);
      });
      await settle(30);
      act(() => {
        view.connection.setAuth({ principal: { userId: "ed" } });
      });
      await helloFor(view, "ed");
      act(() => {
        sendInput(calls, input);
      });
      await settle(30);
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
    await settle();
    // Nothing tells the two attempts apart: Ada's is refused, and Ed's may be with it.
    expect(calls.outcomes[0]).toBe("CANCELLED");
    expect(saved.length).toBeLessThanOrEqual(1);
  });

  it("sends the next user's call made with the input object of the last user's settled call", async () => {
    const { view, calls } = await driven();
    const input = { text: "reused-input" };
    act(() => {
      sendInput(calls, input);
    });
    await within(view.container).findByText("ada success data=ada#1 error=- vars=reused-input");
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "ed" } });
      await tick();
    });
    await helloFor(view, "ed");
    act(() => {
      sendInput(calls, input);
    });
    await within(view.container).findByText("ed success data=ed#2 error=- vars=reused-input");
    expect(saved).toEqual([
      { by: "ada", text: "reused-input" },
      { by: "ed", text: "reused-input" },
    ]);
  });

  it("lets go of a paused call the cache dropped, so the next user's call with its input is sent", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { view, calls } = await driven(undefined, { userId: "ada" }, queryClient);
    const input = { text: "dropped-input" };
    act(() => {
      onlineManager.setOnline(false);
    });
    try {
      act(() => {
        sendInput(calls, input);
      });
      await settle(30);
      // Signing out: the app clears its cache, and TanStack drops the paused call unsettled.
      act(() => {
        queryClient.clear();
        view.connection.setAuth({ principal: { userId: "ed" } });
      });
      await helloFor(view, "ed");
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
    act(() => {
      sendInput(calls, input);
    });
    await settle();
    expect(saved).toEqual([{ by: "ed", text: "dropped-input" }]);
    expect(calls.outcomes).toEqual(["resolved by ed"]);
  });

  it("still sends a call the cache dropped while its onMutate ran", async () => {
    const gate = deferred();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { calls } = await driven(
      {
        onMutate: async () => {
          await gate.promise;
        },
      },
      { userId: "ada" },
      queryClient,
    );
    act(() => {
      send(calls, "ada-cleared");
    });
    act(() => {
      queryClient.clear();
    });
    gate.resolve();
    await settle();
    // TanStack runs a dropped call it is still running: it is Ada's, and goes as hers.
    expect(saved).toEqual([{ by: "ada", text: "ada-cleared" }]);
    expect(calls.outcomes).toEqual(["resolved by ada"]);
  });

  it.each([
    [
      "its QueryClient's default",
      () =>
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: 1, retryDelay: 1 } },
        }),
    ],
    [
      "setMutationDefaults for its key",
      () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setMutationDefaults(methodKeyPrefix("noteService", "save"), {
          retry: 1,
          retryDelay: 1,
        });
        return queryClient;
      },
    ],
  ])("retries a call's other errors by %s", async (_by, make) => {
    const { view, calls } = await driven(undefined, { userId: "ada" }, make());
    act(() => {
      send(calls, "flaky");
    });
    await within(view.container).findByText("ada success data=ada#1 error=- vars=flaky");
    expect(calls.outcomes).toEqual(["resolved by ada"]);
  });

  it("refuses a call made after the server ended the session once new credentials for the same user come, saying so", async () => {
    const gate = deferred();
    const { app, view, calls } = await driven({
      onMutate: async () => {
        await gate.promise;
      },
    });
    app.server.access.disconnectUser("ada");
    await waitFor(() => {
      expect(view.connection.getState().hello).toBeNull();
    });
    act(() => {
      send(calls, "made-after-end");
      view.connection.setAuth({ principal: { userId: "ada" }, refreshed: true });
      send(calls, "made-after-setauth");
    });
    await helloFor(view, "ada");
    gate.resolve();
    await settle();
    // Made under the ended session's credentials, the first is not sent under new ones, even Ada's.
    expect(saved).toEqual([{ by: "ada", text: "made-after-setauth" }]);
    expect(calls.outcomes).toEqual(["CANCELLED", "resolved by ada"]);
    expect(calls.messages).toEqual(["The credentials changed before the call was sent"]);
  });

  it("still sends a call queued in its scope that the cache dropped while its onMutate ran", async () => {
    held = deferred();
    const gate = deferred();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { calls } = await driven(
      {
        scope: { id: "notes" },
        onMutate: async (input) => {
          if (input.text === "queued") {
            await gate.promise;
          }
        },
      },
      { userId: "ada" },
      queryClient,
    );
    act(() => {
      send(calls, "hold-first");
      send(calls, "queued");
    });
    await settle(30);
    // TanStack marks a queued call paused before its onMutate ends; it still runs it once dropped.
    act(() => {
      queryClient.clear();
    });
    gate.resolve();
    await settle(60);
    held.resolve();
    await settle();
    expect(saved.map(({ by, text }) => `${by}:${text}`).sort()).toEqual([
      "ada:hold-first",
      "ada:queued",
    ]);
    expect(calls.outcomes).toEqual(["resolved by ada", "resolved by ada"]);
  });

  it("still sends a call made offline that the cache dropped while its onMutate ran, once back", async () => {
    const gate = deferred();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { calls } = await driven(
      {
        onMutate: async () => {
          await gate.promise;
        },
      },
      { userId: "ada" },
      queryClient,
    );
    act(() => {
      onlineManager.setOnline(false);
    });
    try {
      act(() => {
        send(calls, "offline-cleared");
      });
      await settle(30);
      act(() => {
        queryClient.clear();
      });
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
    gate.resolve();
    await settle();
    expect(saved).toEqual([{ by: "ada", text: "offline-cleared" }]);
    expect(calls.outcomes).toEqual(["resolved by ada"]);
  });

  it("still sends a call the cache dropped during a retry's delay, after a pause it came back from", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { calls } = await driven({ retry: 1, retryDelay: 200 }, { userId: "ada" }, queryClient);
    act(() => {
      onlineManager.setOnline(false);
    });
    try {
      act(() => {
        send(calls, "flaky");
      });
      await settle(30);
    } finally {
      act(() => {
        onlineManager.setOnline(true);
      });
    }
    // Back online, its first attempt fails, and TanStack waits before the second.
    await waitFor(() => {
      expect(queryClient.getMutationCache().getAll()[0]?.state.failureCount).toBe(1);
    });
    act(() => {
      queryClient.clear();
    });
    await settle(400);
    expect(saved).toEqual([{ by: "ada", text: "flaky" }]);
    expect(calls.outcomes).toEqual(["resolved by ada"]);
  });
});

/** What a test drives a kept-item hook with, and the refused items it last rendered. */
interface KeptCalls {
  save: ReturnType<typeof qd.notes.save.useMutation> | undefined;
  refused: readonly RefusedItem<unknown>[];
}

/** A hook whose calls add a kept item to scope `s` of `all`, and that scope's refused items. */
function KeptNotes({
  calls,
  queryClient,
}: {
  readonly calls: KeptCalls;
  readonly queryClient: QueryClient;
}) {
  const { userId } = useQuickdraw();
  const save = qd.notes.save.useMutation({
    // The notes service has no collection: the item goes to a scope only this test reads.
    optimistic: (input, cache) => {
      (cache as OptimisticCache).addItem("all", "s", { text: input.text }, { onRefused: "keep" });
    },
  });
  const overlays = useOverlayView(queryClient, "noteService");
  const refused = useRefusedItems(queryClient, overlays, "all", "s");
  calls.save = save;
  calls.refused = refused;
  const items = refused.map(
    ({ item, error }) => `${String(Reflect.get(Object(item), "text"))}:${error.code}`,
  );
  return <p>{`${userId ?? "-"} refused=[${items.join(",")}]`}</p>;
}

/** A test app whose handshakes wait for `opened` when `holds` says so, as a slow session store would. */
async function slowHandshakes(
  opened: Promise<void>,
  holds: (auth: Record<string, unknown>) => boolean,
) {
  const app = await createTestApp({
    services: [noteService],
    auth: {
      authenticate: async ({ auth }) => {
        if (holds(auth)) {
          await opened;
        }
        const { principal } = auth as { readonly principal?: Principal };
        return principal ?? null;
      },
    },
  });
  apps.push(app as unknown as TestApp);
  return app;
}

describe("a kept item whose call failed before its user's hello", () => {
  it("retries as its user once the first hello comes, when the first connect outlasted the call", async () => {
    const opened = deferred();
    const app = await slowHandshakes(opened.promise, () => true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const calls: KeptCalls = { save: undefined, refused: [] };
    const view = render(
      <QuickdrawProvider
        client={qd}
        url={app.url}
        auth={{ principal: { userId: "ada" } }}
        transports={["websocket"]}
        queryClient={queryClient}
        timeoutMs={300}
      >
        <KeptNotes calls={calls} queryClient={queryClient} />
      </QuickdrawProvider>,
    );
    const shown = within(view.container);
    await shown.findByText("- refused=[]");
    // Sent while the handshake waits: it times out unsent, in the send buffer.
    act(() => {
      calls.save?.mutate({ text: "first-note" });
    });
    await shown.findByText("- refused=[first-note:INTERNAL]");
    opened.resolve();
    await shown.findByText("ada refused=[first-note:INTERNAL]");
    await act(async () => {
      await calls.refused[0]?.retry();
    });
    await shown.findByText("ada refused=[]");
    expect(saved).toEqual([{ by: "ada", text: "first-note" }]);
    view.unmount();
  });

  it("retries as its user once their hello comes, when a refreshed token's reconnect outlasted the call", async () => {
    const opened = deferred();
    const app = await slowHandshakes(opened.promise, (auth) => auth.refreshed === true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const calls: KeptCalls = { save: undefined, refused: [] };
    let refresh = (): void => undefined;
    function App() {
      const [auth, setAuth] = useState<Record<string, unknown>>({ principal: { userId: "ada" } });
      refresh = () => {
        setAuth({ principal: { userId: "ada" }, refreshed: true });
      };
      return (
        <QuickdrawProvider
          client={qd}
          url={app.url}
          auth={auth}
          transports={["websocket"]}
          queryClient={queryClient}
          timeoutMs={300}
        >
          <KeptNotes calls={calls} queryClient={queryClient} />
        </QuickdrawProvider>
      );
    }
    const view = render(<App />);
    const shown = within(view.container);
    await shown.findByText("ada refused=[]");
    act(() => {
      refresh();
    });
    await shown.findByText("- refused=[]");
    // Sent while the refreshed token's handshake waits: it times out unsent.
    act(() => {
      calls.save?.mutate({ text: "during-refresh" });
    });
    await settle(500);
    opened.resolve();
    await shown.findByText("ada refused=[during-refresh:INTERNAL]");
    await act(async () => {
      await calls.refused[0]?.retry();
    });
    await shown.findByText("ada refused=[]");
    expect(saved).toEqual([{ by: "ada", text: "during-refresh" }]);
    view.unmount();
  });
});
