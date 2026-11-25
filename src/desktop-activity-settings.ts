export const desktopActivitySettings = [
  ["activity_panel", "Desktop activity panel", "Show which agents are working and whether anyone is using shared input."],
  ["activity_outlines", "Agent window outlines", "Mark the window each agent is working in."],
  ["activity_cursors", "Labelled agent cursors", "Show who is acting at each known pointer position."],
] as const;

export type DesktopActivitySetting = typeof desktopActivitySettings[number][0];
