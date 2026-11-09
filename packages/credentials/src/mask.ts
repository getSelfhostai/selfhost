import {
  type LedgerEvent,
  MIN_LITERAL_LENGTH,
  maskLiterals,
  type RedactionSettings,
  redactEvent,
  type SecretLiteral,
} from "@selfhost/schema";

/** A run's secret found where it should not be. Says where and which, never the value. */
export interface Leak {
  /** Position of the text in the scanned list. */
  index: number;
  /** The secret's variable name. */
  name: string;
  /** How it appeared: as is, base64 encoded or URL encoded. */
  form: "raw" | "base64" | "url";
}

function forms(value: string): [Leak["form"], string][] {
  const out: [Leak["form"], string][] = [["raw", value]];
  const base64 = Buffer.from(value, "utf8").toString("base64").replace(/=+$/, "");
  if (base64.length >= MIN_LITERAL_LENGTH) out.push(["base64", base64]);
  const url = encodeURIComponent(value);
  if (url !== value) out.push(["url", url]);
  return out;
}

/**
 * Checks texts (ledger events as JSON, log lines, files a run left behind) for any of the run's
 * secret values, as is, base64 encoded or URL encoded. Values shorter than
 * MIN_LITERAL_LENGTH are not looked for. The result never carries a value.
 */
export function scanForLeaks(texts: readonly string[], secrets: readonly SecretLiteral[]): Leak[] {
  const leaks: Leak[] = [];
  const wanted = secrets.filter((secret) => secret.value.length >= MIN_LITERAL_LENGTH);
  texts.forEach((text, index) => {
    for (const secret of wanted) {
      const found = forms(secret.value).find(([, variant]) => text.includes(variant));
      if (found) leaks.push({ index, name: secret.name, form: found[0] });
    }
  });
  return leaks;
}

/** Masks a run's secret values, then the usual patterns, in text and in ledger events. */
export interface SecretMasker {
  text(text: string): string;
  event(event: LedgerEvent, settings?: RedactionSettings): LedgerEvent;
  /** `settings` with the run's values added, for the ledger's own redaction. */
  settings(settings?: RedactionSettings): RedactionSettings;
}

export function secretMasker(secrets: () => readonly SecretLiteral[]): SecretMasker {
  const settings = (base?: RedactionSettings): RedactionSettings => ({
    logPrompts: base?.logPrompts ?? false,
    patterns: base?.patterns ?? [],
    literals: [...(base?.literals ?? []), ...secrets()],
  });
  return {
    text: (text) => maskLiterals(text, secrets()).text,
    event: (event, base) => redactEvent(event, settings(base)),
    settings,
  };
}
