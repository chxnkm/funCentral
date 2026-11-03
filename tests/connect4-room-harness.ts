// Local-only workerd/SQLite harness for Connect 4 room/bot integration tests.
import { Miniflare, Response } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export { Response };

export async function createConnect4RoomHarness() {
  const root = path.resolve(import.meta.dirname, '..');
  const state = await mkdtemp(path.join(tmpdir(), 'connect4-room-'));
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      sourcefile: 'connect4-room-worker.ts',
      contents: `
        import { Connect4Room } from './src/connect4/room';
        export class TestRoom extends Connect4Room {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/__state') {
              return Response.json({ state: await this.ctx.storage.get('state'), alarm: await this.ctx.storage.getAlarm() });
            }
            if (url.pathname === '/__alarm') {
              await this.alarm();
              return Response.json({ ok: true });
            }
            return super.fetch(request);
          }
        }
        export default { fetch() { return new Response('not used'); } };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:*'],
  });

  const mf = new Miniflare({
    modules: true,
    script: outputFiles[0].text,
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'TestRoom', useSQLite: true } },
    durableObjectsPersist: path.join(state, 'rooms'),
    d1Databases: ['DB'],
    d1Persist: path.join(state, 'db'),
    bindings: { TELEGRAM_BOT_TOKEN: 'local-test-token', ALLOW_DEV_LOGIN: '1' },
    outboundService: async () => Response.json({ ok: true, result: { status: 'member' } }),
  });
  await mf.ready;

  const room = async (name: string) => {
    const ns = await mf.getDurableObjectNamespace('ROOM');
    return ns.get(ns.idFromName(name));
  };

  return {
    room,
    async stop() {
      await mf.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}

export async function readRoom(room: Awaited<ReturnType<Awaited<ReturnType<typeof createConnect4RoomHarness>>['room']>>) {
  return (await room.fetch('https://room.test/__state')).json() as Promise<{ state: any; alarm: number | null }>;
}

export async function fireAlarm(room: Awaited<ReturnType<Awaited<ReturnType<typeof createConnect4RoomHarness>>['room']>>) {
  return (await room.fetch('https://room.test/__alarm')).json() as Promise<{ ok: boolean }>;
}

export async function connectSocket(
  room: Awaited<ReturnType<Awaited<ReturnType<typeof createConnect4RoomHarness>>['room']>>,
  playerId: string,
  name: string,
) {
  const response = await room.fetch(`https://room.test/?playerId=${playerId}&name=${encodeURIComponent(name)}`, { headers: { Upgrade: 'websocket' } });
  const socket = response.webSocket!;
  socket.accept();
  const frames: any[] = [];
  socket.addEventListener('message', (event) => { frames.push(JSON.parse(event.data as string)); });
  return { socket, frames, send: (msg: unknown) => socket.send(JSON.stringify(msg)) };
}
