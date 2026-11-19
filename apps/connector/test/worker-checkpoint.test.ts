import { describe, expect, it } from "vitest";
import { WorkerCheckpointPayloadSchema, type HistoryEntry } from "@isaac2ingrid/protocol";
import { collectWorkerCheckpoint } from "../src/worker-checkpoint.ts";

describe("collectWorkerCheckpoint (L1 deterministic worker checkpoint)", () => {
  it("strips handoff prefix, collapses repeated commands, separates read vs modified files, and redacts secrets", async () => {
    const secret = "sk-ant-secret-key-998877665544332211";
    const entries: HistoryEntry[] = [
      {
        id: "u1",
        role: "user",
        text: `【交接简报】你接续 Thread t_1\n目标：修复认证\n本次任务：\n排查登录超时并补单测（token=${secret}）`,
      },
      {
        id: "a1",
        role: "assistant",
        text: "先查看认证中间件与路由。",
        tools: [
          { name: "Read", args: "src/auth.ts" },
          { name: "Read", args: "src/routes.ts" },
          { name: "Edit", args: "src/auth.ts" },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        text: `运行测试验证，密钥 ${secret} 不应外泄`,
        tools: [
          { name: "Bash", args: "pnpm test auth.test.ts" },
          { name: "Bash", args: "pnpm test auth.test.ts" },
          { name: "Bash", args: "pnpm typecheck" },
        ],
      },
      {
        id: "u2",
        role: "user",
        text: "顺便检查 session 超时常量",
      },
      {
        id: "a3",
        role: "assistant",
        text: "正在修改 session 超时阈值…",
        tools: [{ name: "replace_file_content", args: "src/session.ts" }],
      },
    ];

    const res = await collectWorkerCheckpoint({
      workerId: "w_chk_1",
      agent: "claude-code",
      sessionId: "sess_123",
      entries,
      extraSecrets: [secret],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(WorkerCheckpointPayloadSchema.safeParse(res.checkpoint).success).toBe(true);
    expect(res.checkpoint.turnCount).toBe(2);
    expect(res.checkpoint.toolCallCount).toBe(7);
    expect(res.checkpoint.initialGoal).toContain("排查登录超时并补单测");
    expect(res.checkpoint.initialGoal).not.toContain("【交接简报】");
    expect(res.checkpoint.initialGoal).not.toContain(secret);
    expect(res.checkpoint.lastPrompt).toBe("顺便检查 session 超时常量");
    // src/auth.ts was read then edited -> appears only in modified, not duplicated in read
    expect(res.checkpoint.touchedFiles.read).toEqual(["src/routes.ts"]);
    expect(res.checkpoint.touchedFiles.modified).toEqual(["src/auth.ts", "src/session.ts"]);
    expect(res.checkpoint.commandsRun).toEqual(["pnpm test auth.test.ts (×2)", "pnpm typecheck"]);
    expect(res.checkpoint.lastStep).toEqual({ tool: "replace_file_content", args: "src/session.ts" });
    expect(JSON.stringify(res.checkpoint)).not.toContain(secret);
  });
});
