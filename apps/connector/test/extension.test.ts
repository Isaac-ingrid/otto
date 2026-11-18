import { describe, expect, it } from "vitest";
import ottoExtension, { COMMAND_ENTRY_TYPE, COMMAND_NAME, REMINDER_ENTRY_TYPE } from "../src/ext/otto-pi.ts";
import { wrapPrompt } from "../src/pi-adapter.ts";

/** The slice of pi's ExtensionAPI the extension uses — enough to drive it deterministically. */
class FakePi {
  readonly tools = new Map<string, { parameters: { properties: Record<string, unknown> }; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
  readonly commands = new Map<string, { handler: (args: string) => Promise<void> }>();
  readonly handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
  readonly appendedEntries: { customType: string; data?: unknown }[] = [];
  readonly sentUserMessages: { content: string; options?: Record<string, unknown> }[] = [];

  registerTool(tool: { name: string; parameters: { properties: Record<string, unknown> }; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }): void {
    this.tools.set(tool.name, tool);
  }
  registerCommand(name: string, options: { handler: (args: string) => Promise<void> }): void {
    this.commands.set(name, options);
  }
  on(event: string, handler: (event: Record<string, unknown>) => unknown): void {
    this.handlers.set(event, handler);
  }
  appendEntry(customType: string, data?: unknown): void {
    this.appendedEntries.push({ customType, data });
  }
  sendUserMessage(content: string, options?: Record<string, unknown>): void {
    this.sentUserMessages.push({ content, options });
  }
}

function fresh() {
  const pi = new FakePi();
  ottoExtension(pi as never);
  return pi;
}

function userRun(pi: FakePi) {
  pi.handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "user", prompt: "task" });
}

function beforeSettle(pi: FakePi, event: Partial<Record<string, unknown>> = {}) {
  return pi.handlers.get("agent_before_settle")!({
    type: "agent_before_settle",
    outcome: "completed",
    entries: [],
    continue: false,
    context: { canContinue: true },
    ...event,
  }) as { entries?: unknown[]; continue?: boolean } | undefined;
}

