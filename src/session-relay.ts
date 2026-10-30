import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { acceptRelaySocket, validateRelayCredentials, type RelayContext } from "./relay-auth.ts";

export interface SessionRelayKeys { session: string; clientKey: string; sessionKey: string }
export interface SessionRelay {
  /** driver client/session, then identity client/session. All are host loopback ports. */
  ports: [number, number, number, number];
  close(): Promise<void>;
}

/** One isolated session's reverse relay. Only authenticated peers enter independent bounded channel queues. */
export async function createSessionRelay(keys: SessionRelayKeys,
  options: { authenticationTimeoutMs?: number; maxPending?: number } = {}): Promise<SessionRelay> {
  validateRelayCredentials({ session: keys.session, key: keys.clientKey });
  validateRelayCredentials({ session: keys.session, key: keys.sessionKey });
  const limit = options.maxPending ?? 32;
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  })();
  const ports: number[] = [];
  try {
    for (const channel of ["driver", "identity"] as const) {
      const queues = { client: [] as Socket[], session: [] as Socket[] };
      const detectEnd = (socket: Socket) => socket.read(0);
      const pair = () => {
        for (const queue of Object.values(queues)) while (queue[0]?.destroyed) queue.shift();
        while (queues.client.length && queues.session.length) {
          const client = queues.client.shift()!, session = queues.session.shift()!;
          client.removeAllListeners("readable"); session.removeAllListeners("readable");
          const destroy = () => { client.destroy(); session.destroy(); };
          client.once("close", destroy); session.once("close", destroy);
          client.once("error", destroy); session.once("error", destroy);
          client.pipe(session); session.pipe(client);
        }
      };
      for (const role of ["client", "session"] as const) {
        const context: RelayContext = { channel, role };
        let authenticating = 0;
        const server = createServer({ pauseOnConnect: true }, socket => {
          socket.on("error", () => {});
          if (closed || authenticating >= limit) { socket.destroy(); return; }
          sockets.add(socket);
          const queue = queues[role];
          socket.once("close", () => {
            sockets.delete(socket);
            const index = queue.indexOf(socket); if (index >= 0) queue.splice(index, 1);
          });
          authenticating++;
          void acceptRelaySocket(socket, { session: keys.session, key: role === "client" ? keys.clientKey : keys.sessionKey }, context, options.authenticationTimeoutMs)
            .then(() => {
              if (closed || socket.destroyed || queue.length >= limit) { socket.destroy(); return; }
              socket.on("readable", () => detectEnd(socket));
              socket.once("end", () => socket.destroy());
              queue.push(socket);
              pair();
            }, () => socket.destroy())
            .finally(() => { authenticating--; });
        });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
        });
        ports.push((server.address() as AddressInfo).port);
      }
    }
    return { ports: ports as SessionRelay["ports"], close };
  } catch (error) { await close(); throw error; }
}
