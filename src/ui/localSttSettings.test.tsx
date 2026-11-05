// @vitest-environment jsdom
// Settings → Voice → Speech to text (ADR 0062), against an in-memory stand-in for the Rust commands and a stand-in
// microphone. Rust's own checks (only found or dialog-picked programs run) are tested in src-tauri/src/local_stt.rs.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FoundEngine, LocalEngine, LocalSttApi, LocalSttState } from "../hermes/localStt";
import { LocalSttSettings, TEST_SECONDS } from "./LocalSttSettings";
import type { AudioEnv } from "./recorder";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const WHISPER: FoundEngine = {
  kind: "whisper-cpp",
  label: "whisper.cpp",
  binary: "/usr/bin/whisper-cli",
  version: "whisper.cpp version: 1.9.5",
  models: ["/home/o/.local/share/whisper.cpp/ggml-base.en.bin", "/home/o/.local/share/whisper.cpp/ggml-small.bin"],
};

/** Keeps the choice as Rust would, without its checks. */
function fakeApi(found: FoundEngine[], start: LocalSttState = { onThisComputer: false }) {
  let state = start;
  const sets: [boolean, LocalEngine | undefined][] = [];
  const api: LocalSttApi = {
    state: async () => state,
    detect: vi.fn(async () => found),
    set: async (onThisComputer, engine) => {
      sets.push([onThisComputer, engine]);
      const chosen = engine ?? state.engine;
      state = { onThisComputer, engine: chosen, label: chosen ? "whisper.cpp" : null, problem: chosen?.model ? null : "No model is chosen." };
      return state;
    },
    pickProgram: async () => undefined,
    pickModel: async () => undefined,
    onChange: () => () => {},
  };
  return { api, sets };
}

/**
 * A microphone, a new track each time; `track` is the last, `tracks` all of them. `hang`: the audio system never
 * finishes starting (`resume()` stays pending).
 */
function fakeMic(hang = false) {
  const tracks: { stopped: boolean; onended: null | (() => void) }[] = [];
  const newTrack = () => {
    const track = { stopped: false, readyState: "live", onended: null as null | (() => void), stop: () => void (track.stopped = true) };
    tracks.push(track);
    return track;
  };
  const env: AudioEnv = {
    mediaDevices: {
      getUserMedia: async () => {
        const track = newTrack();
        return { getAudioTracks: () => [track], getTracks: () => [track] } as never;
      },
    },
    makeContext: () =>
      ({
        sampleRate: 16_000,
        state: hang ? "suspended" : "running",
        resume: () => new Promise(() => {}),
        destination: {},
        createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
        createScriptProcessor: () => ({ onaudioprocess: null, connect: () => {}, disconnect: () => {} }),
        close: async () => {},
      }) as never,
  };
  return {
    env,
    tracks,
    get track() {
      return tracks[tracks.length - 1];
    },
  };
}

describe("Speech to text: where it runs", () => {
  it("starts on the Hermes server, and This computer lists the engines found with their version and path", async () => {
    const { api, sets } = fakeApi([WHISPER]);
    render(<LocalSttSettings api={api} connected />);
    expect(await screen.findByRole("radio", { name: "Hermes server" })).toHaveProperty("ariaChecked", "true");
    expect(api.detect).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("radio", { name: "This computer" }));
    expect(sets).toEqual([[true, undefined]]);
    expect(await screen.findByText("The recording never leaves this computer. Only the text goes to Hermes.")).toBeTruthy();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Engine" }), WHISPER.binary);
    // The first model found is taken until the owner picks another.
    expect(sets[1]).toEqual([true, { kind: "whisper-cpp", binary: WHISPER.binary, model: WHISPER.models[0] }]);
    expect(await screen.findByText("/usr/bin/whisper-cli")).toBeTruthy();
    expect(screen.getByText(/1\.9\.5/)).toBeTruthy();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), WHISPER.models[1]);
    expect(sets[2]).toEqual([true, { kind: "whisper-cpp", binary: WHISPER.binary, model: WHISPER.models[1] }]);

    await userEvent.click(screen.getByRole("radio", { name: "Hermes server" }));
    expect(sets[3]).toEqual([false, undefined]);
    expect(await screen.findByText("Recordings go to Hermes, which transcribes them.")).toBeTruthy();
  });

  it("says None installed with a how-to when nothing is found, and still offers Choose a program", async () => {
    const { api } = fakeApi([], { onThisComputer: true, problem: "No speech-to-text engine is chosen on this computer." });
    render(<LocalSttSettings api={api} connected />);
    expect(await screen.findByText(/None installed\. Install one/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose a program/ })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Engine" })).toBeNull();
  });

  it("says why a chosen engine can't run, and that nothing goes to Hermes instead", async () => {
    const engine = { kind: "whisper-cpp" as const, binary: "/opt/whisper-cli", model: "/gone.bin" };
    const { api } = fakeApi([WHISPER], { onThisComputer: true, engine, label: "whisper.cpp", problem: "The model /gone.bin isn't there any more." });
    render(<LocalSttSettings api={api} connected />);
    expect((await screen.findByRole("status")).textContent).toMatch(/isn't there any more\. .*nothing is sent to Hermes instead/);
    // A program picked in a dialog, not on PATH, is still listed as the one in use.
    expect((screen.getByRole("combobox", { name: "Engine" }) as HTMLSelectElement).value).toBe("/opt/whisper-cli");
  });
});

