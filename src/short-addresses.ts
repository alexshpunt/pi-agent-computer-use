import { randomInt } from "node:crypto";

/** Address kinds that get a short form, by their one-letter prefix. Displays are a machine's listed displays. */
const LETTERS = { window: "w", observation: "o", sequence: "s", app: "a", sandbox: "b", display: "d" } as const;
export type ShortKind = keyof typeof LETTERS;
const KINDS = Object.fromEntries(Object.entries(LETTERS).map(([kind, letter]) => [letter, kind])) as Record<string, ShortKind>;
/** `<letter><number><run tag>`, for example w3qk. */
export const SHORT_REFERENCE = /^([wostabd])([1-9][0-9]{0,6})([a-z]{2})$/;
/** Long addresses this layer shortens in presented text: references, and a machine's listed displays. */
const LONG = /computer:(window|observation|sequence|app|sandbox)\/([A-Za-z0-9_-]{1,160})|computer:machine\/([a-z0-9][a-z0-9_-]{0,63})\/display\/(d-[A-Za-z0-9_-]{1,158})/g;

/**
 * Short, session-local aliases of long computer addresses: `computer:<machine>/<letter><n><tag>`, numbered per
 * machine and kind. The two-letter tag is drawn once per run, so an address kept from an earlier Pi run (in the
 * conversation or a summary) is refused instead of reaching whatever window got the same number this time.
 */
export class ShortAddresses {
  readonly tag = String.fromCharCode(97 + randomInt(26), 97 + randomInt(26));
  private readonly short = new Map<string, string>();
  private readonly long = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /** The short alias of a long address on a machine, issued on first use. */
  alias(source: string, machine: string, kind: ShortKind): string {
    let alias = this.short.get(source);
    if (!alias) {
      const key = `${machine}/${kind}`, n = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, n);
      alias = `computer:${machine}/${LETTERS[kind]}${n}${this.tag}`;
      this.short.set(source, alias); this.long.set(alias, source);
    }
    return alias;
  }
  /** The short alias already issued for a long address, if any. */
  issued(source: string): string | undefined { return this.short.get(source); }

  /** The long address of a short one, or a refusal that says why it does not resolve. */
  resolve(machine: string, reference: string): string {
    const match = SHORT_REFERENCE.exec(reference)!;
    if (match[3] !== this.tag)
      throw Error(`computer:${machine}/${reference} comes from an earlier Pi run or another session (this run's addresses end in "${this.tag}"). Search or Read again for a current address.`);
    const source = this.long.get(`computer:${machine}/${reference}`);
    if (!source) throw Error(`computer:${machine}/${reference} was never issued in this run. Search or Read again for a current address.`);
    return source;
  }

  /** Replace every long address in a text with its short alias; `machineOf` names the machine of a long address. */
  shorten(text: string, machineOf: (kind: Exclude<ShortKind, "display">, ref: string) => string | undefined): string {
    return text.replace(LONG, (whole, kind: Exclude<ShortKind, "display"> | undefined, ref: string | undefined, displayMachine: string | undefined) => {
      if (displayMachine) return this.alias(whole, displayMachine, "display");
      const machine = machineOf(kind!, ref!);
      return machine ? this.alias(whole, machine, kind!) : whole;
    });
  }
  /** The kind a short reference names. */
  static kind(reference: string): ShortKind { return KINDS[SHORT_REFERENCE.exec(reference)![1]]; }
}
