import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { testModelConnection } from "./connection-test.ts";
import type { StewardModelConfig } from "./models.ts";

/** A successful tiny completion proves the endpoint accepts a level, not that it honors it.
 * Only probe the exact configured model ID; never infer other models from a template. */
export async function probeAcceptedThinkingLevels(
  config: StewardModelConfig,
  key: string,
  probe: typeof testModelConnection = testModelConnection,
): Promise<ModelThinkingLevel[]> {
  const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const results = await Promise.all(levels.map((thinkingLevel) => probe({ ...config, thinkingLevel }, key)));
  return levels.filter((_, index) => results[index]?.ok);
}
