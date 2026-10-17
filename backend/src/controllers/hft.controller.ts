import fs from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { hft } from '../hft/index.js';

/**
 * GET /api/hft (owner): how HFT is doing. `status` is this server's side of it
 * (whether HFT is running, and what has been copied to it); `stats` is what
 * HFT measured about itself in its current session, or null while it is down.
 */
export const status: RequestHandler = async (_req, res) => {
  res.json({ status: hft.status(), stats: await hft.stats() });
};

const MAX_SESSIONS = 40;

/**
 * GET /api/hft/sessions (owner): the statistics HFT wrote at the end of each
 * session it ran, newest first. They are kept in its folder (the latest few)
 * and in history/ (older ones), a few kilobytes each.
 */
export const sessions: RequestHandler = async (_req, res) => {
  const dir = config.hft.dataDir;
  const found = new Map<string, string>();
  for (const folder of [path.join(dir, 'history'), dir]) {
    try {
      for (const name of await fs.readdir(folder)) if (/^hft-session-.*\.stats\.json$/.test(name)) found.set(name, path.join(folder, name));
    } catch {
      // no such folder yet
    }
  }
  const names = [...found.keys()].sort().reverse().slice(0, MAX_SESSIONS);
  const loaded = await Promise.all(
    names.map(async (name) => {
      try {
        const stats = JSON.parse(await fs.readFile(found.get(name)!, 'utf8')) as Record<string, unknown>;
        return { name: name.replace(/\.stats\.json$/, ''), stats };
      } catch {
        return null;
      }
    }),
  );
  res.json({ sessions: loaded.filter(Boolean) });
};
