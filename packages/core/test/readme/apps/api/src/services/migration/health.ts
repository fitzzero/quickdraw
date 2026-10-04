import { healthContract } from "../../../../../packages/shared/src/migration/contracts";
import { qd } from "../../quickdraw";

// #region rpc
// No model and no policy: a service without rows, as BaseRpcService was
export const healthService = qd.defineService(healthContract, {
  methods: {
    ping: { access: "public", handler: () => ({ at: new Date().toISOString() }) },
  },
});
// #endregion
