// What a project may hold. The project method map names these types inline,
// as import("./limits.js").ProjectLimits, rather than importing them.

export type LimitsScope = "owner" | "member";

export interface ProjectLimits {
  maxProjects: number;
  maxMembers: number;
}
