/**
 * A fixture, not part of the meetings application: the smallest app that uses the FeltKit capabilities a
 * meetings "organizations" step would build on (workspaces, e-mail invitations, workspace-scoped data,
 * notifications), so tests/platform-capabilities.test.ts can verify them in an executable flow before
 * the application depends on them.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "meetings-workspaces-fixture",
  roles: {
    base: ["notifications.*"],
    owner: ["rooms.*", "tenant.*", "notifications.*"],
    member: ["rooms.*", "notifications.*"],
  },
  auth: {
    accounts: { roles: ["base"] },
    tenant: { roles: ["owner", "member"], create: "anyone", invitations: { ttlMs: 60_000 } },
  },
  services: { notifications: { types: ["room.invited"] } },
});

/** Rooms belong to a workspace: FeltKit scopes every read and write to the caller's current one. */
export const rooms = app.collection("rooms", { title: s.string({ minLength: 1 }), createdBy: s.string() }, { tenant: true });
