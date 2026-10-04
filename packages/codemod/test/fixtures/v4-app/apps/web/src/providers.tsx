"use client";

import type { ReactNode } from "react";
import { QuickdrawProvider } from "@fitzzero/quickdraw-core/client";

export function Providers({ children, token }: { children: ReactNode; token: string | null }) {
  return (
    <QuickdrawProvider serverUrl="http://localhost:4000" authToken={token ?? undefined} autoConnect>
      {children}
    </QuickdrawProvider>
  );
}
