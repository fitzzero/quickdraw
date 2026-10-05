// The session `<mock.$Provider session={...}>` gives its subtree (finding
// F6.2 of the quickdraw-chat migration): a Storybook docs page renders every
// story at once, each inside the mock's provider, and `$session(...)` is one
// session for the whole mock, so every story showed the last one set. The
// prop is laid over the mock's own session (`$session`) field by field for
// what renders inside that provider: the real `useQuickdraw()` and
// `usePresence(room)` read it through the provider's connection
// (`mockSession.tsx`), and the mock's own hooks that depend on who the user
// is (collection views, the admin grants) read it from this context.

import { createContext, useContext } from "react";
import type { MockStore } from "./mockLive";
import type { SessionState } from "./mockTypes";

/** Lays a `$Provider`'s `session` prop over the mock's own session: the same object while that one does not change. */
export type SessionScope = (session: SessionState) => SessionState;

/** The scope a `$Provider` with a `session` prop set, for one mock's store. */
export interface ScopedSession {
  readonly store: MockStore;
  readonly scope: SessionScope;
}

/** Where a `$Provider` with a `session` prop puts its scope; `undefined` elsewhere. */
export const MockSessionScope = createContext<ScopedSession | undefined>(undefined);

/** The scope that applies to `store` where this renders: one of its own providers' `session` prop. */
export function useSessionScope(store: MockStore): SessionScope | undefined {
  const scoped = useContext(MockSessionScope);
  return scoped?.store === store ? scoped.scope : undefined;
}

/** The session `store` shows under `scope`: its own, or the prop over it. */
export function sessionIn(store: MockStore, scope: SessionScope | undefined): SessionState {
  const session = store.session();
  return scope === undefined ? session : scope(session);
}
