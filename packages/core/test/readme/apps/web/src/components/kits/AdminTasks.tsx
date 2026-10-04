"use client";

import { createQuickdrawClient, useAdminServices } from "@fitzzero/quickdraw-core/client";
import { task } from "../../../../../packages/shared/src/kits/admin";

const qd = createQuickdrawClient({ task });

// #region component
export function AdminTasks() {
  // [{ key: "task", serviceName, displayName }]
  const { services } = useAdminServices(qd);
  const { data } = qd.task.admin.adminList.useQuery({ page: 1, sort: { field: "title" } });
  const update = qd.task.admin.adminUpdate.useMutation();
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
