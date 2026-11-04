// Runs connection changes one at a time (ADR 0048). Rust holds one connection, and a connect that finished after a
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