describe("otto pi extension (connector-pi.md §7, ADR-0001)", () => {
  it("the connector's prompt wrapper and the extension's command name agree", () => {
    // wrapPrompt builds `/otto <commandId>\n<text>`; if the two sides drift, prompts
    // leak the wrapper to the model. Real pi verified: disposition "handled".
    expect(wrapPrompt("cmd-1", "do it")).toBe(`/${COMMAND_NAME} cmd-1\ndo it`);
  });

  it("registers the report tool with the §7.2 fields including bounded labels", () => {
    const pi = fresh();
    const tool = pi.tools.get("report");
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.parameters.properties)).toEqual([
      "status",
      "summary",
      "changes",
      "decisions",
      "leftovers",
      "tests",
      "question",
      "next",
      "answer",
      "labels",
    ]);
  });

  it("keeps unbundled otto-pi.ts and report-server.mjs label vocabularies locked to @isaac2ingrid/protocol", async () => {
    const { MAX_REPORT_LABELS, REPORT_LABEL_VOCABULARY } = await import("@isaac2ingrid/protocol");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const pi = fresh();
    const piDesc = String((pi.tools.get("report")!.parameters.properties.labels as { description?: string }).description ?? "");
    const mcpSource = readFileSync(join(import.meta.dirname, "../src/mcp/report-server.mjs"), "utf8");
    expect(piDesc).toContain(`max ${MAX_REPORT_LABELS}`);
    expect(mcpSource).toContain(`max ${MAX_REPORT_LABELS}`);
    for (const label of REPORT_LABEL_VOCABULARY) {
      expect(piDesc).toContain(label);
      expect(mcpSource).toContain(label);
    }
  });

  it("normalizeReport preserves undefined vs [], deduplicates before capping at 3, and logs dropped entries", async () => {
    const { normalizeReport } = await import("../src/pi-adapter.ts");
    const omitted = normalizeReport({ status: "done", summary: "ok" });
    expect(omitted).toEqual({ status: "done", summary: "ok" });
    expect("labels" in omitted!).toBe(false);

    const explicitEmpty = normalizeReport({ status: "done", summary: "ok", labels: [] });
    expect(explicitEmpty).toEqual({ status: "done", summary: "ok", labels: [] });

    const diagnostics: string[] = [];
    const mixed = normalizeReport(
      {
        status: "done",
        summary: "ok",
        labels: [
          "blocked-by-env",
          "unknown-label",
          "blocked-by-env",
          "flaky-test",
          "needs-migration",
          "scope-creep",
        ],
      },
      { onDiagnostic: (msg) => diagnostics.push(msg) },
    );
    expect(mixed?.labels).toEqual(["blocked-by-env", "flaky-test", "needs-migration"]);
    expect(diagnostics).toEqual(["report.labels dropped invalid/excess entries: unknown-label, scope-creep"]);
  });

  it("report execute acknowledges and records the call", async () => {
    const pi = fresh();
    const tool = pi.tools.get("report")!;
    const result = (await tool.execute("call-1", { status: "done", summary: "fixed it" })) as {
      content: { type: string; text: string }[];
    };
    expect(result.content[0]!.text).toContain("done");
  });

  it("report rejects blocked/needs_decision without a question", async () => {
    const pi = fresh();
    const tool = pi.tools.get("report")!;
    await expect(tool.execute("call-2", { status: "blocked", summary: "no access" })).rejects.toThrow(/question/);
  });

  it("records the commandId into a custom entry and re-sends the clean text (ADR-0001)", async () => {
    const pi = fresh();
    await pi.commands.get(COMMAND_NAME)!.handler("cmd-01ABC\nFix the login bug\non two lines");
    expect(pi.appendedEntries).toEqual([{ customType: COMMAND_ENTRY_TYPE, data: { commandId: "cmd-01ABC", at: expect.any(Number) } }]);
    expect(pi.sentUserMessages).toEqual([
      { content: "Fix the login bug\non two lines", options: { expandPromptTemplates: false } },
    ]);
  });

  it("passes malformed /otto args through as plain text without a marker", async () => {
    const pi = fresh();
    await pi.commands.get(COMMAND_NAME)!.handler("just a plain prompt");
    expect(pi.appendedEntries).toEqual([]);
    expect(pi.sentUserMessages).toEqual([{ content: "just a plain prompt", options: { expandPromptTemplates: false } }]);
  });

  it("forces exactly one re-report per window when a completed run did not report", () => {
    const pi = fresh();
    userRun(pi);

    const first = beforeSettle(pi);
    expect(first?.continue).toBe(true);
    expect(first?.entries).toEqual([
      { type: "custom_message", customType: REMINDER_ENTRY_TYPE, content: expect.stringContaining("report"), display: false },
    ]);

    // Second settle in the same window: no second reminder.
    expect(beforeSettle(pi)).toBeUndefined();
  });

  it("does not remind after report was called in the window", async () => {
    const pi = fresh();
    userRun(pi);
    await pi.tools.get("report")!.execute("c", { status: "done", summary: "s" });
    expect(beforeSettle(pi)).toBeUndefined();
  });

  it("does not remind on error or aborted outcomes", () => {
    const pi = fresh();
    userRun(pi);
    expect(beforeSettle(pi, { outcome: "error" })).toBeUndefined();
    expect(beforeSettle(pi, { outcome: "aborted" })).toBeUndefined();
  });

  it("does not remind when continuation is impossible", () => {
    const pi = fresh();
    userRun(pi);
    expect(beforeSettle(pi, { context: { canContinue: false } })).toBeUndefined();
  });

  it("a new user prompt opens a fresh window (reminder allowed again)", () => {
    const pi = fresh();
    userRun(pi);
    expect(beforeSettle(pi)?.continue).toBe(true);
    userRun(pi);
    expect(beforeSettle(pi)?.continue).toBe(true);
  });

  it("the reminder continuation itself does not open a new window", () => {
    const pi = fresh();
    userRun(pi);
    expect(beforeSettle(pi)?.continue).toBe(true);
    // The forced continuation re-enters before_agent_start as a custom message — the same
    // window must persist, so no second reminder fires.
    pi.handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "custom", message: {} });
    expect(beforeSettle(pi)).toBeUndefined();
  });

  it("chains entries proposed by earlier handlers", () => {
    const pi = fresh();
    userRun(pi);
    const earlier = { type: "custom_message", customType: "other-extension", content: "hi", display: false };
    const result = beforeSettle(pi, { entries: [earlier] });
    expect(result?.entries?.[0]).toBe(earlier);
    expect(result?.entries?.[1]).toMatchObject({ customType: REMINDER_ENTRY_TYPE });
  });

  it("registers the propose tool (readonly_probe) returning queued_for_steward_decision and validates via normalizeProposal", async () => {
    const { normalizeProposal } = await import("../src/pi-adapter.ts");
    const pi = fresh();
    const propose = pi.tools.get("propose");
    expect(propose).toBeDefined();
    expect(Object.keys(propose!.parameters.properties)).toEqual([
      "kind",
      "targetRepoRef",
      "prompt",
      "reason",
      "proposalKey",
    ]);

    const ack = (await propose!.execute("call-p1", {
      kind: "readonly_probe",
      targetRepoRef: "shared-contracts",
      prompt: "Inspect DTOs",
      reason: "Check response shape",
      proposalKey: "probe-dto-1",
    })) as { content: { type: string; text: string }[] };
    expect(ack.content[0]!.text).toContain("queued_for_steward_decision");

    await expect(
      propose!.execute("call-p2", {
        kind: "write_task",
        targetRepoRef: "shared-contracts",
        prompt: "Mutate repo",
        reason: "Not allowed",
        proposalKey: "probe-bad",
      }),
    ).rejects.toThrow(/readonly_probe/);

    expect(
      normalizeProposal({
        kind: "readonly_probe",
        targetRepoRef: "shared-contracts",
        prompt: "Inspect DTOs",
        reason: "Check response shape",
        proposalKey: "probe-dto-1",
      }),
    ).toEqual({
      kind: "readonly_probe",
      targetRepoRef: "shared-contracts",
      prompt: "Inspect DTOs",
      reason: "Check response shape",
      proposalKey: "probe-dto-1",
    });
    expect(
      normalizeProposal({
        kind: "readonly_probe",
        targetRepoRef: "shared-contracts",
        prompt: "Inspect DTOs",
        reason: "Check response shape",
        proposalKey: "probe-dto-1",
        extra: "forbidden",
      }),
    ).toBeNull();
  });
});
