/** Letters of the short address forms (computer:<machine>/<letter><n><tag>). */
const LETTERS = { window: "w", observation: "o", sequence: "s", "window-state": "t", app: "a", sandbox: "b" } as const;

/** A pattern that finds a computer address of one kind in presented text, in its long or short form. */
export function addressPattern(kind: keyof typeof LETTERS, flags = ""): RegExp {
  return new RegExp(`computer:(?:${kind}/[a-zA-Z0-9-]+|[a-z0-9_-]+/${LETTERS[kind]}[0-9]+[a-z]{2})`, flags);
}
