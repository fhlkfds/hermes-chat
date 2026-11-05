// The chat list's sections, in the order shown (ADR 0062). Their own module, so the display preferences (uiPrefs.ts)
// and the sorting that fills them (snooze.ts) can both name them.

export const SECTION_KEYS = ["inbox", "working", "snoozed", "unsettled", "settled", "archived"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABEL: Readonly<Record<SectionKey, string>> = {
  inbox: "Inbox",
  working: "Working",
  snoozed: "Snoozed",
  unsettled: "Unsettled",
  settled: "Settled",
  archived: "Archived",
};

export const isSectionKey = (v: unknown): v is SectionKey => typeof v === "string" && (SECTION_KEYS as readonly string[]).includes(v);
