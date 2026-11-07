import {
  FormatRegistry,
  Kind,
  type SchemaOptions,
  type TSchema,
  type TUnsafe,
  Type,
  TypeRegistry,
} from "@sinclair/typebox";

/** Base URL of the published JSON Schemas. Each schema's `$id` lives under it. */
export const SCHEMA_BASE_URL = "https://selfhost.ai/schema/v1";

export function schemaId(file: string): string {
  return `${SCHEMA_BASE_URL}/${file}`;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set(
    "date-time",
    (value) => DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)),
  );
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
}

if (!TypeRegistry.Has("StringEnum")) {
  TypeRegistry.Set<{ enum: readonly string[] }>(
    "StringEnum",
    (schema, value) => typeof value === "string" && schema.enum.includes(value),
  );
}

/**
 * A string limited to a fixed set of values. Exported as `{ "type": "string", "enum": [...] }`,
 * which reads better in JSON Schema than a union of literals.
 */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: SchemaOptions = {},
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ ...options, [Kind]: "StringEnum", type: "string", enum: values });
}

export function isStringEnum(schema: TSchema): schema is TSchema & { enum: string[] } {
  return schema[Kind] === "StringEnum";
}

const UUIDV7_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export const Uuidv7 = (options: SchemaOptions = {}) =>
  Type.String({ pattern: UUIDV7_PATTERN, ...options });

export const DateTime = (options: SchemaOptions = {}) =>
  Type.String({ format: "date-time", ...options });

export const Url = (options: SchemaOptions = {}) => Type.String({ format: "uri", ...options });

export const RepoSlug = (options: SchemaOptions = {}) =>
  Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", ...options });

export const NonEmpty = (options: SchemaOptions = {}) => Type.String({ minLength: 1, ...options });

/**
 * Fields that become required when a discriminator has a given value, for example
 * `decision` when `kind` is `decision.recorded`. Exported to JSON Schema as `if`/`then`
 * pairs and checked in code by `requiredWhenErrors`.
 */
export type RequiredWhen = Readonly<Record<string, readonly string[]>>;

export function requiredWhenSchema(discriminator: string, table: RequiredWhen) {
  return Object.entries(table).map(([value, fields]) => ({
    if: { properties: { [discriminator]: { const: value } }, required: [discriminator] },
    // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword.
    then: { required: [...fields] },
  }));
}
