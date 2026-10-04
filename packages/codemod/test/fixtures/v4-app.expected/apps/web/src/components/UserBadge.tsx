"use client";

import { qd } from "../lib/quickdraw";

export function UserBadge({ userId }: { userId: string | null }) {
  const { data: user } = qd.userService.useEntity(userId ?? "", { enabled: userId !== null });
  return <span>{user?.name ?? "Someone"}</span>;
}
