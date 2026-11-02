// Drafts and outboxes whose last write to localStorage failed (the store is full, say). Their stores keep them in
// memory until the app closes; this keeps the latest value by key too, so a restart for an update still saves them
// (updates.ts `snapshotDrafts`). null: the key was being deleted.
export const unsaved = new Map<string, string | null>();

/** Writes `value` under `key` (null deletes it), and notes it here if the write fails or there's no storage. False: it failed. */
export function persist(storage: () => Pick<Storage, "setItem" | "removeItem">, key: string, value: string | null): boolean {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
    unsaved.delete(key);
    return true;
  } catch {
    unsaved.set(key, value);
    return false;
  }
}
