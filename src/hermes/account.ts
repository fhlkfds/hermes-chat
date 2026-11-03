// Signing in and out. The dashboard password is kept in the system keyring, so the app signs in at launch without
// asking; the rest of the sign-in is kept beside it, so the sign-in screen after Sign out has everything but the
// password. The extra request headers, whose values can be secrets, are kept in the keyring too, and stay after Sign
// out, so the sign-in screen still has them.
import type { ExtraHeader, SignInDetails } from "./tauriPipe";
import type { Hermes } from "./transport";

export type SavedSignIn = Omit<SignInDetails, "password" | "headers">;

/** One saved secret: the dashboard password, or the extra headers as JSON. `load` resolves to undefined when none is saved. */
export type Keyring = { load(): Promise<string | undefined>; save(password: string): Promise<void>; delete(): Promise<void> };

/**
 * `store`: the saved sign-in without the password. `connect`: signs in to Hermes, rejecting if that fails.
 * `readSaved`: what this computer saved, to read while `d` can't connect (transport's `readSaved`).
 */
export type Account = {
  keyring: Keyring;
  headerKeyring: Keyring;
  store: { load(): SavedSignIn; save(d: SavedSignIn): void };
  connect: (d: SignInDetails) => Promise<Hermes>;
  readSaved: (d: SignInDetails, reason: string) => Hermes | undefined;
};

/** What the Rust side says when the dashboard turns the password down (`TransportError::BadCredentials`). */
const WRONG_PASSWORD = "Wrong username or password.";

/** What the keyring kept at sign-in. */
export type Kept = { password: boolean; headers: boolean };

/**
 * Signs in, and once Hermes has answered, saves the password and extra headers in the keyring and the rest of the
 * sign-in beside it. A keyring that can't save doesn't stop the sign-in; `notSaved` says what wasn't kept and why.
 */
export async function signIn(d: SignInDetails, account: Account): Promise<{ hermes: Hermes; notSaved?: string; kept: Kept }> {
  const hermes = await account.connect(d);
  const { password, headers = [], ...saved } = d;
  account.store.save(saved);
  const notSaved: string[] = [];
  const kept = { password: true, headers: true };
  await account.keyring.save(password).catch((e: Error) => {
    kept.password = false;
    notSaved.push(`Couldn't save the password in the system keyring: ${e.message}`);
  });
  // The headers are saved with the URL they were signed in to; `savedHeaders` gives them back for that URL only.
  const savingHeaders = headers.length ? account.headerKeyring.save(JSON.stringify({ url: d.url, headers })) : account.headerKeyring.delete();
  await savingHeaders.catch((e: Error) => {
    kept.headers = false;
    notSaved.push(`Couldn't save the extra request headers in the system keyring: ${e.message}`);
  });
  return notSaved.length ? { hermes, notSaved: notSaved.join(". "), kept } : { hermes, kept };
}

/**
 * The saved extra request headers, if they were saved for the URL saved beside the sign-in. None when nothing is
 * saved, the keyring can't be read, or they belong to another URL: a sign-in to a new URL whose headers the keyring
 * couldn't save leaves the old ones behind, and they must never go to the new one.
 */
async function savedHeaders(account: Account): Promise<ExtraHeader[]> {
  try {
    const saved = JSON.parse((await account.headerKeyring.load()) ?? "null") as { url?: unknown; headers?: unknown } | null;
    if (saved?.url !== account.store.load().url || !Array.isArray(saved.headers)) return [];
    return saved.headers.filter((h): h is ExtraHeader => typeof h?.name === "string" && typeof h?.value === "string");
  } catch {
    return [];
  }
}

/**
 * At launch: the saved sign-in with its password, to sign in without asking. Undefined when no password is saved or
 * the keyring can't be read, so the owner is asked.
 */
export async function savedSignIn(account: Account): Promise<SignInDetails | undefined> {
  const password = await account.keyring.load().catch(() => undefined);
  return password === undefined ? undefined : { ...account.store.load(), password, headers: await savedHeaders(account) };
}

/** The sign-in screen's details when it asks: everything saved but the password. */
export async function signInForm(account: Account): Promise<SignInDetails> {
  return { ...account.store.load(), password: "", headers: await savedHeaders(account) };
}

/**
 * Signs in at launch with the saved sign-in. If that fails for any reason but a wrong password, the chat list and
 * Saved copies this computer kept open anyway, Offline, and the app keeps trying to connect. Rejects when the password
 * is wrong or nothing is saved to read, so the owner is asked.
 */
export async function launchSignIn(d: SignInDetails, account: Account): Promise<Hermes> {
  try {
    return await account.connect(d);
  } catch (e) {
    const reason = (e as Error).message;
    const offline = reason === WRONG_PASSWORD ? undefined : account.readSaved(d, reason);
    if (!offline) throw e;
    return offline;
  }
}

/**
 * Signs out (`signOut`), then reads what the sign-in screen starts from. Both finish before it resolves, so the screen
 * never shows with the details it had before. Never rejects; `error` says what Sign out couldn't do.
 */
export async function signOutToSignIn(hermes: Hermes, account: Account): Promise<{ initial: SignInDetails; error?: string }> {
  let error: string | undefined;
  try {
    await signOut(hermes, account);
  } catch (e) {
    error = (e as Error).message;
  }
  return { initial: await signInForm(account), error };
}

/**
 * Deletes the saved password, then closes the connection, so a close that fails can't leave the password behind.
 * Rejects, signed out, if the keyring can't delete it.
 */
export async function signOut(hermes: Hermes, account: Account): Promise<void> {
  try {
    await account.keyring.delete();
  } catch (e) {
    throw new Error(`Signed out, but couldn't delete the saved password from the system keyring: ${(e as Error).message}`);
  } finally {
    await hermes.close().catch(() => {});
  }
}
