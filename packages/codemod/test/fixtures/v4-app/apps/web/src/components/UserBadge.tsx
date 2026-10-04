"use client";

import { useSubscription } from "../hooks";

export function UserBadge({ userId }: { userId: string | null }) {
  const { data: user } = useSubscription("userService", userId ?? "", { enabled: userId !== null });
  return <span>{user?.name ?? "Someone"}</span>;
}
