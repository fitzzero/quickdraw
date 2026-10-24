// A mounted mutation hook across a switch of users (RFC 0003 sections 6,
// 11.2 and 11.4): it shows a call's state (`data`, `error`, `variables`,
// `context`, the failures, the status and its flags) only while the
// connection's hello names the user the call ran as. The next user sees
// none of the last user's, while their hello is awaited or after it: a call
// in flight at the switch, one paused offline, and one made after the
// server ended the session that failed before any hello included; the same
// user sees theirs again once new credentials' hello names them, and
// through a reconnect. Against a real server whose `save` answers who called
// it, refuses `"refuse"`, and holds `"hold"` until the test lets it answer.

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

const noteService = server.defineService(notes, {
  methods: {
    save: {
      access: "authenticated",
      handler: async ({ input, ctx }) => {
        if (input.text === "refuse") {
          throw new QuickdrawError("FORBIDDEN", "Not yours to save");
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

/** Ada signed in on a test app, with a saver that sends `text`. */
async function signedIn(text: string) {
  const app = await createTestApp({ services: [noteService] });
  apps.push(app as unknown as TestApp);
  const seen: Seen = [];
  const view = await renderWithQuickdraw(<Saver text={text} seen={seen} />, {
    app,
    as: { userId: "ada" },
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

  it("shows a call made before the first hello pending, then its answer", async () => {
    const app = await createTestApp({ services: [noteService] });
    apps.push(app as unknown as TestApp);
    const seen: Seen = [];
    const view = await renderWithQuickdraw(<Saver text="first-note" seen={seen} />, {
      app,
      as: { userId: "ada" },
      client: qd,
    });
    // Sent at once, before the socket connects: it waits for it, and runs as Ada.
    expect(view.connection.getState().hello).toBeNull();
    fireEvent.click(within(view.container).getByText("save"));
    await within(view.container).findByText("ada success data=ada#1 error=- vars=first-note");
    const beforeHello = seen.filter(([user]) => user === null).map(([, text]) => text);
    expect(beforeHello, JSON.stringify(beforeHello)).toContain(
      "pending data=- error=- vars=first-note",
    );
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
  readonly outcomes: string[];
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

/** Sends `text` through the hook's `mutateAsync`, keeping how the call ends. */
function send(calls: Calls, text: string): void {
  calls.save?.mutateAsync({ text }).then(
    (out) => calls.outcomes.push(`resolved by ${out.by}`),
    (error: unknown) =>
      calls.outcomes.push(error instanceof QuickdrawError ? error.code : String(error)),
  );
}

/**
 * Ada signed in on a test app, with a hook the test drives. `principal` is
 * the one the handshake sends: a test that changes it changes who the next
 * connect speaks for without `setAuth`, as a session cookie would.
 */
async function driven(options?: SaveOptions, principal = { userId: "ada" }) {
  const app = await createTestApp({ services: [noteService] });
  apps.push(app as unknown as TestApp);
  const seen: Seen = [];
  const calls: Calls = { save: undefined, outcomes: [], callbacks: [] };
  const view = await renderWithQuickdraw(
    <Driven calls={calls} seen={seen} {...(options === undefined ? {} : { options })} />,
    { app, as: principal, client: qd },
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
});
