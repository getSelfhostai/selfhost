/**
 * In-memory stand-ins for the Bifrost and LiteLLM management APIs, for tests here and in the
 * server. They follow the shapes in each gateway's docs; no provider is ever called.
 */
export interface Call {
  method: string;
  path: string;
  body?: unknown;
  authorization?: string;
}

type Json = Record<string, unknown>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Bifrost's management API as its v2.4 reference describes it, in memory: teams and virtual keys
 * with budgets, rotate, paged key lists, /api/logs answering a recorded page, and /health.
 * Calls without the admin's basic auth answer 401, as Bifrost does with auth_config on.
 */
export function fakeBifrost(options: { password?: string; logs?: unknown } = {}) {
  const password = options.password ?? "test-admin-password";
  const expected = `Basic ${Buffer.from(`selfhost:${password}`).toString("base64")}`;
  const teams = new Map<string, Json>();
  const keys = new Map<string, Json>();
  const calls: Call[] = [];
  let next = 1;
  let healthy = true;
  const budgets = (list: unknown) =>
    ((list as Json[] | undefined) ?? []).map((b) => ({
      id: `budget-${next++}`,
      current_usage: 0,
      ...b,
    }));

  async function fetch(url: string, init: RequestInit): Promise<Response> {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    calls.push({
      method,
      path: `${pathname}${searchParams.size ? `?${searchParams}` : ""}`,
      ...(body ? { body } : {}),
      ...(headers.get("authorization")
        ? { authorization: headers.get("authorization") ?? "" }
        : {}),
    });
    if (pathname === "/health") {
      return healthy
        ? json(200, { status: "ok", components: { config_store: "ok", log_store: "ok" } })
        : json(503, { type: "unavailable", error: { message: "config store unreachable" } });
    }
    if (headers.get("authorization") !== expected) {
      return json(401, { type: "unauthorized", error: { message: "authentication required" } });
    }
    if (pathname === "/api/governance/teams" && method === "GET") {
      return json(200, { teams: [...teams.values()], count: teams.size });
    }
    if (pathname === "/api/governance/teams" && method === "POST") {
      const team = { id: `team-${next++}`, name: body?.name, budgets: budgets(body?.budgets) };
      teams.set(team.id, team);
      return json(200, { message: "Team created successfully", team });
    }
    const teamMatch = /^\/api\/governance\/teams\/([^/]+)$/.exec(pathname);
    if (teamMatch && method === "PUT") {
      const team = teams.get(decodeURIComponent(teamMatch[1] ?? ""));
      if (!team) return json(404, { type: "not_found", error: { message: "team not found" } });
      Object.assign(team, { name: body?.name, budgets: budgets(body?.budgets) });
      return json(200, { message: "Team updated successfully", team });
    }
    if (pathname === "/api/governance/virtual-keys" && method === "GET") {
      const limit = Number(searchParams.get("limit") ?? 25);
      const offset = Number(searchParams.get("offset") ?? 0);
      const search = (searchParams.get("search") ?? "").toLowerCase();
      const all = [...keys.values()].filter((k) => String(k.name).toLowerCase().includes(search));
      return json(200, {
        virtual_keys: all.slice(offset, offset + limit),
        count: Math.min(limit, Math.max(0, all.length - offset)),
        total_count: all.length,
        limit,
        offset,
      });
    }
    if (pathname === "/api/governance/virtual-keys" && method === "POST") {
      const id = `vk-${next++}`;
      const key = {
        id,
        value: `sk-bf-${id}-secret-value`,
        ...body,
        budgets: budgets(body?.budgets),
        provider_configs: body?.provider_configs ?? [],
        mcp_configs: [],
        calendar_aligned: false,
        config_hash: "x",
        created_at: "2026-11-05T00:00:00Z",
        updated_at: "2026-11-05T00:00:00Z",
      };
      keys.set(id, key);
      return json(200, { message: "Virtual key created successfully", virtual_key: key });
    }
    const rotate = /^\/api\/governance\/virtual-keys\/([^/]+)\/rotate$/.exec(pathname);
    if (rotate && method === "POST") {
      const key = keys.get(decodeURIComponent(rotate[1] ?? ""));
      if (!key)
        return json(404, { type: "not_found", error: { message: "virtual key not found" } });
      key.value = `sk-bf-${key.id}-rotated-${next++}`;
      return json(200, { message: "Virtual key rotated successfully", virtual_key: key });
    }
    const keyMatch = /^\/api\/governance\/virtual-keys\/([^/]+)$/.exec(pathname);
    if (keyMatch && method === "PUT") {
      const key = keys.get(decodeURIComponent(keyMatch[1] ?? ""));
      if (!key)
        return json(404, { type: "not_found", error: { message: "virtual key not found" } });
      Object.assign(key, { ...body, budgets: budgets(body?.budgets) });
      return json(200, { message: "Virtual key updated successfully", virtual_key: key });
    }
    if (pathname === "/api/logs" && method === "GET") {
      return json(200, options.logs ?? { logs: [], pagination: { total_count: 0 } });
    }
    return json(404, { type: "not_found", error: { message: `no route ${method} ${pathname}` } });
  }

  return {
    fetch,
    calls,
    teams,
    keys,
    password,
    setHealthy: (value: boolean) => {
      healthy = value;
    },
  };
}

