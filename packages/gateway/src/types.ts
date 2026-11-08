import type {
  GatewayBudget,
  GatewayBudgetPeriod,
  GatewayKey,
  GatewayKeyKind,
  LedgerEvent,
  RouterTool,
} from "@selfhost/schema";

/** A hard limit to set on the gateway: USD per day, week, calendar month, or a run's life. */
export interface BudgetLimit {
  period: GatewayBudgetPeriod;
  limit_usd: number;
}

/** Who a key belongs to. Its name and the metadata on the gateway say the same. */
export interface KeyOwner {
  kind: GatewayKeyKind;
  team: string;
  person?: string;
  run_id?: string;
}

/** What selfhost decides for a key: its limits, providers and whether it works. */
export interface KeySettings {
  budgets: BudgetLimit[];
  /** Providers in fallback order; empty allows every provider the gateway has keys for. */
  providers: string[];
  active: boolean;
}

/** A key selfhost manages, as read back from the gateway. Never its value. */
export interface ManagedKey extends GatewayKey {
  providers: string[];
}

/** A team selfhost manages on the gateway. */
export interface ManagedTeam {
  /** The gateway's own id. */
  id: string;
  team: string;
  budgets: GatewayBudget[];
}

export interface IssuedKey {
  key: ManagedKey;
  /** The virtual key. Goes to whoever asked for it, once; never stored or logged. */
  value: string;
}

/**
 * One AI gateway's management API. Implementations hold the admin credential and send it only to
 * the gateway; nothing they return carries it, and key values appear only in IssuedKey.
 */
export interface GatewayClient {
  readonly tool: RouterTool;
  health(): Promise<{ ok: boolean; detail?: string }>;
  /**
   * The part of a policy this gateway can hold: LiteLLM keeps one budget window and no
   * per-key providers. What it cannot hold stays an alert, and the sync compares only this.
   */
  held(limits: BudgetLimit[]): BudgetLimit[];
  heldProviders(providers: string[]): string[];
  /** Teams named selfhost:<team>. */
  teams(): Promise<ManagedTeam[]>;
  createTeam(team: string, budgets: BudgetLimit[]): Promise<ManagedTeam>;
  updateTeam(existing: ManagedTeam, budgets: BudgetLimit[]): Promise<void>;
  /** Keys named selfhost:<kind>:..., without their values. */
  keys(): Promise<ManagedKey[]>;
  /** `team` is the gateway team the key's spend also counts against, when there is one. */
  createKey(owner: KeyOwner, settings: KeySettings, team?: ManagedTeam): Promise<IssuedKey>;
  updateKey(existing: ManagedKey, settings: KeySettings): Promise<void>;
  /** A new value for an existing key, keeping its limits where the gateway can. */
  rotateKey(existing: ManagedKey, settings: KeySettings, team?: ManagedTeam): Promise<IssuedKey>;
  /**
   * Finished requests from `from` to `to`, in the order the gateway pages them, mapped to ledger events, one page per
   * item (possibly empty). Stops after maxPages: when it yielded that many, there may be more.
   */
  requests(from: Date, to: Date, maxPages: number): AsyncIterable<LedgerEvent[]>;
}

/** An error answer from the gateway, or no answer (status 0). Its message carries no secret. */
export class GatewayError extends Error {
  override name = "GatewayError";

  constructor(
    readonly status: number,
    message: string,
    /** The gateway's own error type, such as budget_exceeded. */
    readonly type?: string,
  ) {
    super(message);
  }
}
