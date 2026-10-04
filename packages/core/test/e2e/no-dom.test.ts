// End to end without a DOM (RFC 0003 section 11.1): the client entry
// imports and runs with no `document` and no `window`, as it must in React
// Native or a Node script. This file runs in the node project: a
// connection, a call and a live row through the React-free layers, against
// the same app the rest of the suite renders against.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/client/index";
import { as, e2eApp } from "../fixtures/app";

const e2e = e2eApp();
const connections: client.QuickdrawConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.close();
  }
});

describe("the client without a DOM", () => {
  it("imports with no document or window", () => {
    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");
    expect(typeof client.createQuickdrawConnection).toBe("function");
    expect(typeof client.createQuickdrawClient).toBe("function");
    expect(typeof client.QuickdrawProvider).toBe("function");
  });

  it("connects, calls and follows a live row with createQuickdrawConnection", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const connection = client.createQuickdrawConnection({
      url: app.url,
      auth: { principal: as(board.cy) },
      transports: ["websocket"],
    });
    connections.push(connection);
    connection.open();
    await vi.waitFor(() => expect(connection.getState().status).toBe("connected"));
    expect(connection.getState().hello?.userId).toBe(board.cy);

    const row = await client.callData(connection, {
      service: "taskService",
      method: "get",
      input: { id: board.t1 },
    });
    expect(row).toMatchObject({ id: board.t1, title: "T1" });

    const queryClient = new QueryClient();
    const live = client.liveDataOf(connection, queryClient);
    const release = live.entities.subscribe("taskService", [board.t1]);
    const title = (): unknown =>
      queryClient.getQueryData<{ readonly data?: { readonly title?: string } }>(
        client.entityKey("taskService", board.t1),
      )?.data?.title;
    await vi.waitFor(() => expect(title()).toBe("T1"));
    await app.as(as(board.bo)).taskService.rename({ id: board.t1, title: "From Node" });
    await vi.waitFor(() => expect(title()).toBe("From Node"));
    release();
  });
});
