/** One line of an account's public key book, as the identity service serves it. */
export interface KeyBookEntry {
  day: string;
  thumb: string;
  how: "first" | "added" | "reset" | "kept" | "retired";
}

export const keyBookId = (e: KeyBookEntry): string => `${e.day}:${e.thumb}:${e.how}`;

/** The day of a key none of your devices made, among entries this device hasn't seen. Null on the first look. */
export function foreignKeyDay(book: readonly KeyBookEntry[], mine: string, seen: ReadonlySet<string> | null): string | null {
  if (!seen) return null;
  const fresh = book.find((e) => !seen.has(keyBookId(e)) && e.thumb !== mine && (e.how === "first" || e.how === "added" || e.how === "reset"));
  return fresh?.day ?? null;
}
