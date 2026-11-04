// The Repository screen's Rust commands (src-tauri/src/repo_git.rs): a Git operation on the server, through ssh, and
// the same with progress lines passed on as the helper prints them (worktrees, ADR 0042).
import { Channel, invoke } from "@tauri-apps/api/core";
import { asRepoFailure, type RepoApi } from "../hermes/repo";
import type { Progress } from "../hermes/worktrees";

export const tauriRepo: RepoApi = {
  run: (target, request) =>
    invoke<unknown>("repo_git", { target, request }).catch((e: unknown) => {
      throw asRepoFailure(e);
    }),
  stream: (target, request, onProgress) => {
    const onProgressChannel = new Channel<Progress>();
    onProgressChannel.onmessage = onProgress;
    return invoke<unknown>("repo_git_stream", { target, request, onProgress: onProgressChannel }).catch((e: unknown) => {
      throw asRepoFailure(e);
    });
  },
};
