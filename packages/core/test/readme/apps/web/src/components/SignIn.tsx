"use client";

import { signInUrl, signOut, useQuickdraw } from "@fitzzero/quickdraw-core/client";

const API_URL = "http://localhost:4000";

// #region browser
export function SignIn() {
  // the kit's GET /auth/google/start: back to this page's origin with the session cookie
  return <a href={signInUrl("google", { apiUrl: API_URL })}>Sign in with Google</a>;
}

export function SignOut() {
  const { connection } = useQuickdraw();
  const leave = async (): Promise<void> => {
    // POST /auth/logout with the cookie: the session is revoked, the cookie cleared
    await signOut({ apiUrl: API_URL });
    // the socket keeps its user until it connects again, as nobody now
    connection.close();
    connection.open();
  };
  return (
    <button type="button" onClick={() => void leave()}>
      Sign out
    </button>
  );
}
// #endregion
