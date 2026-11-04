// Signing in and out of a saved connection (connections.ts, ADR 0049). Each connection's dashboard password is kept in
// the system keyring under its id, so the app signs in at launch without asking; the rest of the connection is kept in
// the connection list, so the sign-in screen after Sign out has everything but the password. Its extra request
// headers, whose values can be secrets, are kept in the keyring too, and stay after Sign out.
//
// A secret is only ever given back for the address it was saved for: a password with the mode, target and username
// it signed in with, headers with their URL. So a sign-in to an edited address whose secrets the keyring couldn't save
// never sends the old address's secrets to the new one.
import { type Address, type Connections, type SavedConnection, addressKey, addressOf, cleanName, detailsOf } from "./connections";
import type { ExtraHeader, SignInDetails } from "./tauriPipe";
import type { Hermes } from "./transport";

/** A connection's address and username, without its secrets. */
export type SavedSignIn = Address;

/** One saved secret: a dashboard password, or extra headers as JSON. `load` resolves to undefined when none is saved. */
export type Keyring = { load(): Promise<string | undefined>; save(value: string): Promise<void>; delete(): Promise<void> };

/** A connection's two keyring entries. */
export type Secrets = { password: Keyring; headers: Keyring };

/**
 * `connections`: the saved connections. `secrets`: a connection's keyring entries. `connect`: signs in to Hermes as `c`,
 * rejecting if that fails. `readSaved`: what this computer saved for `c`, to read while it can't connect
 * (transport's `readSaved`).
 */
export type Account = {
  connections: Connections;
  secrets: (c: SavedConnection) => Secrets;
  connect: (c: SavedConnection, d: SignInDetails) => Promise<Hermes>;
  readSaved: (c: SavedConnection, d: SignInDetails, reason: string) => Hermes | undefined;
};

/** What the Rust side says when the dashboard turns the password down (`TransportError::BadCredentials`). */
export const WRONG_PASSWORD = "Wrong username or password.";

/** What the keyring kept at sign-in. */
export type Kept = { password: boolean; headers: boolean };

/** The keyring's password entry, saved with the address it signs in to. */
const passwordEntry = (a: Address, password: string) => JSON.stringify({ v: 1, for: addressKey(a), password });

/**
 * The saved password, if it was saved for `c`'s address now. The migrated connection's entry is the plain password
 * kept before, which counts only while its address is the one it had then.
 */
function passwordFor(c: SavedConnection, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    v = undefined;
  }
  const entry = v as { v?: unknown; for?: unknown; password?: unknown } | null;
  if (entry && typeof entry === "object" && entry.v === 1 && typeof entry.for === "string" && typeof entry.password === "string")
    return entry.for === addressKey(c) ? entry.password : undefined;
  return c.legacy && c.legacy.address === addressKey(c) ? raw : undefined;
}

/**
 * Signs in to `c` with `d`, and once Hermes has answered, keeps `c` with `d`'s address (and `name`, if given) as the
 * connection in use, and saves the password and extra headers in its keyring entries. `c` may be a new connection
 * (`Connections.draft`), which is saved only now. A keyring that can't save doesn't stop the sign-in; `notSaved`
 * says what wasn't kept and why.
 */
export async function signIn(
  c: SavedConnection,
  d: SignInDetails,
  account: Account,
  name?: string,
): Promise<{ hermes: Hermes; connection: SavedConnection; notSaved?: string; kept: Kept }> {
  const hermes = await account.connect(c, d);
  const { password, headers = [] } = d;
  const connection: SavedConnection = { ...c, ...addressOf(d), name: name === undefined ? c.name : cleanName(name, d) };
  try {
    account.connections.save(connection);
  } catch (e) {
    await hermes.close().catch(() => {});
    throw e;
  }
  account.connections.use(connection.id);
  const secrets = account.secrets(connection);
  const notSaved: string[] = [];
  const kept = { password: true, headers: true };
  await secrets.password.save(passwordEntry(connection, password)).catch((e: Error) => {
    kept.password = false;
    notSaved.push(`Couldn't save the password in the system keyring: ${e.message}`);
  });
  // The headers are saved with the URL they were signed in to; `savedHeaders` gives them back for that URL only.
  const savingHeaders = headers.length ? secrets.headers.save(JSON.stringify({ url: d.url, headers })) : secrets.headers.delete();
  await savingHeaders.catch((e: Error) => {
    kept.headers = false;
    notSaved.push(`Couldn't save the extra request headers in the system keyring: ${e.message}`);
  });
  const signedIn = account.connections.get(connection.id) ?? connection;
  return notSaved.length ? { hermes, connection: signedIn, notSaved: notSaved.join(". "), kept } : { hermes, connection: signedIn, kept };
}

