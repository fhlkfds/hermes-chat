import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const host = window.parent as Window & { e2eInvoke: (cmd: string, args: unknown) => Promise<unknown> };
// Vitest rewrites each `import()` to go through its runner, which only the test's own frame defines.
(globalThis as { __vitest_browser_runner__?: unknown }).__vitest_browser_runner__ ??= { wrapDynamicImport: (load: () => unknown) => load() };
mockWindows("main");
mockIPC((cmd, args) => host.e2eInvoke(cmd, args), { shouldMockEvents: true });
