// Local-only workerd/SQLite harness for Bridge hand completion. Test-only
// inspection and retry routes are bundled here, never into the production Worker.
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export { Response };

export async function createBridgeHarness({ skipMigrations = [] as string[] } = {}) {
  const root = path.resolve(import.meta.dirname, '..');
  const state = await mkdtemp(path.join(tmpdir(), 'bridge-persistence-'));
  const telegram: { chat_id: string; text: string }[] = [];
  const { outputFiles } = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root, sourcefile: 'bridge-persistence-worker.ts', contents: `
        import { GameRoom } from './src/game-room';
        export class TestRoom extends GameRoom {
          async fetch(request) {
            const url = new URL(request.url);
            const storage = this.ctx.storage;
            if (url.pathname === '/__state') {
              if (request.method === 'POST') {
                const body = await request.json();
                for (const [key, value] of Object.entries(body)) await storage.put(key, value);
              }
              return Response.json({
                state: await storage.get('state'),
                completions: (await storage.get('completions')) ?? [],
                snapshot: (await storage.get('ratingSnapshot')) ?? null,
                alarm: await storage.getAlarm(),
              });
            }
            if (url.pathname === '/__retry') {
              // Make every queued completion due, then run the room alarm.
              const pending = (await storage.get('completions')) ?? [];
              if (pending.length) await storage.put('completions', pending.map((c) => ({ ...c, nextAttemptAt: 0 })));
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
  let mf: Miniflare;
  const launch = async () => {
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: outputFiles[0].text,
      compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { ROOM: { className: 'TestRoom', useSQLite: true } },
      resourcePersistencePath: state,
      d1Databases: ['DB'],
      bindings: { TELEGRAM_BOT_TOKEN: 'local-test-token' },
      outboundService: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/sendMessage')) telegram.push(await request.json() as { chat_id: string; text: string });
        return Response.json({ ok: true, result: { status: 'member' } });
      },
    }));
    await mf.ready;
  };
  await launch();
  let db = await mf!.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql') && !skipMigrations.includes(f)).sort()) {
    const sql = (await readFile(path.join(root, 'migrations', file), 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO groups (group_id, group_name, created_at) VALUES ('-100', 'Test group', 0)").run();
  for (const [id, name] of [[101, 'Ann'], [102, 'Ben'], [103, 'Cat'], [104, 'Dan'], [105, 'Eve']] as const) {
    await db.prepare('INSERT INTO users (telegram_id, display_name, created_at) VALUES (?, ?, 0)').bind(id, name).run();
  }
  const room = async (name: string) => {
    const namespace = await mf!.getDurableObjectNamespace('ROOM');
    return namespace.get(namespace.idFromName(name));
  };
  return {
    get db() { return db; }, room, telegram,
    async restart() {
      await mf!.dispose();
      await launch();
      db = await mf!.getD1Database('DB');
    },
    async stop() {
      await mf!.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}

type Room = Awaited<ReturnType<Awaited<ReturnType<typeof createBridgeHarness>>['room']>>;

export async function readRoom(room: Room) {
  return (await room.fetch('https://room.test/__state')).json() as Promise<{ state: any; completions: any[]; snapshot: any; alarm: number | null }>;
}

export async function writeRoom(room: Room, keys: Record<string, unknown>) {
  await room.fetch('https://room.test/__state', { method: 'POST', body: JSON.stringify(keys) });
}

export async function connect(room: Room, playerId: string) {
  const response = await room.fetch(`https://room.test/?playerId=${playerId}`, { headers: { Upgrade: 'websocket' } });
  const ws = response.webSocket!;
  ws.accept();
  ws.addEventListener('message', () => {});
  return ws;
}

export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
