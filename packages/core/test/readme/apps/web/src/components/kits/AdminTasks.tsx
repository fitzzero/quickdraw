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
    // the kit's reads are queries, not live data: after this screen's own write,
    // read the page again and put the row the write returned in adminGet's cache
    onSuccess: (row) => {
      qd.invalidate(qd.task.admin.adminList);
      qd.task.admin.adminGet.setData({ id: row.id }, row);
    },
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
