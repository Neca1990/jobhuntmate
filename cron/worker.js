// The scheduler: every 15 minutes asks the site whether the search is due (someone in their active hours whose
// interval has passed) and, when it is and no search is already running, starts it on GitHub. This keeps
// GitHub runs to the ones that have work to do. POST /run (from the site's admin page) starts one right away.
const GH = "https://api.github.com";

async function dispatch(env, inputs) {
  const gh = { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "scheduler" };
  const base = `${GH}/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}`;
  for (const status of ["queued", "in_progress"]) {
    const runs = await (await fetch(`${base}/runs?status=${status}&per_page=1`, { headers: gh })).json();
    if (runs.total_count) return { started: false, reason: `already_${status}` };
  }
  const r = await fetch(`${base}/dispatches`, { method: "POST", headers: { ...gh, "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs }) });
  return r.ok ? { started: true } : { started: false, reason: `github_${r.status}` };
}

async function tick(env) {
  const due = await (await fetch(`${env.SITE_URL}/api/engine/due`, { headers: { authorization: `Bearer ${env.ENGINE_KEY}` } })).json();
  if (!due.due) return `not due (${due.reason || "?"})`;
  const r = await dispatch(env, { trigger: "scheduler" });
  return r.started ? `started (${due.users} users)` : r.reason;
}

// compares hashes of equal length, so the answer time doesn't reveal how much of the key was right
async function sameKey(a, b) {
  const h = async (x) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(x, y) : x.every((v, i) => v === y[i]);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).then((result) => console.log(result)));
  },
  // "search now" from the site's admin page (the site holds the same ENGINE_KEY)
  async fetch(request, env) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") return new Response("scheduler");
    if (!env.ENGINE_KEY || !(await sameKey(request.headers.get("authorization") || "", `Bearer ${env.ENGINE_KEY}`))) {
      return new Response("forbidden", { status: 403 });
    }
    const body = await request.json().catch(() => ({}));
    // a just-approved posting: only "is it still up" (a search already running checks it at its end anyway)
    if (body.check) return Response.json(await dispatch(env, { trigger: "check", check_only: "true" }));
    // "search everything for me": only the archive, no sites (a search already running takes it at its end)
    if (body.search_all) return Response.json(await dispatch(env, { trigger: "search-all", search_all: "true" }));
    return Response.json(await dispatch(env, { trigger: body.full ? "admin-full" : "admin", force: "true", full_scan: body.full ? "true" : "false" }));
  },
};
