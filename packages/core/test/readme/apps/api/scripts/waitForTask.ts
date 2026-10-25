// The README's example of live data in a script: it waits until a project's
// board holds an open task and prints its id, as a CLI waits for work.

// #region script
import {
  createQuickdrawConnection,
  holdCollection,
  liveStoreOf,
} from "@fitzzero/quickdraw-core/client/core";
import { taskContract } from "@project/shared";

const projectId = process.argv[2];
if (projectId === undefined) {
  throw new Error("usage: wait-for-task <projectId>");
}
const connection = createQuickdrawConnection({
  url: "http://localhost:4000",
  auth: process.env.API_TOKEN,
});
// made before open(), so it follows the connection from its first hello
const live = liveStoreOf(connection);
connection.open();
const taskId = await new Promise<string>((resolve, reject) => {
  const board = holdCollection(
    live,
    { contract: taskContract, collection: "board", scope: projectId, load: "all" },
    // called once holdCollection has returned, then as the board changes
    (scope) => {
      const open = scope.items.find((card) => card.status === "open");
      if (scope.error !== null) {
        board.release();
        reject(scope.error);
      } else if (open !== undefined) {
        board.release();
        resolve(open.id);
      }
    },
  );
});
process.stdout.write(`${taskId}\n`);
connection.close();
// #endregion
