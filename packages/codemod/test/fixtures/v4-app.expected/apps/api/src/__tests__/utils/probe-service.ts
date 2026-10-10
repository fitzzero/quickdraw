// quickdraw-migrate: review [v4-api] 4.x API BaseRpcService (removed): lint's no-v4-api names each replacement
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";

interface ProbeServiceMethods {
  probe: {
    payload: Record<string, never>;
    response: { ok: true };
  };
}

// A service only the tests register: the codemod writes no contract for it.
// quickdraw-migrate: review [service] ProbeService is a 4.x service class in test code, which the codemod reads no service from: test the 5.0 service through createTestApp (@fitzzero/quickdraw-core/testing), or port what this class adds
export class ProbeService extends BaseRpcService<ProbeServiceMethods> {
  constructor() {
    super({ serviceName: "probeService" });

    this.defineMethod("probe", "Public", async () => ({ ok: true as const }));
  }
}
