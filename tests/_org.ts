import { api } from "../feltkit/_generated/api";

/** The organization's agents the tests use, registered by an administrator (ada), as a deployment would. */
export async function registerAgents(t: any, ids: string[] = ["claude", "apikey-bot", "eve", "other-agent"]) {
  for (const principalId of ids) await t.as("ada").mutation(api.orgagents.register, { principalId, name: principalId });
}
