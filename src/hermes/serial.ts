// Runs connection changes one at a time (ADR 0049). Rust holds one connection, and a connect that finished after a
// later one would take it back, so each change starts only once the one before has finished, and a change that a
// newer one has overtaken stops at its next step (`stale()`), closing whatever it opened, before the next one runs.

export type Serial = <T>(job: (stale: () => boolean) => Promise<T>) => Promise<T>;

export function serial(): Serial {
  let chain: Promise<unknown> = Promise.resolve();
  let latest = 0;
  return (job) => {
    const n = ++latest;
    const run = chain.catch(() => {}).then(() => job(() => n !== latest));
    chain = run;
    return run;
  };
}

/**
 * Runs `job` on `serial`, but a `signal` that aborts while the job still waits its turn rejects at once with
 * `stopped()`, and the job then never starts. Once the job has started, stopping it is the job's own business.
 */
export function stoppable<T>(serial: Serial, signal: AbortSignal | undefined, stopped: () => Error, job: (stale: () => boolean) => Promise<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(stopped());
  let started = false;
  const run = serial(async (stale) => {
    if (signal?.aborted) throw stopped();
    started = true;
    return job(stale);
  });
  if (!signal) return run;
  run.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!started) reject(stopped());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void run.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
