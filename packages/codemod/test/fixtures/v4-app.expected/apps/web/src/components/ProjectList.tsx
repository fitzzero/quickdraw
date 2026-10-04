"use client";

import { useState } from "react";
import { qd } from "../lib/quickdraw";
import { useMyProjects } from "../hooks";

export function ProjectList() {
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const { items } = useMyProjects();
  const { data: page } = qd.projectService.listMyProjects.useQuery({ page: 1 }, { staleTime: 30_000 });

  // No refetch on success: the `mine` collection delivers the new project
  // quickdraw-migrate: review [client] onError receives a QuickdrawError now (4.x passed the message string): read error.message or error.code
  const createProject = qd.projectService.createProject.useMutation({
    onSuccess: () => {
      setName("");
    },
    onError: (error) => {
      setFailure(error);
    },
  });

  return (
    <section>
      <h2>{`${items.length} projects (${page?.length ?? 0} on this page)`}</h2>
      <ul>
        {items.map((project) => (
          <li key={project.id}>{project.name}</li>
        ))}
      </ul>
      <input value={name} onChange={(event) => setName(event.target.value)} />
      <button type="button" onClick={() => createProject.mutate({ name })}>
        Create
      </button>
      {failure === null ? null : <p>{failure}</p>}
    </section>
  );
}
