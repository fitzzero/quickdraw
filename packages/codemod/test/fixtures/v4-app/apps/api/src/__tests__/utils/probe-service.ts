import { BaseRpcService } from "@fitzzero/quickdraw-core/server";

interface ProbeServiceMethods {
  probe: {
    payload: Record<string, never>;
    response: { ok: true };
  };
}

// A service only the tests register: the codemod writes no contract for it.
export class ProbeService extends BaseRpcService<ProbeServiceMethods> {
  constructor() {
    super({ serviceName: "probeService" });

    this.defineMethod("probe", "Public", async () => ({ ok: true as const }));
  }
}
