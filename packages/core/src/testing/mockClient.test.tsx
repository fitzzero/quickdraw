// `createMockClient` (`./testing/client`): component tests with no server,
// no socket and no provider. Each member's stub answers its calls, the live
// hooks show the rows and scopes the test sets, and a component re-renders
// when the test changes them.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QuickdrawError, defineContract, mutation, query } from "../index";
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
