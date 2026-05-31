"use client";

/**
 * Client-side JSON Schema validation for the patch bundle. Runs in
 * the browser before `contribute()` ships a PR, so contributors see
 * schema errors immediately instead of waiting for the reference-data
 * CI on `main` to fail.
 *
 * Defence in depth — CI on `main` still validates after the PR
 * lands; this is a fast-feedback gate, not the source of truth.
 *
 * Schemas are vendored from `main` at `src/schemas/*.schema.json`.
 * When the canonical schemas on `main` change, refresh the vendored
 * copies — there is no auto-sync.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import slopeSchema from "@/schemas/slope.schema.json";
import liftSchema from "@/schemas/lift.schema.json";
import placeSchema from "@/schemas/place.schema.json";
import webcamSchema from "@/schemas/webcam.schema.json";
import slopeGraphSchema from "@/schemas/slope-graph.schema.json";

import type { PatchBundle } from "./ci-status";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Filename → compiled validator. Patch bundles use these flat
// relative paths (matching the registry tree). Unknown filenames are
// skipped silently — a future entity type doesn't need to crash
// validation on existing types.
const validators: Record<string, ValidateFunction> = {
  "slopes.json": ajv.compile(slopeSchema),
  "lifts.json": ajv.compile(liftSchema),
  "place.json": ajv.compile(placeSchema),
  "webcams.json": ajv.compile(webcamSchema),
  "slope-graph.json": ajv.compile(slopeGraphSchema),
};

export type SchemaValidationError = {
  /** Filename in the bundle, e.g. `slopes.json`. */
  file: string;
  /** JSON pointer into the document, e.g. `/slopes/0/coordinates/0/lat`. `/` for root-level errors. */
  path: string;
  /** Human-readable error message from AJV. */
  message: string;
};

function formatError(file: string, err: ErrorObject): SchemaValidationError {
  const params = err.params ? Object.entries(err.params) : [];
  const paramStr = params.length
    ? ` (${params.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`
    : "";
  return {
    file,
    path: err.instancePath || "/",
    message: `${err.message ?? "invalid"}${paramStr}`,
  };
}

/**
 * Validate every file in the patch bundle. Returns an empty array
 * when the bundle is clean. Unknown filenames (e.g. a future
 * `lessons.json`) are skipped without comment — they fall through
 * to CI on main.
 */
export function validatePatchBundle(bundle: PatchBundle): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  for (const [filename, jsonString] of Object.entries(bundle.files)) {
    const validator = validators[filename];
    if (!validator) continue;

    let data: unknown;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      errors.push({
        file: filename,
        path: "/",
        message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const ok = validator(data);
    if (!ok && validator.errors) {
      for (const err of validator.errors) {
        errors.push(formatError(filename, err));
      }
    }
  }
  return errors;
}

/**
 * Format a list of validation errors as a single user-readable
 * string for display in the save UI. Caps the visible count so a
 * malformed file doesn't explode the textbox; the full list is
 * always available in dev tools via the return value of
 * `validatePatchBundle`.
 */
export function formatValidationErrors(
  errors: SchemaValidationError[],
  max = 5,
): string {
  if (errors.length === 0) return "";
  const shown = errors.slice(0, max);
  const lines = shown.map((e) => `• ${e.file}${e.path}: ${e.message}`);
  if (errors.length > max) {
    lines.push(`… and ${errors.length - max} more`);
  }
  return lines.join("\n");
}
