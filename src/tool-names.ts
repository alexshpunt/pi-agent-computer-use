/** Names of the tools that read, search and delete computer resources: the IDE's in IDE mode, computer use's own otherwise. */
export type ComputerToolNames = { readonly read: string; readonly search: string; readonly delete: string };
export const IDE_TOOL_NAMES: ComputerToolNames = { read: "read", search: "search", delete: "delete" };
export const STANDALONE_TOOL_NAMES: ComputerToolNames = { read: "computer_read", search: "computer_search", delete: "computer_delete" };

/**
 * Copy a tool schema with {read}, {search} and {delete} in its text replaced by the mode's tool names. Each property
 * keeps its descriptor: TypeBox marks its own keys (~kind, ~optional) non-enumerable, and they must stay out of JSON.
 */
export function fillToolNames<T>(schema: T, names: ComputerToolNames): T {
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/\{(read|search|delete)\}/g, (_, key: keyof ComputerToolNames) => names[key]);
    if (Array.isArray(value)) return value.map(fill);
    if (value === null || typeof value !== "object") return value;
    const copy = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
      Object.defineProperty(copy, key, "value" in descriptor ? { ...descriptor, value: fill(descriptor.value) } : descriptor);
    for (const key of Object.getOwnPropertySymbols(value))
      Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(value, key)!);
    return copy;
  };
  return fill(schema) as T;
}
