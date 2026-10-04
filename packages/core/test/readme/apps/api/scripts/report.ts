// The README's example of a client without React (a script, a worker).

// #region script
import { callData, createQuickdrawConnection } from "@fitzzero/quickdraw-core/client";

const connection = createQuickdrawConnection({
  url: "http://localhost:4000",
  // sent as auth.token
  auth: process.env.API_TOKEN,
});
connection.open();
const count = await callData<number>(connection, {
  service: "taskService",
  method: "countOnBoard",
  input: { projectId: process.argv[2] },
});
process.stdout.write(`${String(count)} tasks\n`);
connection.close();
// #endregion
