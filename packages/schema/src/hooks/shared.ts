import { type TObject, Type } from "@sinclair/typebox";
import { createValidator, type ValidationResult } from "../validate.js";

/**
 * Validates a hook payload against the schema for its event name, or against the base
 * schema when the event is new to us. Unknown fields are always allowed, so a vendor
 * adding fields never breaks ingest.
 */
export function createHookValidator<T>(
  discriminator: string,
  events: Readonly<Record<string, TObject>>,
  fallback: TObject,
): (value: unknown) => ValidationResult<T> {
  const validators = new Map(
    Object.entries(events).map(([name, schema]) => [name, createValidator(schema)]),
  );
  const fallbackValidator = createValidator(fallback);
  return (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, errors: [{ field: "(root)", message: "Expected an object" }] };
    }
    const name = (value as Record<string, unknown>)[discriminator];
    if (typeof name !== "string") {
      return {
        ok: false,
        errors: [{ field: discriminator, message: "Expected required property of type string" }],
      };
    }
    const validator = validators.get(name) ?? fallbackValidator;
    return validator.validate(value) as ValidationResult<T>;
  };
}

export const NullableString = (description?: string) =>
  Type.Union([Type.String(), Type.Null()], description ? { description } : {});
