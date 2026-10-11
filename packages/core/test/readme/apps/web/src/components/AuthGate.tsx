"use client";

import { useQuickdraw } from "@fitzzero/quickdraw-core/client";
import type { ReactNode } from "react";
import { SignIn } from "./SignIn";

// #region gate
export function AuthGate({ children }: { readonly children: ReactNode }) {
  // isKnown: the server's hello named the user, so userId is final (null: signed out)
  const { status, isKnown, userId, reconnecting } = useQuickdraw();
  // the server ended the session (signed out elsewhere, revoked, expired) or refused it: signed out
  if (status === "disconnected" || status === "refused") {
    return <SignIn />;
  }
  if (!isKnown) {
    return <p>Connecting…</p>;
  }
  if (userId === null) {
    return <SignIn />;
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
