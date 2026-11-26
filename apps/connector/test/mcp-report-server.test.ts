// The Otto MCP report + propose server (issue #17, ADR-0022 Stage 3): stdio JSON-RPC 2.0,
// two tools (`report` + `propose`), separate out-of-band files (`argv[2]` JSON report and
// `argv[3]` JSONL proposals) — driven over its real stdio pipe exactly like Claude Code,
// Codex CLI, and ACP v1 agents drive it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SERVER = join(import.meta.dirname, "../src/mcp/report-server.mjs");

let workDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  workDir = null;
});

interface Turn {
  stdout: string;
  stderr: string;
}

/** Spawns the server, writes the given LF-delimited requests on stdin, closes stdin, and
 *  collects everything it answered. One shot per turn — the real server lives as long as
 *  Claude Code / ACP keeps it, but every exchange here is stateless. */
function drive(requests: Array<Record<string, unknown>>, args: string[] = []): Turn {
  const result = spawnSync(process.execPath, [SERVER, ...args], {
    input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 15_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function lines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("otto MCP report + propose server (issue #17, ADR-0022 Stage 3)", () => {
  it("initializes, lists both report and propose tools, and answers ping", () => {
    const { stdout } = drive([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ]);
    const replies = lines(stdout);
    expect(replies).toHaveLength(3); // the notification gets NO response
    expect(replies[0]).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    const tools = replies[1]!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    expect(tools.tools.map((t) => t.name)).toEqual(["report", "propose"]);
    expect(tools.tools[0]!.inputSchema.required).toContain("status");
    expect(tools.tools[0]!.inputSchema.required).toContain("summary");
    expect(tools.tools[0]!.inputSchema.properties).toHaveProperty("answer");
    expect(tools.tools[0]!.inputSchema.properties).toHaveProperty("labels");
    expect(tools.tools[1]!.inputSchema.required).toEqual([
      "kind",
      "targetRepoRef",
      "prompt",
      "reason",
      "proposalKey",
    ]);
    expect(tools.tools[1]!.inputSchema.additionalProperties).toBe(false);
    expect(replies[2]).toMatchObject({ id: 3, result: {} });
  });

  it("accepts a valid report call (including unknown/excess labels without failing settlement) and persists it to the audit file", () => {
    workDir = mkdtempSync(join(tmpdir(), "otto-mcp-"));
    const audit = join(workDir, "w-1.json");
    const { stdout } = drive(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "report",
            arguments: {
              status: "done",
              summary: "shipped",
              decisions: ["sqlite"],
              labels: ["blocked-by-env", "unknown-label", "flaky-test", "needs-migration", "scope-creep"],
            },
          },
        },
      ],
      [audit],
    );
    const [reply] = lines(stdout);
    expect(reply).toMatchObject({ id: 1, result: { isError: false } });
    expect(((reply!.result as { content: Array<{ text: string }> }).content[0]!.text)).toContain("done");
    const persisted = JSON.parse(readFileSync(audit, "utf8") as string) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      status: "done",
      summary: "shipped",
      labels: ["blocked-by-env", "unknown-label", "flaky-test", "needs-migration", "scope-creep"],
    });
  });

  it("keeps argv[2] report JSON and argv[3] proposals JSONL strictly separated and rejects invalid proposals", () => {
    workDir = mkdtempSync(join(tmpdir(), "otto-mcp-"));
    const reportAudit = join(workDir, "reports", "w-dual.json");
    const proposalsAudit = join(workDir, "proposals", "proposals-w-dual.jsonl");

    const { stdout } = drive(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "propose",
            arguments: {
              kind: "readonly_probe",
              targetRepoRef: "shared-api",
              prompt: "Check auth middleware signature",
              reason: "Confirm header casing",
              proposalKey: "probe-auth-1",
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "propose",
            arguments: {
              kind: "readonly_probe",
              targetRepoRef: "billing-service",
              prompt: "Check webhook payload schema",
              reason: "Confirm invoice id field",
              proposalKey: "probe-billing-2",
            },
          },
        },
        {
          // Extra field must be rejected at tool boundary and NOT written to JSONL!
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "propose",
            arguments: {
              kind: "readonly_probe",
              targetRepoRef: "billing-service",
              prompt: "Sneak write",
              reason: "Extra arg",
              proposalKey: "probe-bad-3",
              mode: "write",
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "report",
            arguments: {
              status: "done",
              summary: "Completed local implementation while probes run",
            },
          },
        },
      ],
      [reportAudit, proposalsAudit],
    );

    const replies = lines(stdout);
    expect(replies[0]).toMatchObject({ id: 1, result: { isError: false } });
    expect(JSON.stringify(replies[0])).toContain("queued_for_steward_decision");
    expect(replies[1]).toMatchObject({ id: 2, result: { isError: false } });
    expect(replies[2]).toMatchObject({ id: 3, result: { isError: true } });
    expect(replies[3]).toMatchObject({ id: 4, result: { isError: false } });

    const persistedReport = JSON.parse(readFileSync(reportAudit, "utf8"));
    expect(persistedReport).toEqual({
      status: "done",
      summary: "Completed local implementation while probes run",
    });

    const persistedProposals = readFileSync(proposalsAudit, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persistedProposals).toEqual([
      {
        kind: "readonly_probe",
        targetRepoRef: "shared-api",
        prompt: "Check auth middleware signature",
        reason: "Confirm header casing",
        proposalKey: "probe-auth-1",
      },
      {
        kind: "readonly_probe",
        targetRepoRef: "billing-service",
        prompt: "Check webhook payload schema",
        reason: "Confirm invoice id field",
        proposalKey: "probe-billing-2",
      },
    ]);
  });

  it("rejects an invalid report as a tool-level error the model can fix and retry", () => {
    const { stdout } = drive([
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "report", arguments: { status: "blocked", summary: "need a decision" } } },
    ]);
    const [reply] = lines(stdout);
    expect(reply!.result).toMatchObject({ isError: true });
    expect(JSON.stringify(reply)).toContain("question");
  });

  it("answers unknown tools and methods with JSON-RPC errors", () => {
    const { stdout } = drive([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
    ]);
    const replies = lines(stdout);
    expect(replies[0]!.error).toBeDefined();
    expect(replies[1]!.error).toBeDefined();
  });

  it("is installed by installClaudeAssets under the state dir", async () => {
    const { installClaudeAssets } = await import("../src/install.ts");
    workDir = mkdtempSync(join(tmpdir(), "otto-mcp-"));
    const { serverPath } = installClaudeAssets(workDir, "test-version");
    expect(serverPath).toContain("mcp");
    expect(existsSync(serverPath)).toBe(true);
  });
});
