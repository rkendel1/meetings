import { s } from "@feltdb/feltkit";
import { app, rooms } from "./app.js";

export const create = app.mutation({
  access: "rooms.write",
  args: { title: s.string({ minLength: 1 }), notify: s.optional(s.string()) },
  handler: async (ctx, { title, notify }) => {
    const me = ctx.auth.requirePrincipal();
    const id = await ctx.db.insert(rooms, { title, createdBy: me.id });
    if (notify) ctx.afterCommit.notifications.send({ recipient: notify, type: "room.invited", title: `${me.id} invited you to ${title}`, data: { id } });
    return id;
  },
});

export const list = app.query({
  access: "rooms.read",
  handler: async (ctx) => (await ctx.db.find(rooms, {})).map((r: any) => r.title).sort(),
});

export const inbox = app.query({
  access: "notifications.read",
  handler: async (ctx) => (await ctx.services.notifications.list()).map((n: any) => n.title),
});
