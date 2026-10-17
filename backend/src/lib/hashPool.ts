import { Worker } from 'node:worker_threads';

/**
 * Dedicated threads for password hashing.
 *
 * Hashing is deliberately slow, and Node's built-in async crypto runs on
 * libuv's shared worker pool: four threads that also carry every new database
 * connection (its password handshake and DNS lookup). A rush of sign-ins on
 * that pool leaves the database unable to open connections, and trading stalls
 * for people who are already signed in. Threads owned by this module keep the
 * two apart no matter how the process was started.
 *
 * Threads are created on demand, one job each at a time, and retire after
 * being idle, so a quiet server (or the desktop app) carries none.
 */

const IDLE_MS = 30_000;

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { scryptSync } = require('node:crypto');
parentPort.on('message', ({ password, salt, N, r, p, keyLength }) => {
  try {
    const key = scryptSync(password, Buffer.from(salt), keyLength, { N, r, p, maxmem: 256 * 1024 * 1024 });
    parentPort.postMessage({ key });
  } catch (err) {
    parentPort.postMessage({ error: String((err && err.message) || err) });
  }
});
`;

export interface ScryptJob {
  password: string;
  salt: Uint8Array;
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

interface Thread {
  worker: Worker;
  busy: boolean;
  idleTimer: NodeJS.Timeout | undefined;
}

const threads = new Set<Thread>();

function retire(thread: Thread): void {
  clearTimeout(thread.idleTimer);
  threads.delete(thread);
  void thread.worker.terminate();
}

function acquire(): Thread {
  for (const thread of threads) {
    if (!thread.busy) {
      clearTimeout(thread.idleTimer);
      thread.busy = true;
      return thread;
    }
  }
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  worker.unref(); // never the reason the process stays alive
  const thread: Thread = { worker, busy: true, idleTimer: undefined };
  threads.add(thread);
  return thread;
}

/**
 * Derives a key on a hashing thread. The caller limits how many of these run
 * at once (see auth.service), which is also the most threads that will exist.
 */
export function scryptOnThread(job: ScryptJob): Promise<Buffer> {
  const thread = acquire();
  return new Promise<Buffer>((resolve, reject) => {
    const finish = (settle: () => void, healthy: boolean) => {
      thread.worker.off('message', onMessage);
      thread.worker.off('error', onError);
      thread.worker.off('exit', onExit);
      if (healthy) {
        thread.busy = false;
        thread.idleTimer = setTimeout(() => retire(thread), IDLE_MS);
        thread.idleTimer.unref();
      } else {
        retire(thread);
      }
      settle();
    };
    const onMessage = (message: { key?: Uint8Array; error?: string }) =>
      finish(() => (message.key ? resolve(Buffer.from(message.key)) : reject(new Error(message.error ?? 'hashing failed'))), true);
    const onError = (err: Error) => finish(() => reject(err), false);
    const onExit = () => finish(() => reject(new Error('hashing thread exited')), false);

    thread.worker.once('message', onMessage);
    thread.worker.once('error', onError);
    thread.worker.once('exit', onExit);
    thread.worker.postMessage(job);
  });
}
