/**
 * Registering the organization's agents from the Agents panel: the parts that are plain logic, kept apart from React.
 *
 * Nothing here authorizes anything. The server decides (feltkit/orgagents.ts: `register` and `setStatus` need the
 * `agents.manage` permission, which only the admin role holds); the browser only decides what to show.
 */

/** Whether a session's permissions include `needed`, directly or through a wildcard such as `agents.*`. */
export function holds(permissions: readonly string[] | undefined | null, needed: string): boolean {
  if (!permissions) return false;
  return permissions.some((p) => p === needed || p === "*" || (p.endsWith(".*") && needed.startsWith(p.slice(0, -1))));
}

/** Show the registration form and the admin list only to someone who can use them; the server refuses everyone else regardless. */
export const canManageAgents = (permissions: readonly string[] | undefined | null): boolean => holds(permissions, "agents.manage");

export type RegistrationForm = { principalId: string; name: string; purpose: string; operatedBy: string; connector: "" | "eve"; connectorGrant: string };

export const emptyRegistration: RegistrationForm = { principalId: "", name: "", purpose: "", operatedBy: "", connector: "eve", connectorGrant: "" };

/**
 * The arguments of `orgagents:register`. Empty optional fields are left out. The grant is passed through exactly as typed
 * (it is a secret, not text to tidy) and only when something was typed: leaving it blank on an agent that is already
 * registered keeps the grant already recorded.
 */
export function registrationArgs(form: RegistrationForm) {
  const trim = (v: string) => v.trim();
  return {
    principalId: trim(form.principalId),
    name: trim(form.name),
    ...(trim(form.purpose) ? { purpose: trim(form.purpose) } : {}),
    ...(trim(form.operatedBy) ? { operatedBy: trim(form.operatedBy) } : {}),
    ...(form.connector ? { connector: form.connector } : {}),
    ...(form.connectorGrant.trim() ? { connectorGrant: form.connectorGrant.trim() } : {}),
  };
}

/** Why the form cannot be sent yet, or null. A new Eve connection needs its grant; an existing agent keeps the one it has. */
export function registrationProblem(form: RegistrationForm, alreadyRegistered: boolean): string | null {
  if (!form.principalId.trim()) return "Give the agent's principal id.";
  if (!form.name.trim()) return "Give the agent a name.";
  if (form.connector === "eve" && !form.connectorGrant.trim() && !alreadyRegistered) return "Paste the connect grant the Eve app issued to Meetings, or Eve cannot be started in meetings.";
  return null;
}

/** Who a person without the permission can ask: the people who registered this organization's agents. */
export function whoRegistered(agents: ReadonlyArray<{ registeredByName?: string }>): string[] {
  return [...new Set(agents.map((a) => a.registeredByName).filter((n): n is string => Boolean(n)))];
}
