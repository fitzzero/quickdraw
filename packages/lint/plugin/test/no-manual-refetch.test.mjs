import { COMPONENT, run } from "./tester.mjs";

run("no-manual-refetch", {
  valid: [
    {
      name: "a mutation followed by other work, and invalidation through qd.invalidate",
      filename: COMPONENT,
      code: `
        export function Rename({ id }) {
          const task = qd.task.get.useQuery({ id });
          const rename = qd.task.rename.useMutation();
          const onSubmit = async (title) => {
            await rename.mutateAsync({ id, title });
            close();
            qd.invalidate(qd.task.stats, { projectId: task.data.projectId });
          };
          return <Form onSubmit={onSubmit} onReload={() => task.refetch()} />;
        }
      `,
    },
    {
      name: "data that is not quickdraw's (TanStack Query used directly)",
      filename: COMPONENT,
      code: `
        import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
        export function Billing() {
          const balance = useQuery({ queryKey: ["balance"], queryFn: loadBalance });
          const pay = useMutation({ mutationFn: charge, onSuccess: () => balance.refetch() });
          const rename = qd.task.rename.useMutation();
          const queryClient = useQueryClient();
          const onPay = async () => {
            await rename.mutateAsync(input);
            await balance.refetch();
            await pay.mutateAsync(10);
            queryClient.invalidateQueries({ queryKey: ["balance"] });
          };
          return <Pay onPay={onPay} />;
        }
      `,
    },
    {
      name: "a refetch that does not follow a mutation",
      filename: COMPONENT,
      code: `
        export function Board({ projectId }) {
          const { data, refetch } = qd.task.list.useQuery({ filter: { projectId } });
          return <List items={data?.items} onPullToRefresh={() => refetch()} />;
        }
      `,
    },
  ],
  invalid: [
    {
      name: "refetching right after an awaited mutation",
      filename: COMPONENT,
      code: `
        export function Rename({ id }) {
          const task = qd.task.get.useQuery({ id });
          const rename = qd.task.rename.useMutation();
          const onSubmit = async (title) => {
            await rename.mutateAsync({ id, title });
            await task.refetch();
          };
          return <Form onSubmit={onSubmit} />;
        }
      `,
      errors: [
        {
          message:
            "Refetching right after a mutation reads twice and can race the mutation's own update: its tracked writes already update entity and collection subscribers, and queries that `watch` the changed scope are invalidated through the coordinator. Remove the `refetch()`; if this query must follow these writes, give it a `watch` in its contract.",
        },
      ],
    },
    {
      name: "a destructured refetch, in the next statement and in callbacks",
      filename: COMPONENT,
      code: `
        export function Assign({ id }) {
          const { data, refetch } = qd.task.get.useQuery({ id });
          const assign = qd.task.assign.useMutation({ onSuccess: () => refetch() });
          const onAssign = async (assigneeId) => {
            const saved = await assign.mutateAsync({ id, assigneeId });
            refetch();
            return saved;
          };
          const onClear = () => assign.mutate({ id, assigneeId: null }, { onSettled: () => { void refetch(); } });
          return <Picker value={data?.assigneeId} onChange={onAssign} onClear={onClear} />;
        }
      `,
      errors: [
        { messageId: "refetchAfterMutation" },
        { messageId: "refetchAfterMutation" },
        { messageId: "refetchAfterMutation" },
      ],
    },
    {
      name: "invalidating a quickdraw key by hand",
      filename: COMPONENT,
      code: `
        import { entityKey } from "@fitzzero/quickdraw-core/client";
        export function useReset(queryClient, id) {
          return () => {
            queryClient.invalidateQueries({ queryKey: ["qd", "taskService"] });
            queryClient.refetchQueries({ queryKey: qd.task.get.key({ id }) });
            queryClient.resetQueries({ queryKey: entityKey("taskService", id) });
          };
        }
      `,
      errors: [
        {
          message:
            "`invalidateQueries` on a quickdraw key bypasses the invalidation coordinator, which keeps one read in flight per key. Use `qd.invalidate(member, input?)` or `qd.invalidate(key)` instead.",
        },
        { messageId: "invalidateKey", data: { method: "refetchQueries" } },
        { messageId: "invalidateKey", data: { method: "resetQueries" } },
      ],
    },
  ],
});
