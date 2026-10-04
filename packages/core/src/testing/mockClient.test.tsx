// `createMockClient` (`./testing/client`): component tests with no server,
// no socket and no provider. Each member's stub answers its calls, the live
// hooks show the rows and scopes the test sets, and a component re-renders
// when the test changes them.

import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
