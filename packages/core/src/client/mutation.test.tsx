// A mounted mutation hook across a switch of users (RFC 0003 sections 6,
// 11.2 and 11.4): it shows a call's `data`, `error`, `variables` and status
// only while the connection's hello names the user the call ran as. The
// next user sees none of the last user's, while their hello is awaited or
// after it, a call in flight at the switch included; the same user sees
// theirs again once new credentials' hello names them, and through a
// reconnect. Against a real server whose `save` answers who called it,
// refuses `"refuse"`, and holds `"hold"` until the test lets it answer.

import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QuickdrawError, defineContract, mutation } from "../index";
import { initQuickdraw, type Principal } from "../server/index";
import { deferred, tick, type Deferred } from "../server/__tests__/fixtures";
import { renderWithQuickdraw } from "../testing/client";
import { createTestApp, type TestApp } from "../testing/index";
import { createQuickdrawClient } from "./createClient";
import { useQuickdraw } from "./provider";

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
/** While set, a save of `"hold"` waits for it. */
let held: Deferred<void> | undefined;

const noteService = server.defineService(notes, {
  methods: {
    save: {
      access: "authenticated",
      handler: async ({ input, ctx }) => {
        if (input.text === "refuse") {
          throw new QuickdrawError("FORBIDDEN", "Not yours to save");
        }
        if (input.text === "hold") {
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

/** What each render showed, with the user the connection acted for then. */
type Seen = [user: string | null, shown: string][];

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
  const save = qd.notes.save.useMutation(throwOnError === undefined ? {} : { throwOnError });
  const data = save.data === undefined ? "-" : `${save.data.by}#${String(save.data.n)}`;
  const shown = `${save.status} data=${data} error=${save.error?.code ?? "-"} vars=${save.variables?.text ?? "-"}`;
  seen.push([userId, shown]);
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
  return { view, seen, shown };
}

/** What the renders since `from` showed while the connection acted for anyone but Ada, nobody included. */
const notAda = (seen: Seen, from: number): string[] =>
  seen
    .slice(from)
    .filter(([user]) => user !== "ada")
    .map(([, shown]) => shown);

/** New credentials for `userId`, and their hello awaited. */
async function switchTo(view: Awaited<ReturnType<typeof signedIn>>["view"], userId: string) {
  await act(async () => {
    view.connection.setAuth({ principal: { userId } });
    await tick();
  });
  await within(view.container).findByText(new RegExp(`^${userId} `));
}

describe("a mounted mutation hook across a switch of users", () => {
  it("shows the next user none of the last user's result, data and input", async () => {
    const { view, seen, shown } = await signedIn("ada-note");
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("ada success data=ada#1 error=- vars=ada-note");
    const switched = seen.length;
    await switchTo(view, "ed");
    const toOthers = notAda(seen, switched);
    expect(toOthers).not.toHaveLength(0);
    expect(
      toOthers.filter((text) => text !== IDLE),
      JSON.stringify(toOthers),
    ).toEqual([]);
  });

  it("shows the next user none of the last user's refused call", async () => {
    const { view, seen, shown } = await signedIn("refuse");
    fireEvent.click(shown.getByText("save"));
    await shown.findByText("ada error data=- error=FORBIDDEN vars=refuse");
    const switched = seen.length;
    await switchTo(view, "ed");
    const toOthers = notAda(seen, switched);
    expect(
      toOthers.filter((text) => text !== IDLE),
      JSON.stringify(toOthers),
    ).toEqual([]);
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
    const toOthers = notAda(seen, switched);
    expect(
      toOthers.filter((text) => text !== IDLE),
      JSON.stringify(toOthers),
    ).toEqual([]);
    expect(shown.getByText(`ed ${IDLE}`)).toBeTruthy();
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
    const waiting = seen
      .slice(refreshed)
      .filter(([user]) => user === null)
      .map(([, text]) => text);
    expect(waiting).not.toHaveLength(0);
    expect(
      waiting.filter((text) => text !== IDLE),
      JSON.stringify(waiting),
    ).toEqual([]);
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

  it("throws to an error boundary only the errors of the user's own calls", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const caught: string[] = [];
      class Boundary extends Component<{ readonly children: ReactNode }, { failed: boolean }> {
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
      }
      held = deferred();
      const app = await createTestApp({ services: [noteService] });
      apps.push(app as unknown as TestApp);
      const seen: Seen = [];
      const view = await renderWithQuickdraw(
        <Boundary>
          <Saver text="hold" seen={seen} throwOnError />
        </Boundary>,
        { app, as: { userId: "ada" }, client: qd },
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
          <Saver text="refuse" seen={seen} throwOnError />
        </Boundary>,
      );
      fireEvent.click(shown.getByText("save"));
      await shown.findByText("caught");
      expect(caught).toEqual(["FORBIDDEN"]);
    } finally {
      quiet.mockRestore();
    }
  });
});
