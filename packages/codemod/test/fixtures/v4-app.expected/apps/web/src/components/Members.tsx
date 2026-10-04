"use client";

import { qd } from "../lib/quickdraw";
import { useRoomEvents } from "../hooks";

export function Members({ projectId }: { projectId: string }) {
  // quickdraw-migrate: review [client] invalidateOn is gone: give the query a watch in its contract entry (it is fetched again when that collection scope changes), or read a collection
  const { data: members } = qd.projectService.getMembers.useQuery(
    { projectId },
    { invalidateOn: ["project:members"] },
  );

  // quickdraw-migrate: review [client] room events: declare them in the contract's events and listen with qd.<service>.<event>.useEvent(handler)
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
