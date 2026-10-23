import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Answers every computer plugin registration the way an IDE with another plugin API version does. */
export default function incompatibleIde(pi: ExtensionAPI): void {
  for (const protocol of ["pi-agent-read", "pi-agent-search", "pi-agent-text-editor"])
    pi.events.on(`${protocol}/plugin/register`, request => {
      const { plugin, accept } = request as { plugin: { id: string }; accept: (registration: Promise<void>) => void };
      accept(Promise.reject(new Error(`Plugin ${plugin.id} uses an unsupported API version`)));
    });
}
