import type { TaskService } from "../index.js";
import { registerArchive } from "./archive.js";
import { registerCreateTask } from "./create-task.js";
import { defineTaskQueries } from "./queries.js";
import { defineEditMethods } from "./update-task.js";

// services/task/methods/index.ts: one function wires every method module,
// and the service calls only it. It registers no method itself.
export function defineTaskMethods(service: TaskService): void {
  // a module whose parameter is the class, and one whose parameter is a port
  registerCreateTask(service);
  registerArchive(service);
  // two more such functions: one beside its modules, one that also logs
  defineTaskQueries(service);
  defineEditMethods(service);
}
