// ============================================================================
// Health Service Types (an RPC service: no rows to subscribe to)
// ============================================================================

export interface HealthServiceMethods {
  ping: {
    payload: Record<string, never>;
    response: { ok: true; at: string };
  };
  stats: {
    payload: Record<string, never>;
    response: { projects: number; tasks: number };
  };
}
