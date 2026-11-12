import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The org the current request acts for, on a hosted server (SELFHOST_MODE=hosted). On Postgres,
 * every query made while a scope is set runs in a transaction that sets selfhost.org first, and
 * the row-level security policies of migration 0021 then show and accept only that org's rows.
 * With no scope (a self-hosted install, the admin token, the server's own jobs) the policies
 * let every row through, as before.
 */
const scope = new AsyncLocalStorage<{ org: string | undefined }>();

/** Runs fn with every query limited to `org`'s rows. */
export function withOrg<T>(org: string, fn: () => T): T {
  if (org === "") throw new Error("withOrg: expected an org id");
  return scope.run({ org }, fn);
}

/**
 * Runs fn with no org scope, for the server's own work that spans orgs (the review refresh,
 * notifications, retention) when a request starts it: a refresh woken by one org's events must
 * still read every org's.
 */
export function asSystem<T>(fn: () => T): T {
  return scope.run({ org: undefined }, fn);
}

/** The org queries are limited to now, or undefined for none. */
export function currentOrg(): string | undefined {
  return scope.getStore()?.org;
}
