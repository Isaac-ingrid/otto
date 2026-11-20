import { basename } from "node:path";
import type { RegisterRepoResult } from "@isaac2ingrid/protocol";
import { repoHookCapabilitySummary } from "./hooks.ts";
import { scanRepoSkillBriefsSync } from "./repo-skills.ts";
import type { LocalStore } from "./store.ts";
import { identifyWorkspace } from "./worktree.ts";

export class DirectoryError extends Error {
  readonly code = "invalid_directory";
}

export async function registerRepository({
  store,
  path,
  stateDir,
}: {
  store: LocalStore;
  path: string;
  stateDir?: string;
}): Promise<RegisterRepoResult["repo"]> {
  let identity: Awaited<ReturnType<typeof identifyWorkspace>>;
  try {
    identity = await identifyWorkspace(path);
  } catch {
    throw new DirectoryError("Choose an existing directory on this machine.");
  }
  const repo = { repoId: identity.repoId, name: basename(identity.repoId), path: identity.repoId, capability: identity.capability };
  store.addRepo(repo);
  const stored = store.getRepo(identity.repoId);
  const hookSummary =
    stored && stateDir
      ? repoHookCapabilitySummary(stored, stateDir)
      : {
          capabilityKind: identity.capability.kind,
          hasSetupHook: Boolean(stored?.hooks.setupHook),
          hasArchiveHook: Boolean(stored?.hooks.archiveHook),
          approved: false,
        };
  const branch = identity.capability.kind === "git" ? identity.capability.defaultBranch : null;
  const remote = identity.capability.kind === "git" ? identity.capability.remote : null;
  const skills = scanRepoSkillBriefsSync(repo.path);
  return {
    repoId: repo.repoId,
    name: repo.name,
    path: repo.path,
    capability: identity.capability,
    defaultBranch: branch ?? "",
    remote: remote ?? "",
    capabilityKind: hookSummary.capabilityKind,
    hasSetupHook: hookSummary.hasSetupHook,
    hasArchiveHook: hookSummary.hasArchiveHook,
    approved: hookSummary.approved,
    projectApproved: stored?.approved === true,
    ...(skills.length > 0 ? { skills } : {}),
  };
}
