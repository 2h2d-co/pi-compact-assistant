import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROBE_TYPE = "pi-compact-assistant-live:probe";

export interface ProbedInstruction {
  stage: "prepare" | "compact";
  role: string;
  index: number;
  count: number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}

/**
 * Live-test fixture. Records where compaction instructions appear in each provider payload:
 * Anthropic Messages `messages`, or Codex Responses `input`.
 */
export default function wireProbe(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return undefined;
    const items =
      "messages" in payload && Array.isArray(payload.messages)
        ? payload.messages
        : "input" in payload && Array.isArray(payload.input)
          ? payload.input
          : [];
    const found: ProbedInstruction[] = [];
    items.forEach((item: unknown, index: number) => {
      if (typeof item !== "object" || item === null || !("role" in item)) return;
      const text = "content" in item ? textOf(item.content) : "";
      const stage = text.startsWith("[Compaction preparation]")
        ? "prepare"
        : text.startsWith("[Compaction required]")
          ? "compact"
          : undefined;
      if (stage) found.push({ stage, role: String(item.role), index, count: items.length });
    });
    if (found.length > 0) pi.appendEntry(PROBE_TYPE, { found });
    return undefined;
  });
}
