"use client";

import { useQuickdraw } from "@fitzzero/quickdraw-core/client";
import type { ReactNode } from "react";

// #region gate
export function AuthGate({ children }: { readonly children: ReactNode }) {
  // isKnown: the server's hello named the user, so userId is final (null: signed out)
  const { isKnown, userId, reconnecting } = useQuickdraw();
  if (!isKnown) {
    return <p>Connecting…</p>;
  }
  if (userId === null) {
    return <p>Signed out.</p>;
  }
  // a reconnect keeps the user and the page: say so, unmount nothing
  return (
    <>
      {reconnecting ? <p role="status">Reconnecting…</p> : null}
      {children}
    </>
  );
}
// #endregion
