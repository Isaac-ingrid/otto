import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real git worktree fixtures (`makeGitRepo`), process-tree probes, and Windows CIM/PowerShell
    // spawns contend for CPU/Defender I/O when CI runs multiple test files concurrently.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
