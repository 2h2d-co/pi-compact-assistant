import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atLeastVersion } from "./pi-version.ts";

type ContextModel = NonNullable<ExtensionContext["model"]>;

/** Providers whose request paths the live tests cover. */
export const SUPPORTED_PROVIDERS: readonly string[] = ["anthropic", "openai-codex"];
export const CODEX_PROVIDER = "openai-codex";
export const CODEX_COMPAT_PACKAGE = "pi-openai-codex-compat";
/** Earlier versions build Codex requests only from the stored session and drop the instructions. */
export const MINIMUM_CODEX_COMPAT_VERSION = "0.0.23";

/**
 * Whether Pi sends this model's later system messages in place. Otherwise Pi folds them into
 * the leading system prompt, which changes the cached prefix.
 */
export function acceptsMidConversationSystemMessages(model: ContextModel): boolean {
  const compat: unknown = model.compat;
  return (
    typeof compat === "object" &&
    compat !== null &&
    "supportsMidConvoSystemMessages" in compat &&
    compat.supportsMidConvoSystemMessages === true
  );
}

/**
 * Why the extension does not instruct this model, or undefined when it does.
 * `codexCompatProblem` comes from {@link findCodexCompatProblem}.
 */
export function unsupportedReason(
  model: ContextModel,
  codexCompatProblem: string | undefined,
): string | undefined {
  const key = `${model.provider}/${model.id}`;
  if (!SUPPORTED_PROVIDERS.includes(model.provider)) {
    return `${key} uses the ${model.provider} provider. Supported providers are ${SUPPORTED_PROVIDERS.join(" and ")}.`;
  }
  if (!acceptsMidConversationSystemMessages(model)) {
    return `${key} does not accept system messages mid-conversation.`;
  }
  if (model.provider === CODEX_PROVIDER && codexCompatProblem) return codexCompatProblem;
  return undefined;
}

async function nearestManifest(path: string): Promise<Record<string, unknown> | undefined> {
  let directory = dirname(path);
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed))
        : undefined;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Find the loaded pi-openai-codex-compat package through the source of its commands and tools,
 * and report why its version cannot carry the instructions to Codex. Undefined when it is not
 * loaded or is recent enough.
 */
export async function findCodexCompatProblem(pi: ExtensionAPI): Promise<string | undefined> {
  const paths = new Set(
    [...pi.getCommands(), ...pi.getAllTools()]
      .map((item) => item.sourceInfo.path)
      .filter((path) => isAbsolute(path)),
  );
  for (const path of paths) {
    const manifest = await nearestManifest(path);
    if (manifest?.["name"] !== CODEX_COMPAT_PACKAGE) continue;
    const version = manifest["version"];
    if (atLeastVersion(version, MINIMUM_CODEX_COMPAT_VERSION)) return undefined;
    const found = typeof version === "string" ? version : "of an unknown version";
    return `${CODEX_COMPAT_PACKAGE} ${found} drops these instructions from Codex requests. Update it to ${MINIMUM_CODEX_COMPAT_VERSION} or later.`;
  }
  return undefined;
}