/**
 * `c`'s saved extra request headers, if they were saved for its URL now. None when nothing is saved, the keyring can't
 * be read, or they belong to another URL.
 */
async function savedHeaders(c: SavedConnection, account: Account): Promise<ExtraHeader[]> {
  try {
    const saved = JSON.parse((await account.secrets(c).headers.load()) ?? "null") as { url?: unknown; headers?: unknown } | null;
    if (saved?.url !== c.url || !Array.isArray(saved.headers)) return [];
    return saved.headers.filter((h): h is ExtraHeader => typeof h?.name === "string" && typeof h?.value === "string");
  } catch {
    return [];
  }
}

/**
 * `c` with its saved password, to sign in without asking. Undefined when no password is saved for its address, or
 * the keyring can't be read, so the owner is asked.
 */
export async function savedSignIn(c: SavedConnection, account: Account): Promise<SignInDetails | undefined> {
  const password = passwordFor(c, await account.secrets(c).password.load().catch(() => undefined));
  return password === undefined ? undefined : detailsOf(c, password, await savedHeaders(c, account));
}

/** The sign-in screen's details for `c` when it asks: everything saved but the password. */
export async function signInForm(c: SavedConnection, account: Account): Promise<SignInDetails> {
  return detailsOf(c, "", await savedHeaders(c, account));
}

/**
 * Signs in to `c` with its saved sign-in. If that fails for any reason but a wrong password, the chat list and Saved
 * copies this computer kept for `c` open anyway, Offline, and the app keeps trying to connect. Rejects when the
 * password is wrong or nothing is saved to read, so the owner is asked.
 */
export async function launchSignIn(c: SavedConnection, d: SignInDetails, account: Account): Promise<Hermes> {
  try {
    return await account.connect(c, d);
  } catch (e) {
    const reason = (e as Error).message;
    const offline = reason === WRONG_PASSWORD ? undefined : account.readSaved(c, d, reason);
    if (!offline) throw e;
    return offline;
  }
}

/**
 * Signs out of `c` (`signOut`), then reads what the sign-in screen starts from. Both finish before it resolves, so the
 * screen never shows with the details it had before. Never rejects; `error` says what Sign out couldn't do.
 */
export async function signOutToSignIn(hermes: Hermes, c: SavedConnection, account: Account): Promise<{ initial: SignInDetails; error?: string }> {
  let error: string | undefined;
  try {
    await signOut(hermes, c, account);
  } catch (e) {
    error = (e as Error).message;
  }
  return { initial: await signInForm(c, account), error };
}

/**
 * Deletes `c`'s saved password, then closes the connection, so a close that fails can't leave the password behind.
 * Rejects, signed out, if the keyring can't delete it.
 */
export async function signOut(hermes: Hermes, c: SavedConnection, account: Account): Promise<void> {
  try {
    await account.secrets(c).password.delete();
  } catch (e) {
    throw new Error(`Signed out, but couldn't delete the saved password from the system keyring: ${(e as Error).message}`);
  } finally {
    await hermes.close().catch(() => {});
  }
}

/**
 * Removes a saved connection from this computer: its password and extra headers from the keyring, then (after
 * `close`, which signs out of it when it is in use) everything kept locally for it (`forgetLocal`), then the
 * connection itself. Nothing is sent to Hermes, so its chats stay on the server. If the keyring can't delete a
 * secret, nothing else is done and the connection stays in use, so its entries aren't left behind unnamed; this
 * rejects with why, and the owner can try again.
 */
export async function removeConnection(
  c: SavedConnection,
  account: Account,
  forgetLocal: (c: SavedConnection) => Promise<void>,
  close?: () => Promise<void>,
): Promise<void> {
  const secrets = account.secrets(c);
  const failed: string[] = [];
  await secrets.password.delete().catch((e: Error) => failed.push(`the password (${e.message})`));
  await secrets.headers.delete().catch((e: Error) => failed.push(`the extra request headers (${e.message})`));
  if (failed.length) throw new Error(`The connection is still saved: the system keyring couldn't delete ${failed.join(" or ")}. Try again.`);
  // Signed out before its data goes, so nothing the connection still writes lands after the deleting.
  await close?.();
  await forgetLocal(c);
  account.connections.remove(c.id);
}
