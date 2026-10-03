// The README's component test examples. Only typechecked (see task.test.ts).

import { createTestApp } from "@fitzzero/quickdraw-core/testing";
import { createMockClient, renderWithQuickdraw } from "@fitzzero/quickdraw-core/testing/client";
import { contracts } from "@project/shared";
import { it } from "vitest";
import type { AppPrincipal } from "../../../api/src/quickdraw";
import { db } from "../../../api/src/db";
import { projectService } from "../../../api/src/services/project";
import { taskService } from "../../../api/src/services/task";
import { qd } from "../lib/quickdraw";
import { TaskBoard } from "./TaskBoard";

const ada: AppPrincipal = { userId: "ada", kind: "user" };
const projectId = "p1";

// #region render
it("shows a task another user adds", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  const view = await renderWithQuickdraw(<TaskBoard projectId={projectId} />, {
    app,
    as: ada,
    client: qd,
  });
  await app.as(ada).taskService.create({ projectId, title: "Added elsewhere" });
  await view.findByText("Added elsewhere"); // the collection delta reached the component
  await app.close();
});
// #endregion

const card = {
  id: "t1",
  projectId,
  title: "Mocked",
  status: "open",
  ordinal: 1,
  assigneeId: null,
};

// #region mock
const mock = createMockClient(contracts); // the typed client's members, with stubs
mock.task.board.mockScope(projectId, [card]); // what useCollection shows for the scope
mock.task.countOnBoard.mockResolvedValue(1); // what the query answers
mock.task.useEntity.mockRow({ ...card, notes: null }); // what useEntity shows for t1
// #endregion
