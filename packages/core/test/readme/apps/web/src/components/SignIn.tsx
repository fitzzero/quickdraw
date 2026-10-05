"use client";

import { authProviders, signInUrl, signOut, useQuickdraw } from "@fitzzero/quickdraw-core/client";
import { useQuery } from "@tanstack/react-query";

const API_URL = "http://localhost:4000";

// #region browser
export function SignIn() {
  // GET /auth/providers: only the sign-ins this API serves (no Google button without its keys)
  const { data: providers = [] } = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => authProviders({ apiUrl: API_URL }),
  });
  return (
    <nav>
      {providers
        .filter((provider) => provider.kind !== "guest")
        .map((provider) => (
          // the kit's GET /auth/{id}/start: back to this page's origin with the session cookie
          <a key={provider.id} href={signInUrl(provider.id, { apiUrl: API_URL })}>
            {`Sign in with ${provider.name}`}
          </a>
        ))}
    </nav>
  );
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
