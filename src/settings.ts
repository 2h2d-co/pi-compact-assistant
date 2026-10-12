import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SETTINGS_FILE_NAME = "pi-compact-assistant.json";

/** A token count, or a percentage of the model's context window written as `"70%"`. */
export type Threshold = number | `${number}%`;

export interface Thresholds {
  /** Optional. Without it, only the self-contained compaction instruction is posted. */
  prepareAt?: Threshold;
  compactAt: Threshold;
}

export interface Settings {
  enabled: boolean;
  /** Thresholds for models without their own entry, or false to skip those models. */
  default: Thresholds | false;
  /** Entries keyed by exact `provider/modelId`. False skips that model. */
  models: Record<string, Thresholds | false>;
}

export interface ResolvedThresholds {
  prepareTokens?: number;
  compactTokens: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  default: { prepareAt: "70%", compactAt: "80%" },
  models: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseThreshold(value: unknown, path: string): Threshold {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${path} must be a positive whole token count or a percentage like "70%".`);
    }
    return value;
  }
  if (typeof value === "string") {
    const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
    const percent = match ? Number(match[1]) : Number.NaN;
    if (percent > 0 && percent < 100) return `${percent}%`;
  }
  throw new Error(
    `${path} must be a positive whole token count or a percentage between 0% and 100%, like "70%".`,
  );
}

function parseThresholds(value: unknown, path: string): Thresholds | false {
  if (value === false) return false;
  if (!isRecord(value)) {
    throw new Error(
      `${path} must be an object with compactAt and an optional prepareAt, or false.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== "prepareAt" && key !== "compactAt") {
      throw new Error(`${path}.${key} is not a setting. Use prepareAt and compactAt.`);
    }
  }
  const compactAt = parseThreshold(value["compactAt"], `${path}.compactAt`);
  return value["prepareAt"] === undefined
    ? { compactAt }
    : { prepareAt: parseThreshold(value["prepareAt"], `${path}.prepareAt`), compactAt };
}

/** Validate a settings document. Omitted top-level fields use the defaults. */
export function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new Error("Settings must be a JSON object.");
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "default" && key !== "models") {
      throw new Error(`${key} is not a setting. Use enabled, default, and models.`);
    }
  }
  const enabled = value["enabled"] ?? DEFAULT_SETTINGS.enabled;
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false.");
  const fallback =
    value["default"] === undefined
      ? DEFAULT_SETTINGS.default
      : parseThresholds(value["default"], "default");
  const models: Record<string, Thresholds | false> = {};
  const entries = value["models"] ?? {};
  if (!isRecord(entries)) throw new Error('models must be an object keyed by "provider/modelId".');
  for (const [key, entry] of Object.entries(entries)) {
    if (!/^[^/]+\/.+$/.test(key)) {
      throw new Error(`models key "${key}" must be an exact "provider/modelId".`);
    }
    models[key] = parseThresholds(entry, `models["${key}"]`);
  }
  return { enabled, default: fallback, models };
}

/** Read the settings file. A missing file uses the defaults. */
export async function loadSettings(directory: string): Promise<Settings> {
  const file = join(directory, SETTINGS_FILE_NAME);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return DEFAULT_SETTINGS;
    }
    throw new Error(`Cannot read ${file}.`, { cause: error });
  }
  try {
    return parseSettings(JSON.parse(text));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid JSON.";
    throw new Error(`Invalid settings in ${file}: ${reason}`, { cause: error });
  }
}

function tokens(threshold: Threshold, contextWindow: number): number {
  if (typeof threshold === "number") return threshold;
  return Math.floor((contextWindow * Number.parseFloat(threshold)) / 100);
}

/**
 * Resolve token thresholds for one model. Returns undefined when the model is skipped.
 * Throws when a configured preparation threshold is not below the compaction threshold.
 */
export function resolveThresholds(
  settings: Settings,
  model: string,
  contextWindow: number,
): ResolvedThresholds | undefined {
  if (!settings.enabled) return undefined;
  const selected = Object.hasOwn(settings.models, model)
    ? (settings.models[model] ?? false)
    : settings.default;
  if (!selected) return undefined;
  const compactTokens = tokens(selected.compactAt, contextWindow);
  if (selected.prepareAt === undefined) return { compactTokens };
  const prepareTokens = tokens(selected.prepareAt, contextWindow);
  if (prepareTokens >= compactTokens) {
    throw new Error(
      `prepareAt (${prepareTokens} tokens) must be below compactAt (${compactTokens} tokens) for ${model}.`,
    );
  }
  return { prepareTokens, compactTokens };
}
