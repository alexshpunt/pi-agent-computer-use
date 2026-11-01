/**
 * The human's stop of agent input on their desktop: three Escape presses on the physical keyboard, seen by the
 * native driver. Until the human resumes it with /computer-mode, every driver of a human desktop in this Pi
 * session refuses calls. Sandboxes and isolated sessions are not human desktops and keep running.
 */
export class HumanStop {
  private reason?: string;
  private readonly stopListeners = new Set<(reason: string) => void>();
  private readonly resumeListeners = new Set<() => void>();

  get stopped(): boolean { return this.reason !== undefined; }

  /** The refusal every call gets while stopped. */
  message(): string {
    return "human_stop: the human pressed Escape three times and stopped computer use on their desktop. Nothing was sent. " +
      "Do not retry or work around it; tell the human and wait until they turn it on again with /computer-mode.";
  }

  /** The first report wins; later ones while stopped change nothing. */
  stop(reason = "Escape pressed three times"): void {
    if (this.reason !== undefined) return;
    this.reason = reason;
    for (const listener of this.stopListeners) listener(reason);
  }

  resume(): void {
    if (this.reason === undefined) return;
    this.reason = undefined;
    for (const listener of this.resumeListeners) listener();
  }

  onStop(listener: (reason: string) => void): () => void { this.stopListeners.add(listener); return () => { this.stopListeners.delete(listener); }; }
  onResume(listener: () => void): () => void { this.resumeListeners.add(listener); return () => { this.resumeListeners.delete(listener); }; }
}

/** A native result that reports the stop: the driver refused, or stopped running input part way. */
export function reportsHumanStop(result: { structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] }): boolean {
  const state = result.structuredContent;
  return state?.code === "human_stop" || (state?.refusal as { code?: unknown } | undefined)?.code === "human_stop" ||
    result.content.some(block => block.type === "text" && typeof block.text === "string" && /\bhuman_stop:/.test(block.text));
}
