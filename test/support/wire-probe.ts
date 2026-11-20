import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROBE_TYPE = "pi-compact-assistant-live:probe";
export const TOOLS_PROBE_TYPE = "pi-compact-assistant-live:tools";

export interface ProbedInstruction {
  stage: "compact";
  role: string;
  index: number;
  count: number;
  /** Characters in the payload's top-level system prompt. */
  systemLength: number;
  /** Whether the top-level system prompt equals that of the latest request without instructions. */
  systemUnchanged: boolean;
  /** Whether the instruction's text appears in the top-level system prompt. */
  systemHasInstruction: boolean;
}

/** The tools one request declares, recorded when its turn ends. */
export interface ProbedTools {
  /** Every tool the request leaves declared, including tools added inside the conversation. */
  names: string[];
  /** The tools in the payload's top-level `tools` field. */
  top: string[];
  /** The instruction stages the request carries. */
  stages: string[];
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

function toolName(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
    ? value.name
    : undefined;
}

function toolNames(declarations: unknown): string[] {
  const tools: unknown[] = Array.isArray(declarations) ? declarations : [];
  return tools.flatMap((tool) => toolName(tool) ?? []);
}

/** The header of Pi AI's Codex removal notice, followed by one `- name` line per removed tool. */
const REMOVAL_NOTICE = "The following tools are no longer available. Do not call them:\n";

/** The tools a Codex developer message announces as removed. */
function removedTools(text: string): string[] {
  const start = text.indexOf(REMOVAL_NOTICE);
  if (start < 0) return [];
  const lines = text.slice(start + REMOVAL_NOTICE.length).split("\n");
  const end = lines.findIndex((line) => !line.startsWith("- "));
  return lines.slice(0, end < 0 ? undefined : end).map((line) => line.slice(2));
}

/**
 * The tools a payload leaves declared. Anthropic keeps the first request's `tools` for the prompt
 * cache and changes the set with `tool_addition` and `tool_removal` blocks in the conversation.
 * Pi AI's Codex adapter declares tools in `additional_tools` input items and announces removals
 * in developer text, because those items cannot remove a tool.
 */
function declaredTools(declarations: unknown, items: readonly unknown[]): string[] {
  const names = new Set(toolNames(declarations));
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    if ("type" in item && item.type === "additional_tools" && "tools" in item) {
      for (const name of toolNames(item.tools)) names.add(name);
      continue;
    }
    if (!("content" in item)) continue;
    if ("role" in item && item.role === "developer") {
      for (const name of removedTools(textOf(item.content))) names.delete(name);
    }
    const blocks: unknown[] = Array.isArray(item.content) ? item.content : [];
    for (const block of blocks) {
      if (typeof block !== "object" || block === null || !("type" in block)) continue;
      if (!("tool" in block) || typeof block.tool !== "object" || block.tool === null) continue;
      if (block.type === "tool_removal") {
        const name = toolName(block.tool);
        if (name) names.delete(name);
      } else if (block.type === "tool_addition" && "definition" in block.tool) {
        const name = toolName(block.tool.definition);
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * The leading system prompt: Anthropic Messages `system`, the Codex Responses `instructions` that
 * pi-openai-codex-compat passes to extensions, or the first developer message in `input` that Pi's
 * own Codex adapter sends after its `additional_tools` items.
 */
function topLevelSystem(payload: {
  system?: unknown;
  instructions?: unknown;
  input?: unknown;
}): string {
  if (payload.system !== undefined) return textOf(payload.system);
  if (payload.instructions !== undefined) return textOf(payload.instructions);
  if (!Array.isArray(payload.input)) return "";
  const first: unknown = payload.input.find(
    (item: unknown) =>
      !(
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "additional_tools"
      ),
  );
  if (
    typeof first !== "object" ||
    first === null ||
    "type" in first ||
    !("role" in first) ||
    first.role !== "developer" ||
    !("content" in first)
  ) {
    return "";
  }
  return textOf(first.content);
}

/**
 * Live-test fixture. Records where compaction instructions appear in each provider payload:
 * Anthropic Messages `messages`, or Codex Responses `input`, and whether the payload's top-level
 * system prompt stayed as it was before the instructions. It also records the tools each payload
 * declares.
 */
export default function wireProbe(pi: ExtensionAPI): void {
  let tools: ProbedTools | undefined;
  /** The top-level system prompt of the latest request without instructions. */
  let baseline: string | undefined;
  pi.on("turn_end", () => {
    if (tools) pi.appendEntry(TOOLS_PROBE_TYPE, tools);
    tools = undefined;
  });
  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return undefined;
    const items =
      "messages" in payload && Array.isArray(payload.messages)
        ? payload.messages
        : "input" in payload && Array.isArray(payload.input)
          ? payload.input
          : [];
    const system = topLevelSystem(payload);
    const found: ProbedInstruction[] = [];
    items.forEach((item: unknown, index: number) => {
      if (typeof item !== "object" || item === null || !("role" in item)) return;
      const text = "content" in item ? textOf(item.content) : "";
      const stage = text.startsWith("[Compaction required]") ? "compact" : undefined;
      if (stage) {
        found.push({
          stage,
          role: String(item.role),
          index,
          count: items.length,
          systemLength: system.length,
          systemUnchanged: baseline !== undefined && system === baseline,
          systemHasInstruction: system.includes(text),
        });
      }
    });
    if (found.length > 0) pi.appendEntry(PROBE_TYPE, { found });
    else baseline = system;
    // Appending an entry while compaction runs makes native compaction cancel, so the tools are
    // recorded when the turn ends.
    const declarations = "tools" in payload ? payload.tools : undefined;
    tools = {
      names: declaredTools(declarations, items),
      top: toolNames(declarations),
      stages: found.map((item) => item.stage),
    };
    return undefined;
  });
}
