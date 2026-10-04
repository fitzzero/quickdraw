"use client";

import { QuickdrawProvider } from "@fitzzero/quickdraw-core/client";
import type { ReactNode } from "react";
import { qd } from "../lib/quickdraw";

export function Providers({ children }: { readonly children: ReactNode }) {
  // Cookie sessions need no `auth`; a bearer token is `auth={token}`.
  return (
    <QuickdrawProvider client={qd} url="http://localhost:4000">
      {children}
    </QuickdrawProvider>
  );
}