/**
 * The LiteLLM proxy endpoints selfhost calls, in memory, behind the master key: teams, keys with
 * one budget window each, block and delete, /spend/logs/v2 answering a recorded page.
 */
export function fakeLiteLLM(options: { masterKey?: string; spendLogs?: unknown } = {}) {
  const masterKey = options.masterKey ?? "sk-test-master";
  const teams = new Map<string, Json>();
  const keys = new Map<string, Json>();
  const calls: Call[] = [];
  let next = 1;

  async function fetch(url: string, init: RequestInit): Promise<Response> {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    calls.push({
      method,
      path: `${pathname}${searchParams.size ? `?${searchParams}` : ""}`,
      ...(body ? { body } : {}),
    });
    if (pathname === "/health/liveliness") return json(200, "I'm alive!");
    if (headers.get("authorization") !== `Bearer ${masterKey}`) {
      return json(401, {
        error: { message: "Authentication Error, invalid master key", type: "auth_error" },
      });
    }
    if (pathname === "/team/list") return json(200, [...teams.values()]);
    if (pathname === "/team/new") {
      const id = String(body?.team_id);
      if (teams.has(id))
        return json(400, { error: { message: `Team id = ${id} already exists.` } });
      teams.set(id, { spend: 0, ...body });
      return json(200, teams.get(id));
    }
    if (pathname === "/team/update") {
      const team = teams.get(String(body?.team_id));
      if (!team) return json(404, { error: { message: "Team not found" } });
      Object.assign(team, body);
      return json(200, { team_id: team.team_id, data: team });
    }
    if (pathname === "/key/list") {
      const list = [...keys.values()].map(({ key: _secret, ...rest }) => rest);
      return json(200, { keys: list, total_count: list.length, current_page: 1, total_pages: 1 });
    }
    if (pathname === "/key/generate") {
      const token = `hashed-${next++}`;
      const value = `sk-litellm-${token}-secret`;
      keys.set(token, { token, key: value, spend: 0, blocked: false, ...body });
      return json(200, { ...keys.get(token) });
    }
    if (pathname === "/key/update") {
      const key = keys.get(String(body?.key));
      if (!key) return json(404, { error: { message: "Key not found" } });
      const { key: _id, ...rest } = body ?? {};
      Object.assign(key, rest);
      return json(200, { ...key, key: undefined });
    }
    if (pathname === "/key/block" || pathname === "/key/unblock") {
      const key = keys.get(String(body?.key));
      if (!key) return json(404, { error: { message: "Key not found" } });
      key.blocked = pathname === "/key/block";
      return json(200, { token: key.token, blocked: key.blocked });
    }
    if (pathname === "/key/delete") {
      for (const id of (body?.keys as string[]) ?? []) keys.delete(id);
      return json(200, { deleted_keys: body?.keys });
    }
    if (pathname === "/spend/logs/v2") {
      return json(
        200,
        options.spendLogs ?? { data: [], total: 0, page: 1, page_size: 1000, total_pages: 0 },
      );
    }
    return json(404, { error: { message: `no route ${pathname}` } });
  }

  return { fetch, calls, teams, keys, masterKey };
}
