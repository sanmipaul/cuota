import { NextResponse, type NextRequest } from "next/server";

const LANGS = ["es", "pt", "en"] as const;

/** Pick the first supported language from Accept-Language; Spanish otherwise. */
function preferred(header: string | null): (typeof LANGS)[number] {
  const ranked = (header ?? "")
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { lang: (tag ?? "").slice(0, 2).toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  return (ranked.find((r) => (LANGS as readonly string[]).includes(r.lang))?.lang as (typeof LANGS)[number]) ?? "es";
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (LANGS.some((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`))) return;
  const url = request.nextUrl.clone();
  url.pathname = `/${preferred(request.headers.get("accept-language"))}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals, the agent rewrite and static files.
  matcher: ["/((?!_next|agent|favicon.ico|.*\\..*).*)"],
};
