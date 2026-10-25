// `createMockClient` (`./testing/client`): component tests with no server,
// no socket and no provider. Each member's stub answers its calls, the live
// hooks show the rows and scopes the test sets, and a component re-renders
// when the test changes them.

import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { usePresence, useQuickdraw } from "../client/index";
import { QuickdrawError, defineContract, mutation, query, search } from "../index";
import { createMockClient } from "./client";

const card = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
});

const task = defineContract("taskService", {
  entity: card,
  projections: { card },
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
  },
  collections: {
    board: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      index: ["ordinal", "assigneeId"],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
  },
});

type Card = z.infer<typeof card>;

function cardOf(id: string, title: string, assigneeId: string | null = null): Card {
  return { id, projectId: "p1", title, ordinal: 0, assigneeId };
}

describe("createMockClient", () => {
  it("keeps a query loading until its answer is set, and refetches when it changes", async () => {
    const qd = createMockClient({ task });
    function Title() {
      const { data, error } = qd.task.get.useQuery({ id: "t1" });
      if (error !== null) {
        return <p>{`refused ${error.code}`}</p>;
      }
      return <p>{data === undefined ? "loading" : `title ${data.title}`}</p>;
    }
    render(<Title />);
    expect(screen.getByText("loading")).toBeTruthy();
    act(() => {
      qd.task.get.mockResolvedValue(cardOf("t1", "First"));
    });
    await screen.findByText("title First");
    act(() => {
      qd.task.get.mockImplementation(({ id }) => cardOf(id, `Made for ${id}`));
    });
    await screen.findByText("title Made for t1");
    act(() => {
      qd.task.get.mockRejectedValue(new QuickdrawError("FORBIDDEN", "Not yours"));
    });
    await screen.findByText("refused FORBIDDEN");
    expect(qd.task.get.calls).toEqual([{ id: "t1" }, { id: "t1" }, { id: "t1" }, { id: "t1" }]);
  });

  it.each(["mockResolvedValue", "mockImplementation", "mockRejectedValue"] as const)(
    "asks its stub once on a mount right after %s, and once more for a new answer",
    async (setter) => {
      const qd = createMockClient({ task });
      function Title() {
        const { data, error } = qd.task.get.useQuery({ id: "t1" });
        if (error !== null) {
          return <p>{`refused ${error.code}`}</p>;
        }
        return <p>{data === undefined ? "loading" : `title ${data.title}`}</p>;
      }
      /** Lets every refetch an answer set off land, so a late one is counted. */
      const settled = () =>
        act(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
        });
      if (setter === "mockResolvedValue") {
        qd.task.get.mockResolvedValue(cardOf("t1", "First"));
      } else if (setter === "mockImplementation") {
        qd.task.get.mockImplementation(({ id }) => cardOf(id, "First"));
      } else {
        qd.task.get.mockRejectedValue(new QuickdrawError("FORBIDDEN", "Not yours"));
      }
      render(<Title />);
      await screen.findByText(setter === "mockRejectedValue" ? "refused FORBIDDEN" : "title First");
      await settled();
      expect(qd.task.get.calls).toEqual([{ id: "t1" }]);
      // A new answer refetches the result of the old one, once.
      act(() => {
        qd.task.get.mockResolvedValue(cardOf("t1", "Second"));
      });
      await screen.findByText("title Second");
      await settled();
      expect(qd.task.get.calls).toEqual([{ id: "t1" }, { id: "t1" }]);
    },
  );

  it("answers call and prefetch from the stub, and keys results as the real client does", async () => {
    const qd = createMockClient({ task });
    qd.task.get.mockResolvedValue(cardOf("t1", "First"));
    expect(await qd.task.get.call({ id: "t1" })).toEqual(cardOf("t1", "First"));
    expect(qd.task.get.key({ id: "t1" })).toEqual(["qd", "taskService", "m", "get", { id: "t1" }]);
    await qd.task.get.prefetch(qd.$queryClient, { id: "t2" });
    expect(qd.$queryClient.getQueryData(qd.task.get.key({ id: "t2" }))).toEqual(
      cardOf("t1", "First"),
    );
    qd.task.get.mockReset();
    expect(qd.task.get.calls).toEqual([]);
  });

  it("runs a mutation through its stub, and records its input", async () => {
    const qd = createMockClient({ task });
    qd.task.rename.mockImplementation(({ id, title }) => cardOf(id, title));
    function Rename() {
      const rename = qd.task.rename.useMutation();
      return (
        <button type="button" onClick={() => rename.mutate({ id: "t1", title: "Renamed" })}>
          {rename.data === undefined ? `rename ${rename.status}` : `renamed ${rename.data.title}`}
        </button>
      );
    }
    render(<Rename />);
    fireEvent.click(screen.getByText("rename idle"));
    await screen.findByText("renamed Renamed");
    expect(qd.task.rename.calls).toEqual([{ id: "t1", title: "Renamed" }]);
    qd.task.rename.mockRejectedValue(new QuickdrawError("CONFLICT", "Taken"));
    await expect(qd.task.rename.call({ id: "t1", title: "x" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("shows the rows the test sets through useEntity and useEntities", async () => {
    const qd = createMockClient({ task });
    function Rows() {
      const one = qd.task.useEntity("t1");
      const many = qd.task.useEntities(["t1", "t2", "t3"]);
      return (
        <>
          <p>{`one ${one.data?.title ?? `loading ${String(one.isLoading)}`}`}</p>
          <p>{`many ${many.data.map((row) => row?.title ?? "-").join(",")}`}</p>
          <p>{`removed ${String(qd.task.useEntity("t2").isRemoved)}`}</p>
          <p>{`error ${many.error?.code ?? "none"} loading ${String(many.isLoading)}`}</p>
        </>
      );
    }
    render(<Rows />);
    expect(screen.getByText("one loading true")).toBeTruthy();
    act(() => {
      qd.task.useEntity.mockRow(cardOf("t1", "First"));
      qd.task.useEntities.mockRemoved("t2");
    });
    await screen.findByText("one First");
    expect(screen.getByText("many First,-,-")).toBeTruthy();
    expect(screen.getByText("removed true")).toBeTruthy();
    expect(screen.getByText("error none loading true")).toBeTruthy();
    act(() => {
      qd.task.useEntity.mockError("t3", new QuickdrawError("FORBIDDEN", "Not yours"));
    });
    await screen.findByText("error FORBIDDEN loading false");
    expect(() => {
      qd.task.useEntity.mockRow({ title: "no id" } as unknown as Card);
    }).toThrow("mockRow: the row needs a string id");
  });

  it("shows nothing of a mocked row or scope while the hook is disabled, as the real hooks do", () => {
    const qd = createMockClient({ task });
    qd.task.useEntity.mockRow(cardOf("t1", "First"));
    qd.task.board.mockScope("p1", [cardOf("t1", "First")]);
    function Off() {
      const one = qd.task.useEntity("t1", { enabled: false });
      const many = qd.task.useEntities(["t1"], { enabled: false });
      const scope = qd.task.board.useCollection("p1", { enabled: false });
      return (
        <p>
          {`one ${String(one.data)} ${String(one.isLoading)} many ${String(many.data[0])} ` +
            `scope ${scope.items.length} ${String(scope.totalCount)} ${String(scope.isLoading)}`}
        </p>
      );
    }
    render(<Off />);
    expect(screen.getByText("one undefined false many undefined scope 0 null false")).toBeTruthy();
  });

  it("shows a scope's items in order, and filters a view of its index for the mock's user", async () => {
    const qd = createMockClient({ task }, { userId: "ada" });
    function Board({ mine }: { readonly mine: boolean }) {
      const scope = qd.task.board.useCollection("p1", mine ? { view: "mine" } : {});
      if (scope.error !== null) {
        return <p>{`refused ${scope.error.code}`}</p>;
      }
      const rows = scope.index?.map((row) => `${row.id}:${String(row.assigneeId)}`).join(",");
      return (
        <p>
          {scope.isLoading
            ? `loading ${mine ? "mine" : "all"}`
            : `${mine ? "mine" : "all"} ${scope.items.map((item) => item.title).join(",")} of ${String(scope.totalCount)} [${rows ?? ""}]`}
        </p>
      );
    }
    render(
      <>
        <Board mine={false} />
        <Board mine />
      </>,
    );
    expect(screen.getByText("loading all")).toBeTruthy();
    act(() => {
      qd.task.board.mockScope(
        "p1",
        [cardOf("t2", "Second", "ada"), cardOf("t1", "First"), cardOf("t3", "Third", "bo")],
        { totalCount: 40 },
      );
    });
    await screen.findByText("all Second,First,Third of 40 [t2:ada,t1:null,t3:bo]");
    expect(screen.getByText("mine Second of 40 [t2:ada]")).toBeTruthy();
    act(() => {
      qd.task.board.mockError("p1", new QuickdrawError("FORBIDDEN", "Not yours"));
    });
    expect(await screen.findAllByText("refused FORBIDDEN")).toHaveLength(2);
  });

  it("writes a query's cached result with setData, shown at once", async () => {
    const qd = createMockClient({ task });
    qd.task.get.mockResolvedValue(cardOf("t1", "First"));
    function Title() {
      const { data } = qd.task.get.useQuery({ id: "t1" });
      return <p>{data === undefined ? "loading" : data.title}</p>;
    }
    render(<Title />);
    await screen.findByText("First");
    const asked = qd.task.get.calls.length;
    act(() => {
      qd.task.get.setData({ id: "t1" }, cardOf("t1", "From an event"));
    });
    await screen.findByText("From an event");
    expect(qd.task.get.calls).toHaveLength(asked);
  });

  it("invalidates through the mock's cache, and forgets everything on $reset", async () => {
    const qd = createMockClient({ task });
    let reads = 0;
    qd.task.get.mockImplementation(({ id }) => {
      reads += 1;
      return cardOf(id, `Read ${reads}`);
    });
    function Title() {
      const { data } = qd.task.get.useQuery({ id: "t1" });
      return <p>{data === undefined ? "loading" : data.title}</p>;
    }
    const view = render(<Title />);
    await screen.findByText("Read 1");
    act(() => {
      qd.invalidate(qd.task.get, { id: "t1" });
    });
    await screen.findByText("Read 2");
    view.unmount();
    qd.task.useEntity.mockRow(cardOf("t1", "First"));
    qd.$reset();
    expect(qd.task.get.calls).toEqual([]);
    expect(qd.$queryClient.getQueryCache().getAll()).toEqual([]);
    render(<Title />);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(screen.getByText("loading")).toBeTruthy();
  });
});

describe("the mock's session", () => {
  /** What the real useQuickdraw() and usePresence say, as one line. */
  function Status() {
    const { status, isConnected, isKnown, reconnecting, userId, serviceAccess, hello } =
      useQuickdraw();
    const room = usePresence("lobby");
    const grants = JSON.stringify(serviceAccess);
    const connected = isConnected ? "connected" : status;
    return (
      <p>{`${connected} known:${String(isKnown)} again:${String(reconnecting)} user:${String(userId)} grants:${grants} hello:${String(hello?.userId)} lobby:${room.join(",")}`}</p>
    );
  }

  it("is what the real useQuickdraw() and usePresence read under $Provider", () => {
    const qd = createMockClient({ task }, { userId: "ada" });
    render(<Status />, { wrapper: qd.$Provider });
    expect(
      screen.getByText("connected known:true again:false user:ada grants:{} hello:ada lobby:"),
    ).toBeTruthy();
    act(() => {
      qd.$session({ serviceAccess: { taskService: "Admin" } });
      qd.$presence("lobby", ["ada", "bo", "ada"]);
    });
    expect(
      screen.getByText(
        'connected known:true again:false user:ada grants:{"taskService":"Admin"} hello:ada lobby:ada,bo',
      ),
    ).toBeTruthy();
    // Each $session replaces the last over the starting session: grants left out are gone.
    act(() => {
      qd.$session({ userId: null });
    });
    expect(
      screen.getByText(
        "connected known:true again:false user:null grants:{} hello:null lobby:ada,bo",
      ),
    ).toBeTruthy();
    act(() => {
      qd.$session({ isKnown: false });
    });
    // Before the hello: no user, no grants, and a socket in no room.
    expect(
      screen.getByText(
        "connected known:false again:false user:null grants:null hello:undefined lobby:",
      ),
    ).toBeTruthy();
    act(() => {
      qd.$session({ isConnected: false });
    });
    expect(
      screen.getByText(
        "connecting known:true again:true user:ada grants:{} hello:ada lobby:ada,bo",
      ),
    ).toBeTruthy();
    act(() => {
      qd.$session({ isConnected: false, isKnown: false });
    });
    expect(
      screen.getByText(
        "connecting known:false again:false user:null grants:null hello:undefined lobby:",
      ),
    ).toBeTruthy();
  });

  it("starts from its session option, and selects view members for the session's user", async () => {
    const qd = createMockClient({ task }, { session: { userId: "bo" } });
    function Mine() {
      const { userId } = useQuickdraw();
      const { items } = qd.task.board.useCollection("p1", { view: "mine" });
      return <p>{`${String(userId)}: ${items.map((item) => item.title).join(",")}`}</p>;
    }
    qd.task.board.mockScope("p1", [cardOf("t1", "Ada's", "ada"), cardOf("t2", "Bo's", "bo")]);
    render(<Mine />, { wrapper: qd.$Provider });
    await screen.findByText("bo: Bo's");
    act(() => {
      qd.$session({ userId: "ada" });
    });
    expect(screen.getByText("ada: Ada's")).toBeTruthy();
    act(() => {
      qd.$reset();
    });
    expect(screen.getByText("bo:")).toBeTruthy();
  });

  it("is scoped to a $Provider's subtree by its session prop, side by side (finding F6.2)", async () => {
    const qd = createMockClient({ task }, { userId: "ada" });
    qd.task.board.mockScope("p1", [cardOf("t1", "Ada's", "ada"), cardOf("t2", "Bo's", "bo")]);
    function Who({ name }: { readonly name: string }) {
      const { userId, isKnown, isConnected, serviceAccess } = useQuickdraw();
      const room = usePresence("lobby");
      const { items } = qd.task.board.useCollection("p1", { view: "mine" });
      const mine = items.map((item) => item.title).join(",");
      const grants = JSON.stringify(serviceAccess);
      const state = `known:${String(isKnown)} connected:${String(isConnected)}`;
      return (
        <p>{`${name}: ${String(userId)} ${state} grants:${grants} lobby:${room.join(",")} mine:${mine}`}</p>
      );
    }
    act(() => {
      qd.$presence("lobby", ["ada"]);
    });
    // Two stories on one docs page, each with its own session; a third with the mock's own.
    render(
      <>
        <qd.$Provider session={{ userId: "bo", serviceAccess: { taskService: "Admin" } }}>
          <Who name="bo's story" />
        </qd.$Provider>
        <qd.$Provider session={{ userId: null, isKnown: false }}>
          <Who name="signed out" />
        </qd.$Provider>
        <qd.$Provider>
          <Who name="default" />
        </qd.$Provider>
      </>,
    );
    await screen.findByText(
      `bo's story: bo known:true connected:true grants:{"taskService":"Admin"} lobby:ada mine:Bo's`,
    );
    expect(
      screen.getByText("signed out: null known:false connected:true grants:null lobby: mine:"),
    ).toBeTruthy();
    expect(
      screen.getByText("default: ada known:true connected:true grants:{} lobby:ada mine:Ada's"),
    ).toBeTruthy();
    // What a prop leaves out follows the mock's own session.
    act(() => {
      qd.$session({ isConnected: false });
    });
    expect(screen.getByText(/^bo's story: bo known:true connected:false /)).toBeTruthy();
    expect(screen.getByText(/^default: ada known:true connected:false /)).toBeTruthy();
  });

  it("refuses a $Provider session it cannot show", () => {
    const qd = createMockClient({ task });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        render(
          <qd.$Provider session={{ userId: "" }}>
            <p>never</p>
          </qd.$Provider>,
        ),
      ).toThrow("$Provider: userId must be a non-empty string, or null for an anonymous user");
    } finally {
      quiet.mockRestore();
    }
  });

  it("gives its cache to TanStack's useQueryClient, and needs no provider for its members", () => {
    const qd = createMockClient({ task });
    let seen: unknown;
    function Probe() {
      seen = useQueryClient();
      return null;
    }
    render(<Probe />, { wrapper: qd.$Provider });
    expect(seen).toBe(qd.$queryClient);
    function Row() {
      return <p>{qd.task.useEntity("t1").isLoading ? "row loading" : "row"}</p>;
    }
    render(<Row />);
    expect(screen.getByText("row loading")).toBeTruthy();
  });

  it("refuses a session or a room it cannot show", () => {
    const qd = createMockClient({ task });
    expect(() => qd.$session({ userId: "" })).toThrow(
      "$session: userId must be a non-empty string, or null for an anonymous user",
    );
    expect(() => qd.$session({ isKnown: "yes" as unknown as boolean })).toThrow(
      "$session: isKnown must be true or false",
    );
    expect(() => createMockClient({ task }, { session: null as unknown as object })).toThrow(
      "createMockClient: the session is { userId?, serviceAccess?, isConnected?, isKnown? }",
    );
    expect(() => qd.$presence("", [])).toThrow("$presence: room must be a room's name");
  });
});

/** A component that reads `get` and runs `rename` of a mock, and says what it shows, into `seen`. */
function boardOf(qd: ReturnType<typeof createMockClient<{ task: typeof task }>>, seen: string[]) {
  return function Board() {
    const { userId } = useQuickdraw();
    const got = qd.task.get.useQuery({ id: "t1" });
    const rename = qd.task.rename.useMutation();
    const shown = `get=${got.data?.title ?? got.status} rename=${rename.status} data=${rename.data?.title ?? "-"} vars=${rename.variables?.title ?? "-"} error=${rename.error?.code ?? "-"}`;
    const line = `${String(userId)} ${shown}`;
    seen.push(line);
    return (
      <button type="button" onClick={() => rename.mutate({ id: "t1", title: "ada-input" })}>
        {line}
      </button>
    );
  };
}

describe("the mock across a switch of users", () => {
  it.each([
    ["succeeded", "success data=ada-input vars=ada-input error=-"],
    ["was refused", "error data=- vars=ada-input error=CONFLICT"],
  ])(
    "shows the next user none of the last user's results, nor a call of theirs that %s",
    async (how, after) => {
      const qd = createMockClient({ task }, { userId: "ada" });
      const seen: string[] = [];
      const Board = boardOf(qd, seen);
      qd.task.get.mockResolvedValue(cardOf("t1", "ada-note"));
      if (how === "succeeded") {
        qd.task.rename.mockImplementation(({ id, title }) => cardOf(id, title));
      } else {
        qd.task.rename.mockRejectedValue(new QuickdrawError("CONFLICT", "Taken"));
      }
      render(<Board />, { wrapper: qd.$Provider });
      await screen.findByText(/^ada get=ada-note rename=idle /);
      fireEvent.click(screen.getByRole("button"));
      await screen.findByText(`ada get=ada-note rename=${after}`);
      // Ed's read waits for an answer of its own.
      act(() => {
        qd.task.get.mockReset();
      });
      const switched = seen.length;
      act(() => {
        qd.$session({ userId: "ed" });
      });
      await screen.findByText("ed get=pending rename=idle data=- vars=- error=-");
      const ed = seen.slice(switched).filter((line) => line.startsWith("ed "));
      expect(ed.filter((line) => line.includes("ada"))).toEqual([]);
      expect(qd.$queryClient.getMutationCache().getAll()).toEqual([]);
    },
  );

  it("keeps the same user's own state, shows none of it while it awaits a hello, and reads it again after", async () => {
    const qd = createMockClient({ task }, { userId: "ada" });
    const seen: string[] = [];
    const Board = boardOf(qd, seen);
    qd.task.get.mockResolvedValue(cardOf("t1", "ada-note"));
    qd.task.rename.mockImplementation(({ id, title }) => cardOf(id, title));
    render(<Board />, { wrapper: qd.$Provider });
    await screen.findByText(/^ada get=ada-note rename=idle /);
    fireEvent.click(screen.getByRole("button"));
    const shown = "ada get=ada-note rename=success data=ada-input vars=ada-input error=-";
    await screen.findByText(shown);
    act(() => {
      qd.$session({ serviceAccess: { taskService: "Admin" } });
    });
    expect(screen.getByText(shown)).toBeTruthy();
    // New credentials awaiting their hello: what is cached may be the last user's.
    act(() => {
      qd.$session({ isKnown: false });
    });
    expect(screen.getByText("null get=pending rename=idle data=- vars=- error=-")).toBeTruthy();
    // The same user's hello: their state again, and the query read again as them.
    act(() => {
      qd.$session({});
    });
    await screen.findByText(shown);
    expect(qd.task.get.calls).toEqual([{ id: "t1" }, { id: "t1" }]);
  });

  it("reads once a hello names the session's user, as the real client does", async () => {
    const qd = createMockClient({ task }, { session: { userId: "ada", isKnown: false } });
    const seen: string[] = [];
    const Board = boardOf(qd, seen);
    qd.task.get.mockResolvedValue(cardOf("t1", "ada-note"));
    render(<Board />, { wrapper: qd.$Provider });
    expect(screen.getByText("null get=pending rename=idle data=- vars=- error=-")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(qd.task.get.calls).toEqual([]);
    act(() => {
      qd.$session({ isKnown: true });
    });
    await screen.findByText(/^ada get=ada-note /);
    expect(qd.task.get.calls).toEqual([{ id: "t1" }]);
  });

  it("refuses a call whose user changed before it ran, never calling its stub, as the real client does", async () => {
    const qd = createMockClient({ task }, { userId: "ada" });
    const gate: { open?: () => void } = {};
    const outcomes: string[] = [];
    function Rename() {
      const rename = qd.task.rename.useMutation({
        onMutate: async () => {
          await new Promise<void>((resolve) => {
            gate.open = resolve;
          });
        },
      });
      return (
        <button
          type="button"
          onClick={() => {
            rename.mutateAsync({ id: "t1", title: "ada-input" }).then(
              () => outcomes.push("answered"),
              (error: unknown) =>
                outcomes.push(error instanceof QuickdrawError ? error.code : String(error)),
            );
          }}
        >
          rename
        </button>
      );
    }
    qd.task.rename.mockImplementation(({ id, title }) => cardOf(id, title));
    render(<Rename />, { wrapper: qd.$Provider });
    fireEvent.click(screen.getByText("rename"));
    // Its onMutate runs as Ada: the attempt starts once it ends, after the switch.
    await waitFor(() => {
      expect(gate.open).toBeDefined();
    });
    act(() => {
      qd.$session({ userId: "ed" });
    });
    await act(async () => {
      gate.open?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(outcomes).toEqual(["CANCELLED"]);
    expect(qd.task.rename.calls).toEqual([]);
  });
});

describe("after each test", () => {
  // Made while the file is collected, as an app's test module makes its mock.
  const qd = createMockClient({ task });
  const kept = createMockClient({ task }, { resetAfterEach: false });

  function Row() {
    const row = qd.task.useEntity("t1");
    return <p>{row.isLoading ? "row loading" : `row ${row.data?.title ?? "-"}`}</p>;
  }

  function Who() {
    const { userId } = useQuickdraw();
    return <p>{`who ${String(userId)} lobby ${usePresence("lobby").join(",")}`}</p>;
  }

  it("sets answers, calls, rows, scopes, rooms, the session and results, and leaves Row mounted", async () => {
    qd.$session({ userId: "ada" });
    qd.$presence("lobby", ["ada"]);
    qd.task.get.mockResolvedValue(cardOf("t1", "First"));
    qd.task.useEntity.mockRow(cardOf("t1", "First"));
    qd.task.board.mockScope("p1", [cardOf("t1", "First")]);
    await qd.task.get.prefetch(qd.$queryClient, { id: "t1" });
    kept.task.get.mockResolvedValue(cardOf("t1", "Kept"));
    await kept.task.get.call({ id: "t1" });
    render(<Row />);
    await screen.findByText("row First");
    expect(qd.task.get.calls).toHaveLength(1);
  });

  it("finds them forgotten: the mock reset itself after the last test", async () => {
    expect(qd.task.get.calls).toEqual([]);
    expect(qd.$queryClient.getQueryCache().getAll()).toEqual([]);
    render(<Row />);
    expect(screen.getByText("row loading")).toBeTruthy();
    render(<Who />, { wrapper: qd.$Provider });
    expect(screen.getByText("who null lobby")).toBeTruthy();
    let settled = false;
    void qd.task.get.call({ id: "t1" }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    // The stub's answer is gone too: a call waits for one.
    expect(settled).toBe(false);
    // A mock made with resetAfterEach: false keeps what it was given.
    expect(kept.task.get.calls).toEqual([{ id: "t1" }]);
    await expect(kept.task.get.call({ id: "t1" })).resolves.toMatchObject({ title: "Kept" });
  });

  it("keeps what a later test reads as the starting user, the first test's switch of users settled", async () => {
    function Title() {
      const got = qd.task.get.useQuery({ id: "t1" });
      return <p>{`title ${got.data?.title ?? got.status}`}</p>;
    }
    qd.task.get.mockResolvedValue(cardOf("t1", "Third"));
    render(<Title />);
    await screen.findByText("title Third");
    // A change of the mock's store: the cache follows the session, which is the starting one.
    act(() => {
      qd.task.useEntity.mockRow(cardOf("t2", "Other"));
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(screen.getByText("title Third")).toBeTruthy();
    expect(qd.task.get.calls).toHaveLength(1);
  });
});

describe("a search kit method", () => {
  const notes = defineContract("noteService", {
    entity: card,
    methods: { ...search.contract({ entity: card, fields: ["title"] }) },
  });

  it("has useSearch, answered by its stub at once, sending nothing below minLength", async () => {
    const qd = createMockClient({ note: notes });
    qd.note.search.mockImplementation(({ q }) => ({
      items: [cardOf("t1", `Found ${q}`)],
      nextCursor: "more",
    }));
    function Results({ q }: { readonly q: string }) {
      const { items, hasMore } = qd.note.search.useSearch(q);
      return (
        <ul aria-label={hasMore ? "more" : "all"}>
          {items.map((item) => (
            <li key={item.id}>{item.title}</li>
          ))}
        </ul>
      );
    }
    const { rerender } = render(<Results q="a" />);
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    rerender(<Results q=" ab " />);
    await screen.findByText("Found ab");
    expect(screen.getByRole("list", { name: "more" })).toBeTruthy();
    expect(qd.note.search.calls).toEqual([{ q: "ab" }]);
  });
});
