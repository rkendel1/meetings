/**
 * Branding and retention for this deployment. One record, kept by an admin; the brand is public so the sign-in and
 * join pages can wear it before anyone signs in. Whoever deploys a copy of this app makes it theirs here, with no
 * code change.
 */
import { fail, s } from "@feltdb/feltkit";
import { app } from "./app.js";

export const settings = app.collection(
  "settings",
  {
    key: s.string({ maxLength: 32 }),
    name: s.string({ minLength: 1, maxLength: 60 }),
    tagline: s.optional(s.string({ maxLength: 160 })),
    accent: s.optional(s.string({ maxLength: 7 })),
    logo: s.optional(s.string({ maxLength: 200_000 })),
    retentionDays: s.optional(s.integer({ minimum: 1, maximum: 3650 })),
    updatedAt: s.number(),
    updatedBy: s.string(),
  },
  { unique: [["key"]] },
);

export const DEFAULT_BRAND = { name: "Meetings", tagline: "Video meetings that people and agents attend together." };
const KEY = "workspace";
const Brand = s.object({ name: s.string(), tagline: s.optional(s.string()), accent: s.optional(s.string()), logo: s.optional(s.string()) });

export async function current(ctx: any): Promise<any | null> {
  const [row] = await ctx.db.find(settings, { key: KEY }, { limit: 1 });
  return row ?? null;
}

/** The name, tagline, accent colour and logo: public, so the page is branded before sign-in. */
export const brand = app.query({
  access: "public",
  returns: Brand,
  handler: async (ctx) => {
    const row = await current(ctx);
    if (!row) return DEFAULT_BRAND;
    return { name: row.name, ...(row.tagline ? { tagline: row.tagline } : {}), ...(row.accent ? { accent: row.accent } : {}), ...(row.logo ? { logo: row.logo } : {}) };
  },
});

export const get = app.query({
  access: "settings.read",
  returns: s.object({ name: s.string(), tagline: s.optional(s.string()), accent: s.optional(s.string()), logo: s.optional(s.string()), retentionDays: s.optional(s.integer()) }),
  handler: async (ctx) => {
    const row = await current(ctx);
    return row ? { name: row.name, tagline: row.tagline, accent: row.accent, logo: row.logo, retentionDays: row.retentionDays } : { ...DEFAULT_BRAND };
  },
});

export const save = app.mutation({
  access: "settings.write",
  args: {
    name: s.string({ minLength: 1, maxLength: 60 }),
    tagline: s.optional(s.string({ maxLength: 160 })),
    accent: s.optional(s.string({ maxLength: 7 })),
    logo: s.optional(s.string({ maxLength: 200_000 })),
    retentionDays: s.optional(s.integer({ minimum: 1, maximum: 3650 })),
  },
  returns: s.object({ ok: s.boolean() }),
  handler: async (ctx, args) => {
    const me = ctx.auth.requirePrincipal();
    if (args.accent && !/^#[0-9a-fA-F]{6}$/.test(args.accent)) fail("INVALID_ARGUMENT", "The accent colour is a hex colour like #4f46e5.");
    // A logo is an image the browser draws in an <img>: raster formats and SVG (which cannot run script there).
    if (args.logo && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(args.logo)) fail("INVALID_ARGUMENT", "The logo is a PNG, JPEG, WebP or SVG image.");
    const record = { key: KEY, name: args.name.trim(), ...(args.tagline?.trim() ? { tagline: args.tagline.trim() } : {}), ...(args.accent ? { accent: args.accent } : {}), ...(args.logo ? { logo: args.logo } : {}), ...(args.retentionDays ? { retentionDays: args.retentionDays } : {}), updatedAt: Date.now(), updatedBy: me.id };
    const row = await current(ctx);
    if (row) await ctx.db.replace(settings, row.id, record);
    else await ctx.db.insert(settings, record);
    return { ok: true };
  },
});
