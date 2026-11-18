/**
 * ICE servers for a connection: STUN, plus TURN relay credentials when a TURN provider is configured.
 * Only a person with a live connection in a call gets relay credentials, and they expire
 * (ICE_TTL_S). The provider's token never leaves FeltKit's credential custody.
 */
import { s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { ownPeer } from "./_meeting.js";
import { api } from "./_generated/api.js";

/** Relay credentials last as long as a long call; a client asks again when it rejoins. */
export const ICE_TTL_S = 4 * 60 * 60;
const STUN = [{ urls: "stun:stun.l.google.com:19302" }];

/** The caller's connection is a person's, live, and still allowed in its meeting (refuses otherwise). */
export const connection = app.query({
  access: "media.ice",
  args: { peerId: s.string({ maxLength: 64 }) },
  handler: async (ctx, { peerId }) => {
    const peer = await ownPeer(ctx, peerId);
    if (peer.kind !== "person") return { ok: false };
    return { ok: true };
  },
});

export const iceServers = app.action({
  access: "media.ice",
  args: { peerId: s.string({ maxLength: 64 }) },
  handler: async (ctx, { peerId }) => {
    const check = await ctx.runQuery(api.media.connection, { peerId });
    if (!check.ok) return { iceServers: STUN, relay: false, reason: "only people's connections carry media" };
    try {
      const out: any = await ctx.integrations.invoke("turn.iceservers", { ttl: ICE_TTL_S });
      const servers = Array.isArray(out.iceServers) ? out.iceServers : [out.iceServers];
      // The provider's servers only: its STUN as well as its TURN. A third-party STUN server would learn every
      // participant's address and add a lookup that can stall gathering where its name does not resolve.
      return { iceServers: servers, relay: true, expiresAt: Date.now() + ICE_TTL_S * 1000 };
    } catch (error) {
      // No TURN provider configured or reachable: direct connections only (calls across strict NATs fail).
      ctx.log.warn?.(`TURN unavailable: ${(error as Error).message}`);
      return { iceServers: STUN, relay: false, reason: (error as { code?: string }).code ?? "UNAVAILABLE" };
    }
  },
});
