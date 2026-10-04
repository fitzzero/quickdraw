import type { HealthServiceMethods } from "@project/shared";

// #region rpc
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";

export class HealthService extends BaseRpcService<HealthServiceMethods> {
  constructor() {
    super({ serviceName: "healthService" });
    this.defineMethod("ping", "Public", async () => ({ at: new Date().toISOString() }));
  }
}
// #endregion
