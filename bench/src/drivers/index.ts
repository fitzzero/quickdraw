import type { Driver, Target } from "./types";
import { v4Driver } from "./v4";
import { v5Driver } from "./v5";

export { TARGETS, type Driver, type Target } from "./types";

/** The driver for each target: the client that speaks its app's wire protocol. */
export const DRIVERS: Record<Target, Driver> = { v4: v4Driver, v5: v5Driver };
