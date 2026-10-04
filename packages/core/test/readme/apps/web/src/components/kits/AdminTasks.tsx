"use client";

import { createQuickdrawClient, useAdminServices } from "@fitzzero/quickdraw-core/client";
import { task } from "../../../../../packages/shared/src/kits/admin";

const qd = createQuickdrawClient({ task });

// #region component
export function AdminTasks() {
  // [{ key: "task", serviceName, displayName }]
  const { services } = useAdminServices(qd);
  const { data } = qd.task.admin.adminList.useQuery({ page: 1, sort: { field: "title" } });
  const update = qd.task.admin.adminUpdate.useMutation({
    // adminList is a query, not live data: read the page again after this screen's own write
    onSuccess: () => qd.invalidate(qd.task.admin.adminList),
  });
  return (
    <table aria-label={services[0]?.displayName}>
      <tbody>
        {data?.items.map((row) => (
          <tr key={row.id}>
            <td>{row.title}</td>
            <td>
              <button
                type="button"
                onClick={() => update.mutate({ id: row.id, data: { status: "done" } })}
              >
                Done
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
// #endregion
