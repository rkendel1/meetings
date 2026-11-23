/**
 * The deployment's brand (feltkit/settings.ts): name, tagline, accent colour and logo. It is a public query, so the
 * sign-in page wears it before anyone signs in; changing it in Settings changes every open page at once.
 */
import { useEffect, type ReactNode } from "react";
import { useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

export type Brand = { name: string; tagline?: string | undefined; accent?: string | undefined; logo?: string | undefined };
export const DEFAULT_BRAND: Brand = { name: "Meetings" };

export function useBrand(): Brand {
  return useQueryState(api.settings.brand).data ?? DEFAULT_BRAND;
}

/** Black or white, whichever reads better on the accent colour. */
function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = 0.2126 * (r ?? 0) ** 2.2 + 0.7152 * (g ?? 0) ** 2.2 + 0.0722 * (b ?? 0) ** 2.2;
  return lum > 0.35 ? "#111111" : "#ffffff";
}

export function useApplyBrand(brand: Brand) {
  useEffect(() => {
    document.title = brand.name;
    const root = document.documentElement.style;
    if (brand.accent) {
      root.setProperty("--accent", brand.accent);
      root.setProperty("--accent-ink", inkFor(brand.accent));
      root.setProperty("--accent-soft", `color-mix(in srgb, ${brand.accent} 16%, transparent)`);
    } else for (const v of ["--accent", "--accent-ink", "--accent-soft"]) root.removeProperty(v);
  }, [brand.name, brand.accent]);
}

export function BrandMark({ brand, children }: { brand: Brand; children?: ReactNode }) {
  return (
    <>
      <span className="logo" aria-hidden>
        {brand.logo ? (
          <img src={brand.logo} alt="" width={30} height={30} style={{ objectFit: "contain", borderRadius: 8 }} />
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v1.8l3.2-2.1A1.2 1.2 0 0 1 21 7.2v9.6a1.2 1.2 0 0 1-1.8 1L16 15.7v1.8a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 17.5z" /></svg>
        )}
      </span>
      <span className="brand-name">{brand.name}</span>
      {children}
    </>
  );
}
