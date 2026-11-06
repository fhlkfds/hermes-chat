// Which ways to sign in the sign-in screen and Setup offer (ADR 0058): the ones the server advertises that Hermes Chat
// supports, as Rust reads them from its public `/api/status` and `/api/auth/providers` (`hermes_reach`). With one, there
// is no picker, so a password-only server looks as it always did. The method a connection used last is picked first.
import { routesOf, singleRoute } from "./routes";
import type { Methods, Reached, SignInDetails, SignInMethod } from "./tauriPipe";

const PASSWORD = { method: "password", provider: "basic", label: "Password" } satisfies SignInMethod;

/** Reaches one route without signing in, and says what it found (tauriPipe `tauriReach`). */
export type ReachForMethods = (d: SignInDetails, expectServer: string | undefined) => Promise<Reached>;

/**
 * The methods `d`'s server offers, from the first of its routes that is on and answers. Password, with a note, when
 * none answers: the screen never offers nothing.
 */
export async function readMethods(reach: ReachForMethods, d: SignInDetails): Promise<Methods> {
  for (const r of routesOf(d).filter((r) => !r.off)) {
    try {
      const got = await reach(singleRoute(d, r), d.server);
      if (got.methods?.methods.length) return got.methods;
    } catch {
      // The next route may answer.
    }
  }
  return { methods: [PASSWORD], note: "unread" };
}

/** Whether `m` is the method `d` signs in with. */
export const isPicked = (m: SignInMethod, d: SignInDetails) =>
  m.method === "token" ? d.method === "token" : d.method !== "token" && m.provider === (d.provider ?? "basic");

/**
 * The methods to offer for `d`. Before they are known, the one `d` signs in with. When the server's answer couldn't be
 * read, a token sign-in is offered beside Password, so a connection that uses one can still sign in.
 */
export function offered(methods: Methods | undefined, d: SignInDetails): SignInMethod[] {
  const own: SignInMethod = d.method === "token" ? { method: "token" } : { ...PASSWORD, provider: d.provider ?? "basic" };
  if (!methods) return [own];
  if (methods.note === "unread" && d.method === "token" && !methods.methods.some((m) => m.method === "token")) return [...methods.methods, own];
  return methods.methods;
}

/** The method to start on: the one `d` signs in with, if offered; otherwise the first offered. */
export const firstPick = (list: SignInMethod[], d: SignInDetails): SignInMethod => list.find((m) => isPicked(m, d)) ?? list[0];

/** `d` signing in with `m`. A token typed for another method isn't kept, nor is a password for a token. */
export function withMethod(d: SignInDetails, m: SignInMethod): SignInDetails {
  const { method: _method, provider: _provider, token: _token, ...rest } = d;
  if (m.method === "token") return { ...rest, password: "", method: "token" };
  const { savedToken: _saved, ...password } = rest;
  return m.provider === "basic" ? password : { ...password, provider: m.provider };
}

/** A method's name on the picker: Password and Token, or each password provider's own name when there are several. */
export function methodLabel(m: SignInMethod, list: SignInMethod[]): string {
  if (m.method === "token") return "Token";
  return list.filter((x) => x.method === "password").length > 1 ? m.label : "Password";
}

/**
 * What the screen says about the methods, if anything: why they are a guess, or that the method this connection used
 * isn't offered any more.
 */
export function methodsNote(methods: Methods | undefined, d: SignInDetails, used: SignInDetails["method"]): string | undefined {
  if (!methods) return undefined;
  // With the password, a guess is what the screen always showed: only a token sign-in needs to know it is one.
  if (methods.note === "unread" && used === "token") return "Hermes Chat couldn't read which sign-in methods this server offers, so it shows the usual ones.";
  if (methods.note === "gate-off")
    return "This dashboard has its sign-in turned off, as it does when it listens only on its own computer. Hermes Chat can't sign in to it that way: start it with a dashboard username and password, or a session token.";
  if (methods.note === "none-supported") return "This server lists no sign-in method Hermes Chat supports. It may need a dashboard username and password, or a session token.";
  if (used === "token" && !methods.methods.some((m) => m.method === "token"))
    return "This server doesn't take a token any more: its sign-in no longer lists the session-token provider. Sign in another way.";
  if (used !== "token" && d.provider && !methods.methods.some((m) => m.method === "password" && m.provider === d.provider))
    return "The password sign-in this connection used isn't offered by this server any more. Pick one it offers.";
  return undefined;
}
