"use client";

import type { ReactNode } from "react";
import { QuickdrawProvider } from "@fitzzero/quickdraw-core/client";

export function Providers({ children, token }: { children: ReactNode; token: string | null }) {
  // quickdraw-migrate: review [client] 4.x QuickdrawProvider props (serverUrl, authToken, autoConnect): 5.0 takes client={qd} (lib/quickdraw), url, auth and socketOptions
  return (
    <QuickdrawProvider serverUrl="http://localhost:4000" authToken={token ?? undefined} autoConnect>
      {children}
    </QuickdrawProvider>
  );
}
