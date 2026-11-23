import { useEffect, useState } from "react";
import type { FeltKitClientError } from "@feltdb/feltkit/react";

export function describe(error: unknown): string {
  const e = error as FeltKitClientError;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  return e?.message ?? String(error);
}

/** Retry a mutation the server marked retryable (a concurrent write), a few times. */
export async function retrying<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (error) {
      if (i + 1 >= attempts || !(error as { retryable?: boolean })?.retryable) throw error;
      await new Promise((r) => setTimeout(r, 80 * (i + 1) + Math.random() * 80));
    }
  }
}

export type Route = { page: "home" } | { page: "settings" } | { page: "call"; code: string } | { page: "recap"; code: string; call?: number };

function parse(path: string): Route {
  if (path.replace(/\/$/, "") === "/settings") return { page: "settings" };
  const m = path.match(/^\/m\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/recap(?:\/(\d+))?)?\/?$/);
  if (!m) return { page: "home" };
  if (path.includes("/recap")) return { page: "recap", code: m[1]!, ...(m[2] ? { call: Number(m[2]) } : {}) };
  return { page: "call", code: m[1]! };
}

export function href(route: Route): string {
  if (route.page === "settings") return "/settings";
  if (route.page === "call") return `/m/${route.code}`;
  if (route.page === "recap") return `/m/${route.code}/recap${route.call ? `/${route.call}` : ""}`;
  return "/";
}

export function navigate(route: Route) {
  history.pushState(null, "", href(route));
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function when(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A meeting code typed or pasted as a code or a link. */
export function codeFrom(input: string): string | null {
  const m = input.trim().toLowerCase().match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  return m ? m[1]! : null;
}
