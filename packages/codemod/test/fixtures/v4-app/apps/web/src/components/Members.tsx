"use client";

import { useRoomEvents, useServiceQuery } from "../hooks";

export function Members({ projectId }: { projectId: string }) {
  const { data: members } = useServiceQuery(
    "projectService",
    "getMembers",
    { projectId },
    { invalidateOn: ["project:members"] },
  );

  useRoomEvents(
    {
      "project:archived": (event) => {
        if (event.id === projectId) window.location.assign("/projects");
      },
    },
    { enabled: projectId !== "" },
  );

  return (
    <ul>
      {(members ?? []).map((member) => (
        <li key={member.id}>{`${member.userId} (${member.role})`}</li>
      ))}
    </ul>
  );
}
