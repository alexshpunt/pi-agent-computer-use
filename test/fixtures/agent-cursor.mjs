// The adapter sets the agent cursor glide when the driver starts. Fake peers keep that state without journaling it.
let glide = 0;

/** Answers the agent cursor tools, or returns undefined for any other tool. */
export function agentCursor(name, args = {}) {
  if (name === "set_agent_cursor_motion") glide = args.glide_duration_ms;
  else if (name !== "get_agent_cursor_state") return undefined;
  return { content: [], structuredContent: { motion: { glide_duration_ms: glide } } };
}
