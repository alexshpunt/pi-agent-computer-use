import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connect, type Socket } from "node:net";

export interface RelayCredentials { session: string; key: string }
export interface RelayContext { channel: "driver" | "identity"; role: "client" | "session" }
export const RELAY_AUTH_TIMEOUT_MS = 3000;
const HEX = /^[a-f0-9]{64}$/;
const MAX_FRAME = 512;

export function validateRelayCredentials(auth: RelayCredentials): void {
  if (!auth || !/^[a-zA-Z0-9_-]{1,80}$/.test(auth.session) || !HEX.test(auth.key)) throw new Error("Invalid relay credentials.");
}

function proof(auth: RelayCredentials, context: RelayContext, side: "client" | "server", serverNonce: string, clientNonce: string): string {
  return createHmac("sha256", Buffer.from(auth.key, "hex"))
    .update(JSON.stringify(["pi-relay", 1, side, auth.session, context.channel, context.role, serverNonce, clientNonce])).digest("hex");
}
function matches(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && HEX.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
function sendFrame(socket: Socket, frame: Record<string, unknown>): void { socket.write(JSON.stringify(frame) + "\n"); }

/** Read only a bounded authentication frame, leaving coalesced application bytes paused for its next owner. */
function readFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const cleanup = () => { socket.off("readable", read); socket.off("error", fail); socket.off("end", ended); socket.off("close", ended); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const ended = () => fail(new Error("Relay closed during authentication."));
    const read = () => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null) !== null) {
        bytes = Buffer.concat([bytes, chunk]);
        const end = bytes.indexOf(10);
        if (end > MAX_FRAME || end < 0 && bytes.length > MAX_FRAME) { fail(new Error("Relay authentication frame is too large.")); return; }
        if (end < 0) continue;
        cleanup();
        if (end + 1 < bytes.length) socket.unshift(bytes.subarray(end + 1));
        try {
          const parsed: unknown = JSON.parse(bytes.subarray(0, end).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid relay frame.");
          resolve(parsed as Record<string, unknown>);
        } catch { reject(new Error("Invalid relay authentication frame.")); }
        return;
      }
      if (socket.destroyed || socket.readableEnded) ended();
    };
    socket.on("readable", read); socket.once("error", fail); socket.once("end", ended); socket.once("close", ended);
    read();
  });
}

/** Deadline covers connection establishment and all proof frames, never the authenticated channel's lifetime. */
async function bounded<T>(socket: Socket, task: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => socket.destroy();
  try {
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { socket.destroy(); reject(new Error("Relay authentication timed out.")); }, timeoutMs);
    });
    return await Promise.race([task(), deadline]);
  } catch (error) { socket.destroy(); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** Server authenticates the expected port's role and channel; a captured proof cannot answer a fresh challenge. */
export async function acceptRelaySocket(socket: Socket, auth: RelayCredentials, context: RelayContext, timeoutMs = RELAY_AUTH_TIMEOUT_MS): Promise<void> {
  validateRelayCredentials(auth);
  await bounded(socket, async () => {
    const nonce = randomBytes(32).toString("hex");
    sendFrame(socket, { version: 1, nonce });
    const peer = await readFrame(socket);
    if (peer.version !== 1 || peer.session !== auth.session || peer.channel !== context.channel || peer.role !== context.role
      || typeof peer.nonce !== "string" || !HEX.test(peer.nonce)
      || !matches(peer.proof, proof(auth, context, "client", nonce, peer.nonce))) throw new Error("Relay peer authentication failed.");
    sendFrame(socket, { proof: proof(auth, context, "server", nonce, peer.nonce) });
  }, timeoutMs);
}

/** Never give the application a socket before the remote relay proves knowledge of this role's session key. */
export async function connectRelay(port: number, auth: RelayCredentials, context: RelayContext, host = "127.0.0.1", signal?: AbortSignal): Promise<Socket> {
  validateRelayCredentials(auth);
  const socket = connect({ host, port });
  // Consumers add their own error handling after authentication. Retain a listener across that handover.
  socket.on("error", () => {});
  return bounded(socket, async () => {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { socket.off("connect", connected); socket.off("error", failed); socket.off("close", closed); };
      const connected = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error("Relay connection closed."));
      socket.once("connect", connected); socket.once("error", failed); socket.once("close", closed);
    });
    const challenge = await readFrame(socket);
    if (challenge.version !== 1 || typeof challenge.nonce !== "string" || !HEX.test(challenge.nonce)) throw new Error("Invalid relay challenge.");
    const nonce = randomBytes(32).toString("hex");
    sendFrame(socket, { version: 1, session: auth.session, ...context, nonce, proof: proof(auth, context, "client", challenge.nonce, nonce) });
    const response = await readFrame(socket);
    if (!matches(response.proof, proof(auth, context, "server", challenge.nonce, nonce))) throw new Error("Relay server authentication failed.");
    return socket;
  }, RELAY_AUTH_TIMEOUT_MS, signal);
}
