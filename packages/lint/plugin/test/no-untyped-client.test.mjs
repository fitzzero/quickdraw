import { COMPONENT, run } from "./tester.mjs";

run("no-untyped-client", {
  valid: [
    {
      name: "the typed client's hooks (README, section 11)",
      filename: COMPONENT,
      code: `
        export function Task({ id, projectId }) {
          const { data } = qd.task.get.useQuery({ id });
          const rename = qd.task.rename.useMutation();
          const { items } = qd.task.byProject.useCollection(projectId, { view: "mine" });
          return <TaskCard task={data} items={items} onRename={(title) => rename.mutate({ id, title })} />;
        }
      `,
    },
    {
      name: "TanStack Query for data that is not quickdraw's",
      filename: COMPONENT,
      code: `
        import { useMutation, useQuery } from "@tanstack/react-query";
        export function Weather({ city }) {
          const { data } = useQuery({
            queryKey: ["weather", city],
            queryFn: async () => (await fetch(\`https://api.weather.example/\${city}\`)).json(),
          });
          const pay = useMutation({
            mutationFn: (amount) => stripe.charge(amount),
            onSuccess: () => qd.invalidate(qd.billing.balance),
          });
          return <Forecast data={data} onPay={pay.mutate} />;
        }
      `,
    },
    {
      // The review's bad2 U2 and U3: hooks the typed client has no equivalent of.
      name: "suspense, parallel and infinite queries keyed and fetched through a member",
      filename: COMPONENT,
      code: `
        import { infiniteQueryOptions, queryOptions, useInfiniteQuery, useQueries, useSuspenseQuery } from "@tanstack/react-query";
        export function Tasks({ id, ids, filter }) {
          const u2 = useSuspenseQuery({ queryKey: qd.task.get.key({ id }), queryFn: () => qd.task.get.call({ id }) });
          const u3 = useQueries({ queries: ids.map((x) => ({ queryKey: qd.task.get.key({ id: x }), queryFn: () => qd.task.get.call({ id: x }) })) });
          const pages = useInfiniteQuery({
            queryKey: [...qd.task.list.key({ filter }), "pages"],
            queryFn: ({ pageParam, signal }) => qd.task.list.call({ filter, cursor: pageParam }, { signal }),
            initialPageParam: undefined,
            getNextPageParam: (page) => page.nextCursor ?? undefined,
          });
          const options = queryOptions({ queryKey: qd.task.get.key({ id }), queryFn: () => qd.task.get.call({ id }) });
          const more = infiniteQueryOptions({ queryKey: qd.task.list.key({ filter }), queryFn: () => qd.task.list.call({ filter }) });
          return <List items={[u2, u3, pages, options, more]} />;
        }
      `,
    },
    {
      name: "a useQuery that is not TanStack's",
      filename: COMPONENT,
      code: `
        import { useQuery } from "@apollo/client";
        export const Viewer = () => useQuery(VIEWER, { variables: { id: qd.task.get.key({ id }) } });
      `,
    },
  ],
  invalid: [
    {
      name: "a TanStack query calling the typed client",
      filename: COMPONENT,
      code: `
        import { useQuery } from "@tanstack/react-query";
        export function Task({ id }) {
          const { data } = useQuery({ queryKey: ["task", id], queryFn: () => qd.task.get.call({ id }) });
          return <TaskCard task={data} />;
        }
      `,
      errors: [
        {
          message:
            "`useQuery` from @tanstack/react-query fetches quickdraw data by hand, outside the typed client: it gets no live updates, not-modified answers, invalidation coordinator or optimistic overlays. Use the method's own hook: `qd.<service>.<method>.useQuery(input)` or `.useMutation()`; for a hook it has no equivalent of, key it with `qd.<service>.<method>.key(input)` and fetch with `.call(input)`.",
        },
      ],
    },
    {
      name: "a mutation, a quickdraw key, and an aliased import",
      filename: COMPONENT,
      code: `
        import { useMutation as useTanstackMutation, useQuery } from "@tanstack/react-query";
        export function Rename({ id }) {
          const rename = useTanstackMutation({ mutationFn: (input) => qd.task.rename.call(input) });
          const { data } = useQuery({ queryKey: ["qd", "taskService", "m", "get", { id }], queryFn: load });
          return <Form onSubmit={rename.mutate} task={data} />;
        }
      `,
      errors: [
        { messageId: "untypedClient", data: { hook: "useMutation" } },
        { messageId: "untypedClient", data: { hook: "useQuery" } },
      ],
    },
    {
      name: "the call helpers, the HTTP transport and a namespace import",
      filename: "apps/web/src/hooks/useTask.ts",
      code: `
        import * as rq from "@tanstack/react-query";
        import { callData } from "@fitzzero/quickdraw-core/client";
        export const useTask = (connection, id) =>
          rq.useQuery({ queryKey: ["task", id], queryFn: () => callData(connection, { s: "taskService", m: "get", i: { id } }) });
        export const useTaskOverHttp = (id) =>
          rq.useSuspenseQuery({
            queryKey: ["task-http", id],
            queryFn: async () => (await fetch("/qd/taskService/get", { method: "POST", body: JSON.stringify({ id }) })).json(),
          });
      `,
      errors: [
        { messageId: "untypedClient", data: { hook: "useQuery" } },
        { messageId: "untypedClient", data: { hook: "useSuspenseQuery" } },
      ],
    },
    {
      name: "a keyed hook still reports a key or a fetch that is not a member's",
      filename: COMPONENT,
      code: `
        import { useQueries, useSuspenseQuery, useQuery } from "@tanstack/react-query";
        import { callData } from "@fitzzero/quickdraw-core/client";
        export function Tasks({ id, ids }) {
          const own = useSuspenseQuery({ queryKey: ["task", id], queryFn: () => qd.task.get.call({ id }) });
          const raw = useSuspenseQuery({ queryKey: qd.task.get.key({ id }), queryFn: () => callData(connection, { s: "taskService", m: "get", i: { id } }) });
          const mixed = useQueries({ queries: ids.map((x) => ({ queryKey: ["t", x], queryFn: () => qd.task.get.call({ id: x }) })) });
          const typed = useQuery({ queryKey: qd.task.get.key({ id }), queryFn: () => qd.task.get.call({ id }) });
          return <List items={[own, raw, mixed, typed]} />;
        }
      `,
      errors: [
        { messageId: "untypedClient", data: { hook: "useSuspenseQuery" } },
        { messageId: "untypedClient", data: { hook: "useSuspenseQuery" } },
        { messageId: "untypedClient", data: { hook: "useQueries" } },
        { messageId: "untypedClient", data: { hook: "useQuery" } },
      ],
    },
  ],
});
