// Role-based access control. Permissions are fixed strings checked on the server for every
// API route (deny by default); roles are named sets of them. Built-in roles cannot be edited.

export const PERMISSIONS = [
  { id: "runs.view", group: "Upgrades", label: "View upgrades, diffs and logs" },
  { id: "runs.start", group: "Upgrades", label: "Start upgrades and scans" },
  { id: "runs.apply", group: "Upgrades", label: "Apply patches and open pull requests" },
  { id: "runs.delete", group: "Upgrades", label: "Delete runs" },
  { id: "workspaces.view", group: "Repositories", label: "View repositories" },
  {
    id: "workspaces.manage",
    group: "Repositories",
    label: "Add, configure and remove repositories",
  },
  { id: "integrations.manage", group: "Repositories", label: "Manage GitHub and model keys" },
  { id: "members.view", group: "People", label: "View members" },
  { id: "members.manage", group: "People", label: "Invite, deactivate and reset members" },
  { id: "roles.manage", group: "People", label: "Create and edit roles" },
  { id: "access.manage", group: "People", label: "Grant access to repositories" },
  { id: "security.manage", group: "Security", label: "Manage SSO, MFA and session policy" },
  { id: "audit.view", group: "Security", label: "View and export the audit log" },
  { id: "org.manage", group: "Organisation", label: "Rename or delete the organisation" },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["id"];
const ALL = PERMISSIONS.map((p) => p.id) as Permission[];

export const BUILTIN_ROLES: {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}[] = [
  {
    key: "owner",
    name: "Owner",
    description: "Full control, including the organisation itself.",
    permissions: ALL,
  },
  {
    key: "admin",
    name: "Admin",
    description: "Manages people, access, security and integrations.",
    permissions: ALL.filter((p) => p !== "org.manage"),
  },
  {
    key: "maintainer",
    name: "Maintainer",
    description: "Runs upgrades and applies them.",
    permissions: [
      "runs.view",
      "runs.start",
      "runs.apply",
      "runs.delete",
      "workspaces.view",
      "members.view",
    ],
  },
  {
    key: "reviewer",
    name: "Reviewer",
    description: "Reviews verified upgrades and applies them.",
    permissions: ["runs.view", "runs.apply", "workspaces.view", "members.view"],
  },
  {
    key: "viewer",
    name: "Viewer",
    description: "Read-only access to upgrades.",
    permissions: ["runs.view", "workspaces.view"],
  },
  {
    key: "auditor",
    name: "Auditor",
    description: "Read-only access plus the audit log.",
    permissions: ["runs.view", "workspaces.view", "members.view", "audit.view"],
  },
];

export const isPermission = (p: string): p is Permission => (ALL as string[]).includes(p);

export function can(perms: readonly string[], p: Permission): boolean {
  return perms.includes(p);
}

/** A user may only hand out permissions they hold themselves. */
export function canGrant(granter: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((p) => granter.includes(p));
}
