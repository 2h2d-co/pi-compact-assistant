import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactAssistant } from "../src/extension.ts";

export default function extension(pi: ExtensionAPI): void {
  compactAssistant(pi);
}
