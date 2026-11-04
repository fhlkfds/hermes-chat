// The Repository screen's one Rust command (src-tauri/src/repo_git.rs): a Git operation on the server, through ssh.
import { invoke } from "@tauri-apps/api/core";
import { asRepoFailure, type RepoApi } from "../hermes/repo";

export const tauriRepo: RepoApi = {
  run: (target, request) =>
    invoke<unknown>("repo_git", { target, request }).catch((e: unknown) => {
      throw asRepoFailure(e);
    }),
};
