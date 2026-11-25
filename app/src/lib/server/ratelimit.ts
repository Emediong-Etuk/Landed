import "server-only";

/**
 * Fixed-window counters. Uses Upstash Redis REST when configured (shared across
 * serverless instances); otherwise an in-memory map (fine for a single instance / local).
 */
const mem = new Map<string, { n: number; reset: number }>();
const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export async function hit(key: string, limit: number, windowSecs: number): Promise<{ ok: boolean; count: number }> {
  if (URL_ && TOKEN) {
    try {
      const r = await fetch(`${URL_}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSecs), "NX"]]),
        cache: "no-store",
      });
      const j = (await r.json()) as { result: number }[];
      const count = Number(j[0]?.result ?? 0);
      return { ok: count <= limit, count };
    } catch {
      /* fall through to memory */
    }
  }
  const now = Date.now();
  const e = mem.get(key);
  if (!e || e.reset < now) {
    mem.set(key, { n: 1, reset: now + windowSecs * 1000 });
    return { ok: true, count: 1 };
  }
  e.n++;
  return { ok: e.n <= limit, count: e.n };
}

export function clientIp(h: Headers): string {
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
}
