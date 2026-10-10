// The agents' tokens, for the README's MCP bridge example: each token acts
// for a user and is bound to one project.

import type { AppPrincipal } from "../quickdraw";

/** What an agent's token stands for: the user it acts for and the one project it works on. */
interface AgentGrant {
  readonly userId: string;
  readonly projectId: string;
}

/** The agents' tokens. In production, a table that keeps a hash of each token. */
export const agentTokens = new Map<string, AgentGrant>();

/**
 * The agent a bearer token signs in, with its project as a verified claim,
 * or `null` for no token or an unknown one.
 */
export function verifyAgentToken(token: unknown): AppPrincipal | null {
  const grant = typeof token === "string" ? agentTokens.get(token) : undefined;
  return grant === undefined
    ? null
    : { userId: grant.userId, kind: "agent", claims: { projectId: grant.projectId } };
}
