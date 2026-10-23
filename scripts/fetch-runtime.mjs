// Put the pinned Windows runtime into native-runtime/ before packing; every file is hash-checked.
import { fetchRuntime, loadBundledRuntime, PACKAGED_RUNTIME, readRuntimePins } from "../src/native-runtime.ts";

const pins = await readRuntimePins();
await fetchRuntime(PACKAGED_RUNTIME, pins);
await loadBundledRuntime(PACKAGED_RUNTIME, pins);
console.log(`Runtime ${pins.version} (${pins.source.slice(0, 12)}) ready in ${PACKAGED_RUNTIME}`);
