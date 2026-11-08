import { Kind, type Static, type TSchema } from "@sinclair/typebox";
import { TypeCheck, TypeCompiler } from "@sinclair/typebox/compiler";
import { DefaultErrorFunction, SetErrorFunction } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import type { RequiredWhen } from "./common.js";

/** One validation problem, located by field path such as `actor.kind` or `rules[0].mode`. */
export interface FieldError {
  field: string;
  message: string;
  /** 1-based line in the source file, when the input came from a file. */
  line?: number;
  column?: number;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export const ROOT_FIELD = "(root)";

SetErrorFunction((param) => {
  if (param.schema[Kind] === "StringEnum") {
    return `Expected one of: ${(param.schema.enum as string[]).join(", ")}`;
  }
  if (param.schema.format !== undefined && typeof param.value === "string") {
    return `Expected a ${param.schema.format} string`;
  }
  if (param.schema.pattern !== undefined && typeof param.value === "string") {
    return `Expected a string matching ${param.schema.pattern}`;
  }
  return DefaultErrorFunction(param);
});

export type Segment = string | number;

/** Splits a TypeBox error path (an RFC 6901 JSON pointer) into keys and array indexes. */
export function pointerToSegments(pointer: string, root: unknown): Segment[] {
  if (pointer === "") return [];
  const segments: Segment[] = [];
  let node: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node) && /^\d+$/.test(key)) {
      segments.push(Number(key));
      node = node[Number(key)];
    } else {
      segments.push(key);
      node =
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined;
    }
  }
  return segments;
}

/** Formats segments as `rules[0].match.command`, quoting keys that are not plain words. */
export function formatField(segments: readonly Segment[]): string {
  if (segments.length === 0) return ROOT_FIELD;
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z0-9_-]+$/.test(segment)) out += out === "" ? segment : `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

export interface SegmentError {
  segments: Segment[];
  message: string;
}

/** Runs a compiled check and returns one error per field, first message wins. */
export function schemaErrors(check: TypeCheck<TSchema>, value: unknown): SegmentError[] {
  if (check.Check(value)) return [];
  const seen = new Set<string>();
  const errors: SegmentError[] = [];
  for (const error of check.Errors(value)) {
    if (seen.has(error.path)) continue;
    seen.add(error.path);
    errors.push({ segments: pointerToSegments(error.path, value), message: error.message });
  }
  return errors;
}

export function requiredWhenErrors(
  value: Record<string, unknown>,
  discriminator: string,
  table: RequiredWhen,
): SegmentError[] {
  const key = value[discriminator];
  if (typeof key !== "string") return [];
  const fields = table[key] ?? [];
  return fields
    .filter((field) => value[field] === undefined)
    .map((field) => ({
      segments: [field],
      message: `Required when ${discriminator} is "${key}"`,
    }));
}

export function toFieldErrors(errors: readonly SegmentError[]): FieldError[] {
  return errors.map((error) => ({ field: formatField(error.segments), message: error.message }));
}

/**
 * Compiles a schema on first use, so importing the package stays cheap. Where code cannot be
 * compiled at run time (a page whose content security policy forbids eval, like the console),
 * the same schema is checked by walking it instead: same answers, only slower.
 */
export function lazyCheck<T extends TSchema>(schema: T): () => TypeCheck<T> {
  let compiled: TypeCheck<T> | undefined;
  return () => {
    if (compiled) return compiled;
    try {
      compiled = TypeCompiler.Compile(schema);
    } catch (error) {
      if (!(error instanceof EvalError)) throw error;
      compiled = new TypeCheck(schema, [], (value) => Value.Check(schema, value), "");
    }
    return compiled;
  };
}

export interface Validator<T extends TSchema> {
  schema: T;
  /** Fast boolean check with no error details. */
  check(value: unknown): value is Static<T>;
  validate(value: unknown): ValidationResult<Static<T>>;
}

export function createValidator<T extends TSchema>(
  schema: T,
  extra?: (value: Static<T>) => SegmentError[],
): Validator<T> {
  const compiled = lazyCheck(schema);
  const validate = (value: unknown): ValidationResult<Static<T>> => {
    const errors = schemaErrors(compiled(), value);
    if (errors.length === 0 && extra) errors.push(...extra(value as Static<T>));
    if (errors.length > 0) return { ok: false, errors: toFieldErrors(errors) };
    return { ok: true, value: value as Static<T> };
  };
  return {
    schema,
    check: (value): value is Static<T> =>
      compiled().Check(value) && (extra === undefined || extra(value).length === 0),
    validate,
  };
}