describe("Speech to text: Test", () => {
  it(`records ${TEST_SECONDS} s, transcribes it the way Dictation does, and shows the text and time`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = fakeApi([WHISPER], { onThisComputer: true });
    const mic = fakeMic();
    const env = mic.env;
    const transcribe = vi.fn(async () => ({ text: "hello there", provider: "whisper.cpp" }));
    render(<LocalSttSettings api={api} connected transcribe={transcribe} env={env} />);
    await userEvent.click(await screen.findByRole("button", { name: /Test/ }), { advanceTimers: vi.advanceTimersByTime });
    expect(await screen.findByText(/Recording… say something/)).toBeTruthy();
    expect(transcribe).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    await waitFor(() => expect(screen.getByText(/“hello there” .* s, by whisper\.cpp\./)).toBeTruthy());
    expect(transcribe).toHaveBeenCalledWith(expect.any(Uint8Array), "audio/wav");
    expect(mic.track.stopped).toBe(true);
  });

  it("says why the local engine failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = fakeApi([WHISPER], { onThisComputer: true });
    const transcribe = vi.fn(async () => Promise.reject(new Error("whisper.cpp exited with 3: failed to load model")));
    render(<LocalSttSettings api={api} connected transcribe={transcribe} env={fakeMic().env} />);
    await userEvent.click(await screen.findByRole("button", { name: /Test/ }), { advanceTimers: vi.advanceTimersByTime });
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    expect((await screen.findByRole("alert")).textContent).toBe("whisper.cpp exited with 3: failed to load model");
  });

  it("closes the microphone when the tab closes mid-test", async () => {
    const { api } = fakeApi([], { onThisComputer: false });
    const mic = fakeMic();
    const transcribe = vi.fn();
    const view = render(<LocalSttSettings api={api} connected transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /Test/ }));
    await screen.findByText(/Recording… say/);
    view.unmount();
    expect(mic.track.stopped).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("closes a Test's microphone when the setting changes, so a second Test can't leave the first one open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = fakeApi([], { onThisComputer: false });
    const mic = fakeMic();
    const transcribe = vi.fn(async () => ({ text: "second" }));
    const view = render(<LocalSttSettings api={api} connected transcribe={transcribe} env={mic.env} />);
    const click = (el: HTMLElement) => userEvent.click(el, { advanceTimers: vi.advanceTimersByTime });
    await click(await screen.findByRole("button", { name: /Test/ }));
    await screen.findByText(/Recording… say/);
    await click(screen.getByRole("radio", { name: "This computer" }));
    expect(mic.tracks[0].stopped).toBe(true);
    await click(screen.getByRole("button", { name: /Test/ }));
    await screen.findByText(/Recording… say/);
    expect(mic.tracks).toHaveLength(2);
    // The first Test's timer firing changes nothing; only the second is transcribed.
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    await waitFor(() => expect(screen.getByText(/“second”/)).toBeTruthy());
    expect(transcribe).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mic.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("closes a microphone that is still starting when the tab closes", async () => {
    const { api } = fakeApi([]);
    const mic = fakeMic(true);
    const transcribe = vi.fn();
    const view = render(<LocalSttSettings api={api} connected transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /Test/ }));
    await waitFor(() => expect(mic.tracks).toHaveLength(1));
    expect(screen.queryByText(/Recording… say/)).toBeNull();
    view.unmount();
    expect(mic.track.stopped).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("stops the Test when the microphone is unplugged, and doesn't transcribe what was dropped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api } = fakeApi([]);
    const mic = fakeMic();
    const transcribe = vi.fn(async () => ({ text: "" }));
    render(<LocalSttSettings api={api} connected transcribe={transcribe} env={mic.env} />);
    await userEvent.click(await screen.findByRole("button", { name: /Test/ }), { advanceTimers: vi.advanceTimersByTime });
    await screen.findByText(/Recording… say/);
    act(() => mic.track.onended?.());
    expect((await screen.findByRole("alert")).textContent).toMatch(/disconnected/);
    await act(() => vi.advanceTimersByTimeAsync(TEST_SECONDS * 1000));
    expect(transcribe).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/disconnected/);
  });
});
