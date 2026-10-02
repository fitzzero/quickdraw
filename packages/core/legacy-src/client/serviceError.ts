/**
 * Error thrown by client hooks when a service call acks with
 * `{ success: false }`. Carries the server's optional numeric code
 * (e.g. 401, 403, 429) so callers can branch without string matching.
 */
export class ServiceCallError extends Error {
  public readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "ServiceCallError";
    this.code = code;
  }
}
