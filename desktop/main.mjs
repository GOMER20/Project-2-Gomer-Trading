// Gomer Trading desktop shell.
//
// The app is the whole platform in one bundle. On launch this process starts,
// from Contents/Resources:
//
//   postgres/      PostgreSQL server        data in ~/Library/Application Support/Gomer Trading
//   redis/         Redis server             in-memory only
//   server/        seed.mjs  (migrations + first-run accounts, runs once per launch)
//                  api.mjs   (REST + WebSocket + matching engine, also serves web/)
//                  worker.mjs (live P&L and leaderboard)
//   web/           the exported Next.js interface
//
// then opens a window on the API's own origin. Everything listens on 127.0.0.1
// only, unless the user turns on hosting, which opens the trading server (and
// nothing else) to their network so other people can join from a browser.
// Everything is stopped again when the app quits.

import { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, powerSaveBlocker, shell } from 'electron';
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = app.isPackaged ? process.resourcesPath : path.join(HERE, 'staging');
const POSTGRES_BIN = path.join(RESOURCES, 'postgres', 'bin');
const REDIS_SERVER = path.join(RESOURCES, 'redis', 'redis-server');
const SERVER_DIR = path.join(RESOURCES, 'server');
const WEB_DIR = path.join(RESOURCES, 'web');
const CLOUDFLARED = path.join(RESOURCES, 'tunnel', 'cloudflared');
const TAILSCALE = path.join(RESOURCES, 'tunnel', 'tailscale');
const TAILSCALED = path.join(RESOURCES, 'tunnel', 'tailscaled');

const APP_NAME = 'Gomer Trading';
app.setName(APP_NAME);
// Lets tests run against a throwaway profile instead of the real one.
if (process.env.GOMER_DATA_DIR) app.setPath('userData', path.resolve(process.env.GOMER_DATA_DIR));

const DATA_DIR = app.getPath('userData');
const PG_DATA = path.join(DATA_DIR, 'postgres');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RUN_FILE = path.join(DATA_DIR, 'run.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'gomer.log');

const DB_USER = 'gomer';
// Uncommon fixed ports keep the app's origin (and so its saved session) stable
// between launches. If one is taken, a free port is used for that launch.
const PREFERRED_PORTS = { api: 47831, postgres: 47832, redis: 47833, gateway: 47835 };
const TRADER_ACCOUNT = 'TRADER01';

/** @type {{ name: string, child: import('node:child_process').ChildProcess, stopSignal: NodeJS.Signals }[]} */
const processes = [];
let mainWindow = null;
let settingsWindow = null;
let origin = null;
let config = null;
let logStream = null;
let quitting = false;
let apiPort = 0;
/** True once every service is up; before that, startup reports its own errors. */
let platformReady = false;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function openLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // no log yet
  }
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

function log(source, message) {
  const stamp = new Date().toISOString();
  for (const line of String(message).split('\n')) {
    if (line.trim()) logStream?.write(`${stamp} [${source}] ${line}\n`);
  }
}

// ---------------------------------------------------------------------------
// Configuration: generated once, kept in the user's profile
// ---------------------------------------------------------------------------

function loadConfig() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // first launch, or the file was removed
  }
  const secret = (bytes) => crypto.randomBytes(bytes).toString('base64url');
  const merged = {
    jwtSecret: secret(48),
    databasePassword: secret(24),
    adminId: 'ADMIN',
    adminPassword: secret(12),
    traderPassword: secret(12),
    // Lets this app, and only this app, open its built-in accounts without their passwords.
    desktopKey: secret(32),
    // Let other people on the same network join from their browsers. Changed from the app's menu.
    hostOnNetwork: false,
    // Give people anywhere a secure https link to this Mac. Changed from the app's menu.
    shareOnInternet: false,
    // Share at a permanent address (through Tailscale) instead of a temporary link.
    fixedAddress: false,
    // Optional: add Alpaca keys here for live quotes, then restart the app.
    alpacaApiKey: '',
    alpacaApiSecret: '',
    alpacaFeed: 'iex',
    // The built-in practice market: 'exchange' trades only during US market hours, 'always' never closes.
    practiceHours: 'exchange',
    // Where AT, the trading algorithm, keeps its own folder (its reports are shown in the AT window). Empty: not on this Mac.
    atHome: '',
    ...saved,
  };

  // The database password is fixed when the cluster is created. Without the
  // config that matches it the old cluster cannot be opened, so set it aside
  // rather than fail on every launch.
  if (!saved && fs.existsSync(PG_DATA)) {
    const aside = `${PG_DATA}.orphaned-${Date.now()}`;
    fs.renameSync(PG_DATA, aside);
    log('app', `config.json was missing; moved the existing database to ${aside}`);
  }
  if (JSON.stringify(merged) !== JSON.stringify(saved)) {
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  }
  return merged;
}

function saveConfig(next) {
  config = next;
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Resolves with `preferred` if it is free on the loopback interface, otherwise with any free port. */
function choosePort(preferred) {
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      const probe = net.createServer();
      probe.once('error', (err) => (port === 0 ? reject(err) : attempt(0)));
      probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        const chosen = probe.address().port;
        probe.close(() => resolve(chosen));
      });
    };
    attempt(preferred);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRunning = (child) => child.exitCode === null && child.signalCode === null;

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(400);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });
}

/** Waits until `check` passes, failing fast if the process it depends on has died. */
async function waitUntil(what, check, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && !isRunning(child)) throw new Error(`${what} stopped unexpectedly (exit code ${child.exitCode}). See the log for details.`);
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`${what} did not become ready in time.`);
}

function saveRunFile() {
  const pids = processes.filter((p) => isRunning(p.child)).map((p) => ({ name: p.name, pid: p.child.pid }));
  if (tunnel.child?.pid) pids.push({ name: 'tunnel', pid: tunnel.child.pid });
  if (tunnel.daemon?.pid) pids.push({ name: 'tailscaled', pid: tunnel.daemon.pid });
  fs.writeFileSync(RUN_FILE, JSON.stringify(pids));
}

/** A service that keeps dying is not restarted forever: this many times a minute, then the app says so. */
const MAX_RESTARTS_PER_MINUTE = 5;
const restartTimes = new Map();

function mayRestart(name) {
  const recent = (restartTimes.get(name) ?? []).filter((at) => Date.now() - at < 60_000);
  if (recent.length >= MAX_RESTARTS_PER_MINUTE) return false;
  restartTimes.set(name, [...recent, Date.now()]);
  return true;
}

/**
 * Starts a long-running child and records it so it is always stopped with the app.
 * With `restart`, a child that dies unexpectedly is started again: the trading
 * server and the worker keep nothing in memory that Postgres cannot rebuild, so
 * a fresh process simply carries on and the window reconnects by itself.
 */
function launch(name, command, args, options = {}, stopSignal = 'SIGTERM', restart = null) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const entry = { name, child, stopSignal };
  child.stdout.on('data', (chunk) => log(name, chunk));
  child.stderr.on('data', (chunk) => log(name, chunk));
  child.on('error', (err) => log(name, `failed to start: ${err.message}`));
  child.on('exit', (code, signal) => {
    log(name, `exited (code ${code}, signal ${signal})`);
    const index = processes.indexOf(entry);
    if (index !== -1) processes.splice(index, 1);
    if (!platformReady || quitting) return;

    if (restart && mayRestart(name)) {
      log('app', `${name} stopped unexpectedly; restarting it`);
      setTimeout(() => {
        if (!quitting) restart();
      }, 1000);
      return;
    }
    // The database or cache dying, or a service that will not stay up, leaves the app unusable: say so and stop.
    dialog.showErrorBox(`${APP_NAME} has stopped`, `The ${name} service stopped unexpectedly.\n\nDetails are in:\n${LOG_FILE}`);
    app.quit();
  });
  processes.push(entry);
  saveRunFile();
  return child;
}

/** Runs a short command to completion, capturing its output in the log. */
function runToCompletion(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let tail = '';
    const capture = (chunk) => {
      log(name, chunk);
      tail = (tail + chunk).slice(-600);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed (exit code ${code}).\n${tail.trim()}`))));
  });
}

/** The app's own executable doubles as Node.js for the bundled server scripts. */
function node(name, script, env, { once = false, args: extra = [] } = {}) {
  const args = [path.join(SERVER_DIR, script), ...extra];
  const options = { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  if (once) return runToCompletion(name, process.execPath, args, options);
  return launch(name, process.execPath, args, options, 'SIGTERM', () => node(name, script, env));
}

/** Stops anything a previous run left behind (a crash or force-quit skips the normal shutdown). */
async function stopLeftovers() {
  let previous = [];
  try {
    previous = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  } catch {
    return;
  }
  for (const { name, pid } of previous) {
    try {
      // Only signal a pid that is still one of ours; pids get reused.
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      const ours = command.includes(RESOURCES) || command.includes(DATA_DIR) || (name === 'redis' && command.includes('redis-server'));
      if (!ours) continue;
      process.kill(pid, name === 'postgres' ? 'SIGINT' : 'SIGTERM');
      log('app', `stopped leftover ${name} process ${pid}`);
    } catch {
      // not running
    }
  }
  fs.rmSync(RUN_FILE, { force: true });
  await sleep(1500);
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function startPostgres(port) {
  if (!fs.existsSync(path.join(PG_DATA, 'PG_VERSION'))) {
    log('app', 'creating the database cluster');
    fs.rmSync(PG_DATA, { recursive: true, force: true }); // clear a half-finished attempt
    const passwordFile = path.join(DATA_DIR, `.pw-${crypto.randomBytes(6).toString('hex')}`);
    fs.writeFileSync(passwordFile, `${config.databasePassword}\n`, { mode: 0o600 });
    try {
      await runToCompletion('initdb', path.join(POSTGRES_BIN, 'initdb'), [
        '-D', PG_DATA,
        '-U', DB_USER,
        '--pwfile', passwordFile,
        '--auth=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
      ]);
    } finally {
      fs.rmSync(passwordFile, { force: true });
    }
  }

  const child = launch(
    'postgres',
    path.join(POSTGRES_BIN, 'postgres'),
    // TCP on loopback only; no Unix socket file is created.
    ['-D', PG_DATA, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories='],
    {},
    'SIGINT', // "fast" shutdown: disconnect clients, flush, exit
  );
  await waitUntil('The database', () => canConnect(port), child);
}

async function startRedis(port, password) {
  // The configuration is passed on stdin so the password never appears in the process list.
  const child = launch('redis', REDIS_SERVER, ['-']);
  child.stdin.end(
    [`port ${port}`, 'bind 127.0.0.1', `requirepass ${password}`, 'save ""', 'appendonly no', 'daemonize no', ''].join('\n'),
  );
  await waitUntil('The cache', () => canConnect(port), child);
}

async function startPlatform() {
  await stopLeftovers();
  config = loadConfig();

  const ports = {
    api: await choosePort(PREFERRED_PORTS.api),
    postgres: await choosePort(PREFERRED_PORTS.postgres),
    redis: await choosePort(PREFERRED_PORTS.redis),
    gateway: await choosePort(PREFERRED_PORTS.gateway),
  };
  log('app', `ports: ${JSON.stringify(ports)}`);
  origin = `http://127.0.0.1:${ports.api}`;

  const redisPassword = crypto.randomBytes(24).toString('base64url');
  await Promise.all([startPostgres(ports.postgres), startRedis(ports.redis, redisPassword)]);

  const { PORT: _ignored, ...inherited } = process.env;
  const env = {
    ...inherited,
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    // Hosting opens the trading server to the network. Postgres and Redis always stay on loopback.
    API_HOST: config.hostOnNetwork ? '0.0.0.0' : '127.0.0.1',
    // Visitors who arrive through the sharing tunnel connect from this Mac itself. Trusting
    // forwarding headers from loopback only (never from a network peer, who could forge them)
    // lets the rate limits see each visitor's real address.
    TRUST_PROXY: 'loopback',
    API_PORT: String(ports.api),
    CORS_ORIGIN: origin,
    STATIC_DIR: WEB_DIR,
    MIGRATIONS_DIR: path.join(SERVER_DIR, 'migrations'),
    DATABASE_URL: `postgresql://${DB_USER}:${config.databasePassword}@127.0.0.1:${ports.postgres}/postgres`,
    REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${ports.redis}`,
    JWT_SECRET: config.jwtSecret,
    MARKET_DATA_PROVIDER: 'auto',
    ALPACA_API_KEY: config.alpacaApiKey ?? '',
    ALPACA_API_SECRET: config.alpacaApiSecret ?? '',
    ALPACA_FEED: config.alpacaFeed || 'iex',
    // The self-test drives the interface at any hour, so it gets a market that is moving (except when
    // the practice market's hours are the thing being tested).
    AT_HOME: config.atHome || '',
    PRACTICE_MARKET_HOURS:
      (process.env.GOMER_SELFTEST_DIR && process.env.GOMER_SELFTEST_MODE !== 'practice-hours') || config.practiceHours === 'always' ? 'always' : 'exchange',
    SEED_ADMIN_ID: config.adminId,
    SEED_ADMIN_PASSWORD: config.adminPassword,
    SEED_TRADER_PASSWORD: config.traderPassword,
    SEED_DEMO_DATA: 'true',
    // The bot gateway's low-latency listeners, for trading programs running on this Mac. Programs
    // elsewhere use the WebSocket and REST gateways, which travel with the app's own address.
    GATEWAY_TCP_PORT: String(ports.gateway),
    GATEWAY_TCP_HOST: '127.0.0.1',
    GATEWAY_UNIX_SOCKET: GATEWAY_SOCKET,
    // Each order is journalled here before it is answered and written to the database just behind.
    ENGINE_JOURNAL: path.join(DATA_DIR, 'engine.journal'),
    // HFT, the order book engine. The trading server starts it and gives it a copy of every price
    // and order (test mode); its recordings and statistics are kept with the rest of the app's data.
    HFT_BIN: path.join(RESOURCES, 'hft', 'hft'),
    HFT_DIR: path.join(DATA_DIR, 'hft'),
    DESKTOP_KEY: config.desktopKey,
    DESKTOP_ADMIN_ID: config.adminId,
    DESKTOP_TRADER_ID: TRADER_ACCOUNT,
  };
  serverEnv = env;

  // Schema and first-run accounts must exist before the API and worker start.
  await node('seed', 'seed.mjs', env, { once: true });
  // A restore replaces the database's contents, so it happens here: tables ready, nobody using them yet.
  await restoreIfAsked();
  const api = node('api', 'api.mjs', env);
  node('worker', 'worker.mjs', env);

  await waitUntil(
    'The trading server',
    async () => {
      try {
        return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    api,
  );
  platformReady = true;
  apiPort = ports.api;
  // People are connected to this Mac while it hosts: do not let it doze off under them.
  if (config.hostOnNetwork) keepAwake(true);
  if (config.shareOnInternet) startTunnel();
  scheduleBackups();
  log('app', `ready at ${origin}${config.hostOnNetwork ? `, hosting at ${networkAddresses().join(', ') || 'no network address'}` : ''}`);
}

async function stopPlatform() {
  clearInterval(backupTimer);
  stopTunnel();
  const stop = async (entries, graceMs) => {
    const live = entries.filter((p) => isRunning(p.child));
    for (const p of live) p.child.kill(p.stopSignal);
    const deadline = Date.now() + graceMs;
    while (live.some((p) => isRunning(p.child)) && Date.now() < deadline) await sleep(50);
    for (const p of live) if (isRunning(p.child)) p.child.kill('SIGKILL');
  };
  // Clients first so the stores shut down with nothing connected.
  await stop(processes.filter((p) => p.name === 'api' || p.name === 'worker'), 4000);
  await stop(processes.filter((p) => p.name === 'redis' || p.name === 'postgres'), 8000);
  fs.rmSync(RUN_FILE, { force: true });
  log('app', 'stopped');
}

/** True while people elsewhere reach the app through this Mac. */
const othersDependOnThis = () => Boolean(config?.shareOnInternet || config?.hostOnNetwork) && !process.env.GOMER_SELFTEST_DIR;

/**
 * Quit from the menu or the keyboard. Quitting takes the link down, so while
 * the app is shared this asks first. A shutdown, a log-out or a stop signal
 * does not come through here and is never held up by a question.
 */
async function quitIfSure() {
  if (othersDependOnThis() && !quitting) {
    const { response } = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'warning',
      buttons: ['Keep Running', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      message: `Quit ${APP_NAME}?`,
      detail: 'Your link stops working while the app is closed, and anyone trading is disconnected. Their accounts and positions are kept.\n\nTo keep the link up, leave the app running. You can close its window; it carries on in the Dock.',
    });
    if (response !== 1) return;
  }
  app.quit();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: '#06090d',
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The self-test must keep rendering even if another window covers this one.
      backgroundThrottling: !process.env.GOMER_SELFTEST_DIR,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));
  // The page title carries a subtitle; the window is simply the app's name.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());

  keepToTheApp(mainWindow);
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  return mainWindow.loadFile(path.join(HERE, 'loading.html'));
}

const isAppUrl = (url) => origin !== null && (url === origin || url.startsWith(`${origin}/`));
const openExternally = (url) => {
  if (/^https:\/\//i.test(url)) void shell.openExternal(url);
};

/** A window only ever shows the app itself; any other link opens in the user's browser. The AT and HFT pages open in windows of their own. */
function keepToTheApp(window) {
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const lab = isAppUrl(url) ? /^\/(at|hft)\/?$/.exec(new URL(url).pathname)?.[1] : undefined;
    if (lab) openLabWindow(lab);
    else openExternally(url);
    return { action: 'deny' };
  });
}

// AT (the trading algorithm) and HFT (the order book engine) each get a window of their own,
// opened from their boxes in the terminal or from the Trading menu.
const LAB_WINDOWS = {
  at: { title: 'AT · Algorithmic Trading' },
  hft: { title: 'HFT · High-Frequency Trading' },
};
const labWindows = new Map();

function openLabWindow(name) {
  const spec = LAB_WINDOWS[name];
  if (!spec || !platformReady || quitting || origin === null) return;
  const open = labWindows.get(name);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    return open.focus();
  }
  const window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: `${spec.title} — ${APP_NAME}`,
    backgroundColor: '#06090d',
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  labWindows.set(name, window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => labWindows.delete(name));
  window.on('page-title-updated', (event) => event.preventDefault());
  keepToTheApp(window);
  void window.loadURL(`${origin}/${name}`);
}

function showTerminal() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    return mainWindow.focus();
  }
  if (!platformReady || quitting) return;
  createWindow();
  void mainWindow?.loadURL(`${origin}/`);
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Market Data…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { label: 'Share on the Internet…', click: () => void showSharing() },
        { label: 'Host on This Network…', click: () => void showHosting() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // Not the built-in Quit: while people are connected through this Mac, quitting asks first.
        { label: `Quit ${APP_NAME}`, accelerator: 'Command+Q', click: () => void quitIfSure() },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Trading',
      submenu: [
        { label: 'Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: () => showTerminal() },
        { type: 'separator' },
        { label: 'Algorithmic Trading (AT)', accelerator: 'CmdOrCtrl+Shift+A', click: () => openLabWindow('at') },
        { label: 'High-Frequency Trading (HFT)', accelerator: 'CmdOrCtrl+Shift+H', click: () => openLabWindow('hft') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open Data Folder', click: () => void shell.openPath(DATA_DIR) },
        { label: 'Show Log File', click: () => shell.showItemInFolder(LOG_FILE) },
        { type: 'separator' },
        { label: 'Back Up Now', click: () => void backUpNow() },
        { label: 'Open Backups Folder', click: () => (fs.mkdirSync(BACKUP_DIR, { recursive: true }), void shell.openPath(BACKUP_DIR)) },
        { label: 'Restore a Backup…', click: () => void restoreBackup() },
        { type: 'separator' },
        { label: 'Reset All Data…', click: () => void resetAllData() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Backups
//
// This Mac is the only place a competition's accounts and trades exist, so the
// app keeps copies. A backup is a single file of data (not database files),
// written by the bundled backup script while everything keeps running.
// ---------------------------------------------------------------------------

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RESTORE_REQUEST = path.join(DATA_DIR, 'restore-request.json');
const BACKUP_EVERY_MS = 6 * 3600_000;
const BACKUPS_KEPT = 28; // a week at four a day
let serverEnv = null;
let backupTimer;
let backingUp = null;
/** Set when a restore was attempted during this launch, so the window can say how it went. */
let restoreOutcome = null;

/** Newest first. */
function listBackups() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith('.gtbackup'))
      .map((name) => ({ file: path.join(BACKUP_DIR, name), at: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** Writes a backup and returns its path. Calls made while one is being written share it. */
function saveBackup(label = '') {
  backingUp ??= (async () => {
    // Named by this Mac's own clock, since its owner is the one who will read it.
    const now = new Date();
    const two = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())}`;
    const file = path.join(BACKUP_DIR, `Gomer Trading ${stamp}${label ? ` ${label}` : ''}.gtbackup`);
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    await node('backup', 'backup.mjs', serverEnv, { once: true, args: ['save', file] });
    // Automatic ones are thinned out; a backup someone asked for, or made before a restore or reset, is theirs to delete.
    for (const old of listBackups().filter((b) => /\d{4}\.gtbackup$/.test(b.file)).slice(BACKUPS_KEPT)) fs.rmSync(old.file, { force: true });
    return file;
  })().finally(() => {
    backingUp = null;
  });
  return backingUp;
}

function scheduleBackups() {
  const ifDue = () => {
    const latest = listBackups()[0];
    if (quitting || (latest && Date.now() - latest.at < BACKUP_EVERY_MS)) return;
    saveBackup().catch((err) => log('backup', `automatic backup failed: ${err.message}`));
  };
  clearInterval(backupTimer);
  backupTimer = setInterval(ifDue, 15 * 60_000);
  // Not in the first seconds of a launch, when everything else is starting too.
  setTimeout(ifDue, 20_000);
}

/** Runs during startup when the previous run (or the environment) asked for a backup to be restored. */
async function restoreIfAsked() {
  let file = process.env.GOMER_RESTORE_FILE || null;
  try {
    file ??= JSON.parse(fs.readFileSync(RESTORE_REQUEST, 'utf8')).file;
  } catch {
    // nothing asked for
  }
  fs.rmSync(RESTORE_REQUEST, { force: true });
  if (!file) return;
  try {
    // First a copy of what is about to be replaced, so a restore can itself be undone.
    await saveBackup('before restore');
    await node('backup', 'backup.mjs', serverEnv, { once: true, args: ['load', file] });
    restoreOutcome = { ok: true, file };
    log('app', `restored the backup ${file}`);
  } catch (err) {
    restoreOutcome = { ok: false, file, reason: /Backup load failed: ([^\n]+)/.exec(err.message)?.[1] ?? err.message };
    log('app', `could not restore ${file}: ${err.message}`);
  }
}

function reportRestore() {
  if (!restoreOutcome) return;
  const { ok, file, reason } = restoreOutcome;
  restoreOutcome = null;
  void dialog.showMessageBox(mainWindow ?? undefined, {
    type: ok ? 'info' : 'error',
    message: ok ? 'Backup restored' : 'The backup could not be restored',
    detail: ok
      ? `Everything is as it was in:\n${path.basename(file)}\n\nWhat was here before the restore was saved too, in the backups folder, in case you want it back.`
      : `Nothing was changed.\n\nReason: ${reason}`,
  });
}

async function backUpNow() {
  try {
    const file = await saveBackup('manual');
    const { response } = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'info',
      buttons: ['OK', 'Show in Finder'],
      message: 'Backup saved',
      detail: `${path.basename(file)}\n\n${APP_NAME} also backs up by itself every six hours while it is open. For safety against losing this Mac, copy a backup somewhere else now and then.`,
    });
    if (response === 1) shell.showItemInFolder(file);
  } catch (err) {
    dialog.showErrorBox('The backup could not be saved', err.message);
  }
}

async function restoreBackup() {
  const picked = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Restore a Backup',
    defaultPath: BACKUP_DIR,
    properties: ['openFile'],
    filters: [{ name: `${APP_NAME} backups`, extensions: ['gtbackup'] }],
  });
  const file = picked.filePaths[0];
  if (picked.canceled || !file) return;
  const { response } = await dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'warning',
    buttons: ['Cancel', 'Restore and Restart'],
    defaultId: 0,
    cancelId: 0,
    message: 'Restore this backup?',
    detail: `${path.basename(file)}\n\nEvery account, competition, position and order goes back to how it was when this backup was made. Anything done since then is replaced, and everyone is signed out while the app restarts.\n\nThe current data is backed up first, so you can undo this.`,
  });
  if (response !== 1) return;
  fs.writeFileSync(RESTORE_REQUEST, JSON.stringify({ file }));
  log('app', `restore requested: ${file}`);
  await restartApp();
}

async function resetAllData() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Erase and Restart'],
    defaultId: 0,
    cancelId: 0,
    message: `Erase all ${APP_NAME} data?`,
    detail: 'A backup is saved first (Help → Open Backups Folder). Then: this permanently deletes every account, competition, position and order on this Mac, then restarts with a fresh $100,000 practice account. It cannot be undone.',
  });
  if (response === 1) await eraseAndRestart();
}

async function eraseAndRestart() {
  // The one thing that makes "erase everything" survivable.
  if (platformReady) await saveBackup('before reset').catch((err) => log('backup', `backup before reset failed: ${err.message}`));
  quitting = true;
  await stopPlatform();
  fs.rmSync(PG_DATA, { recursive: true, force: true });
  fs.rmSync(CONFIG_FILE, { force: true });
  // The saved session belongs to accounts that no longer exist.
  await mainWindow?.webContents.session.clearStorageData({ storages: ['localstorage'] }).catch(() => undefined);
  log('app', 'all data erased; restarting');
  app.relaunch();
  app.exit(0);
}

/** Stops every service and starts the app again, so it picks up changed settings. */
async function restartApp() {
  quitting = true;
  await stopPlatform();
  app.relaunch();
  app.exit(0);
}

// ---------------------------------------------------------------------------
// Staying awake while other people depend on this Mac
// ---------------------------------------------------------------------------

let awakeBlocker = null;
function keepAwake(on) {
  if (on && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
}

// ---------------------------------------------------------------------------
// Sharing on the internet: a secure public link to this Mac
//
// A bundled relay program opens an outbound connection to its service, which
// gives this Mac an https address and passes visitors down that connection to
// the trading server on 127.0.0.1. Nothing on this Mac listens on the network
// for it, so no router or firewall setting is involved, and the address stops
// answering the moment the relay does.
//
// Two relays, chosen by config.fixedAddress:
//   temporary link     Cloudflare quick tunnel. No account. A new random
//                      address every time it starts.
//   permanent address  Tailscale Funnel. The owner signs in to Tailscale once;
//                      the address then belongs to this Mac and never changes.
// ---------------------------------------------------------------------------

/**
 * state: off | starting | waiting | online | failed.
 * "waiting" means the permanent address needs its owner to do something in a browser; step says what.
 */
const tunnel = { state: 'off', url: null, lastUrl: null, child: null, daemon: null, step: null, run: 0, busy: false, failures: 0, retry: null, waiters: [] };

function settleTunnel() {
  for (const resolve of tunnel.waiters.splice(0)) resolve();
}

function startTunnel() {
  if (!apiPort) return;
  if (config.fixedAddress) void startFixedAddress();
  else startQuickTunnel();
}

/** Sharing stopped while it should be up: try again, less and less often, for as long as it is switched on. */
function retryTunnel() {
  tunnel.failures = tunnel.state === 'online' ? 0 : tunnel.failures + 1;
  tunnel.url = null;
  tunnel.step = null;
  if (quitting || !config.shareOnInternet) return;
  if (tunnel.failures >= 3) {
    tunnel.state = 'failed';
    settleTunnel();
  } else {
    tunnel.state = 'starting';
  }
  const delay = Math.min(60_000, 3000 * 2 ** tunnel.failures);
  clearTimeout(tunnel.retry);
  tunnel.retry = setTimeout(() => {
    tunnel.retry = null;
    if (!quitting && config.shareOnInternet) startTunnel();
  }, delay);
}

/** The address has been issued: confirm it really serves the app, then tell everyone. */
async function announceTunnel(child, issued, { settleMs, attempts }) {
  // The address exists a moment before it answers. Looking it up too early would make this
  // Mac remember "no such host", so wait first.
  await sleep(settleMs);
  for (let attempt = 0; attempt < attempts && tunnel.child === child; attempt++) {
    const ok = await fetch(`${issued}/health`, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await sleep(3000);
  }
  if (tunnel.child !== child) return;
  tunnel.url = issued;
  tunnel.step = null;
  tunnel.state = 'online';
  tunnel.failures = 0;
  log('app', `sharing on the internet at ${issued}`);
  settleTunnel();
  // A temporary link that had to be re-made comes back with a different address, and the old one is dead.
  const changed = tunnel.lastUrl && tunnel.lastUrl !== issued;
  const first = !tunnel.lastUrl;
  tunnel.lastUrl = issued;
  if ((first || changed) && Notification.isSupported()) {
    new Notification(
      changed
        ? { title: 'Your internet link has changed', body: 'The connection was re-made. Send your traders the new invite link from the Admin console.' }
        : { title: `${APP_NAME} is shared on the internet`, body: 'Open the Admin console to copy an invite link.' },
    ).show();
  }
}

// --- temporary link (Cloudflare quick tunnel) ------------------------------

function startQuickTunnel() {
  if (tunnel.child) return;
  if (!fs.existsSync(CLOUDFLARED)) {
    tunnel.state = 'failed';
    log('tunnel', 'the tunnel program is not included in this build');
    return settleTunnel();
  }
  // While it keeps failing it stays "failed" for the interface, even as another attempt runs.
  if (tunnel.state !== 'failed') tunnel.state = 'starting';
  tunnel.url = null;
  keepAwake(true);

  const child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${apiPort}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnel.child = child;
  let issued = null;
  let announced = false;
  const onOutput = (chunk) => {
    const text = String(chunk);
    log('tunnel', text);
    issued ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0] ?? null;
    if (issued && !announced && /Registered tunnel connection/.test(text)) {
      announced = true;
      void announceTunnel(child, issued, { settleMs: 5000, attempts: 30 });
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (err) => log('tunnel', `failed to start: ${err.message}`));
  child.on('exit', (code) => {
    log('tunnel', `exited (code ${code})`);
    if (tunnel.child !== child) return; // stopped on purpose
    tunnel.child = null;
    // Cloudflare's free service has bad moments. A new tunnel has a new address.
    retryTunnel();
  });
  saveRunFile();
}

// --- permanent address (Tailscale Funnel) ----------------------------------
//
// tailscaled runs as an ordinary process in "userspace" mode: no administrator
// rights, no system network extension, nothing installed outside the app. Its
// identity lives in the data folder, which is what makes the address permanent.

// Where programs on this Mac reach the binary gateway. In the data folder so the path is stable and
// easy to find, unless that would be too long for a Unix socket path.
const GATEWAY_SOCKET = path.join(DATA_DIR, 'gateway.sock').length < 100 ? path.join(DATA_DIR, 'gateway.sock') : path.join(os.tmpdir(), `gomer-gw-${crypto.createHash('sha1').update(DATA_DIR).digest('hex').slice(0, 10)}.sock`);

const TS_STATE = path.join(DATA_DIR, 'tailscale');
// A Unix socket path may only be about a hundred characters long, so it cannot sit in the data folder.
const TS_SOCKET = path.join(os.tmpdir(), `gomer-ts-${crypto.createHash('sha1').update(DATA_DIR).digest('hex').slice(0, 10)}.sock`);
const TS_HOSTNAME = 'gomer-trading';

const tailscale = (args) => spawn(TAILSCALE, [`--socket=${TS_SOCKET}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

/** What tailscaled says about itself, or null while it is not answering. */
function tailscaleStatus() {
  return new Promise((resolve) => {
    execFile(TAILSCALE, [`--socket=${TS_SOCKET}`, 'status', '--json'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/** The owner has to do something in a browser before the address can come up. */
function needOwner(kind, url) {
  if (tunnel.step?.url === url) return;
  tunnel.step = { kind, url };
  tunnel.state = 'waiting';
  log('app', `permanent address: waiting for you to ${kind === 'sign-in' ? 'sign in' : 'approve'} at ${url}`);
  settleTunnel();
  // Automated runs must not pop pages open in the owner's browser.
  if (!process.env.GOMER_SELFTEST_DIR && !process.env.GOMER_NO_BROWSER) void shell.openExternal(url);
  if (Notification.isSupported()) {
    new Notification({
      title: 'One step left for your permanent address',
      body: kind === 'sign-in' ? 'Sign in to Tailscale in the browser page that just opened.' : 'Approve public access in the browser page that just opened.',
    }).show();
  }
}

async function startFixedAddress() {
  if (tunnel.child || tunnel.busy) return;
  if (!fs.existsSync(TAILSCALE) || !fs.existsSync(TAILSCALED)) {
    tunnel.state = 'failed';
    log('tunnel', 'the permanent address program is not included in this build');
    return settleTunnel();
  }
  const run = tunnel.run;
  const current = () => run === tunnel.run && !quitting && config.shareOnInternet && config.fixedAddress;
  tunnel.busy = true;
  if (tunnel.state !== 'failed') tunnel.state = 'starting';
  tunnel.url = null;
  keepAwake(true);
  try {
    await runTailscaled(current);
    await signInToTailscale(current);
    if (current()) startFunnel();
  } catch (err) {
    if (!current()) return;
    log('tunnel', `permanent address: ${err.message}`);
    retryTunnel();
  } finally {
    if (run === tunnel.run) tunnel.busy = false;
  }
}

async function runTailscaled(current) {
  if (!tunnel.daemon) {
    fs.mkdirSync(TS_STATE, { recursive: true, mode: 0o700 });
    fs.rmSync(TS_SOCKET, { force: true });
    // It is very talkative, so it gets a log of its own, started afresh each time.
    const out = fs.openSync(path.join(LOG_DIR, 'tailscale.log'), 'w');
    const daemon = spawn(TAILSCALED, ['--tun=userspace-networking', `--socket=${TS_SOCKET}`, `--statedir=${TS_STATE}`, '--no-logs-no-support'], { stdio: ['ignore', out, out] });
    fs.closeSync(out);
    tunnel.daemon = daemon;
    daemon.on('error', (err) => log('tunnel', `tailscaled failed to start: ${err.message}`));
    daemon.on('exit', (code) => {
      log('tunnel', `tailscaled exited (code ${code})`);
      // If it died by itself, whichever step depends on it notices and starts over.
      if (tunnel.daemon === daemon) tunnel.daemon = null;
    });
    saveRunFile();
  }
  for (let i = 0; i < 100 && current(); i++) {
    if (await tailscaleStatus()) return;
    if (!tunnel.daemon) throw new Error('tailscaled stopped');
    await sleep(300);
  }
  if (current()) throw new Error('tailscaled did not start');
}

/** Returns once this Mac is connected to its owner's Tailscale account, asking them to sign in if it is not. */
async function signInToTailscale(current) {
  let signIn = null; // `tailscale up`: prints the sign-in page's address, then waits for the sign-in
  let attempts = 0;
  try {
    while (current()) {
      const status = await tailscaleStatus();
      if (!status) throw new Error('tailscaled stopped answering');
      if (status.BackendState === 'Running') return;
      if (status.BackendState === 'NeedsMachineAuth') {
        needOwner('approve', 'https://login.tailscale.com/admin/machines');
      } else if (!signIn && status.BackendState !== 'Starting') {
        if (++attempts > 5) throw new Error('could not start signing in');
        const child = tailscale(['up', `--hostname=${TS_HOSTNAME}`]);
        signIn = child;
        const onOutput = (chunk) => {
          const text = String(chunk);
          log('tunnel', text);
          const url = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/.exec(text)?.[0];
          if (url && current()) needOwner('sign-in', url);
        };
        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);
        child.on('error', () => undefined);
        child.on('exit', () => {
          if (signIn === child) signIn = null;
        });
      }
      await sleep(1500);
    }
  } finally {
    signIn?.kill('SIGTERM');
  }
}

/** Publishes the trading server at this Mac's Tailscale address for as long as the command runs. */
function startFunnel() {
  const child = tailscale(['funnel', String(apiPort)]);
  tunnel.child = child;
  let issued = null;
  const onOutput = (chunk) => {
    const text = String(chunk);
    log('tunnel', text);
    if (issued) return;
    // The first time, public access has to be approved for the account; the command waits for that.
    const approve = /https:\/\/login\.tailscale\.com\/f\/\S+/.exec(text)?.[0];
    if (approve) needOwner('approve', approve);
    issued = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net/.exec(text)?.[0] ?? null;
    if (!issued) return;
    tunnel.step = null;
    if (tunnel.state === 'waiting') tunnel.state = 'starting';
    // A brand-new address takes about five minutes to appear on the public internet (its name
    // has to be published and its certificate issued); after that first time, seconds.
    void announceTunnel(child, issued, { settleMs: 3000, attempts: 200 });
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (err) => log('tunnel', `failed to start: ${err.message}`));
  child.on('exit', (code) => {
    log('tunnel', `funnel exited (code ${code})`);
    if (tunnel.child !== child) return; // stopped on purpose
    tunnel.child = null;
    retryTunnel();
  });
  saveRunFile();
}

function stopTunnel() {
  const { child, daemon } = tunnel;
  clearTimeout(tunnel.retry);
  Object.assign(tunnel, { run: tunnel.run + 1, busy: false, retry: null, failures: 0, child: null, daemon: null, url: null, step: null, state: 'off' });
  child?.kill('SIGTERM');
  daemon?.kill('SIGTERM');
  settleTunnel();
  if (!config?.hostOnNetwork) keepAwake(false);
}

/** Resolves when sharing is online, has failed or is waiting for its owner, or after the timeout. */
function tunnelSettled(timeoutMs) {
  if (tunnel.state !== 'starting') return Promise.resolve();
  return Promise.race([new Promise((resolve) => tunnel.waiters.push(resolve)), sleep(timeoutMs)]);
}

async function showSharing() {
  if (!config) return;
  const window = mainWindow ?? undefined;
  const permanent = Boolean(config.fixedAddress);
  const service = permanent ? "Tailscale's free Funnel service" : "Cloudflare's free tunnel service";

  if (!config.shareOnInternet) {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      buttons: ['Cancel', 'Turn On'],
      defaultId: 1,
      cancelId: 0,
      message: 'Share on the internet?',
      detail: [
        `This gives you a secure https link. Anyone you send it to can open ${APP_NAME} in a web browser, anywhere, and join your competitions with an invite code. They install nothing.`,
        'This Mac is the server: it has to stay on, with this app open, for as long as they trade. The app will keep it awake.',
        permanent
          ? 'Your address is permanent: it is the same every time, so you only send it once.'
          : 'The link is new each time you turn sharing on or restart the app, so send it out again after a restart. You can make it permanent once it is on.',
        `It works through ${service}, which relays the traffic and comes with no guarantee of availability. It is right for a group of friends or a class, not for a public service.`,
      ].join('\n\n'),
    });
    if (response !== 1) return;
    saveConfig({ ...config, shareOnInternet: true });
    log('app', 'internet sharing turned on');
    startTunnel();
    await tunnelSettled(75_000);
  }

  if (tunnel.state === 'starting') await tunnelSettled(20_000);
  const state = tunnel.state === 'online' && !tunnel.url ? 'starting' : tunnel.state;
  const views = {
    online: {
      action: 'Copy Link',
      message: permanent ? 'Your permanent address:' : 'Your traders can join at:',
      detail: [
        tunnel.url,
        permanent ? 'It stays the same every time you open the app.' : 'This link changes whenever the app restarts. Choose Make It Permanent… for an address that never changes.',
        "To invite someone, open the Admin console and copy a competition's invite link. It already includes this address.",
        'Keep this Mac on and this app open while they trade.',
      ].join('\n\n'),
    },
    waiting: {
      action: 'Open the Page',
      message: 'One step left, in your browser',
      detail:
        tunnel.step?.kind === 'sign-in'
          ? 'Sign in to Tailscale (a Google account works) on the page that opened in your browser. It is free. Your address appears here as soon as you have signed in.'
          : 'Approve public access on the Tailscale page that opened in your browser. Your address appears here as soon as you have.',
    },
    starting: {
      action: 'Try Now',
      message: 'Still getting your link…',
      detail: permanent
        ? 'A permanent address takes about five minutes to appear on the internet the very first time, and about half a minute after that. You will get a notification when it is ready.'
        : 'It usually takes under half a minute. Choose Share on the Internet… again in a moment.',
    },
    failed: {
      action: 'Try Now',
      message: 'No link yet',
      detail: `${service[0].toUpperCase()}${service.slice(1)} is not answering at the moment. ${APP_NAME} keeps trying about once a minute and will notify you as soon as your link is ready.\n\nIf this goes on, check that this Mac is connected to the internet.\n\nDetails are in:\n${LOG_FILE}`,
    },
  };
  const view = views[state] ?? views.failed;
  const { response } = await dialog.showMessageBox(window, {
    type: state === 'failed' ? 'warning' : 'info',
    buttons: ['Close', view.action, 'Turn Off', permanent ? 'Use a Temporary Link' : 'Make It Permanent…'],
    defaultId: state === 'online' || state === 'waiting' ? 1 : 0,
    cancelId: 0,
    message: view.message,
    detail: view.detail,
  });
  if (response === 1) {
    if (state === 'online') clipboard.writeText(tunnel.url);
    else if (state === 'waiting' && tunnel.step) void shell.openExternal(tunnel.step.url);
    else {
      stopTunnel();
      startTunnel();
      return showSharing();
    }
  }
  if (response === 2) {
    saveConfig({ ...config, shareOnInternet: false });
    stopTunnel();
    log('app', 'internet sharing turned off');
  }
  if (response === 3) return switchSharingKind();
}

/** Moves between the temporary link and the permanent address. */
async function switchSharingKind() {
  if (!config.fixedAddress) {
    const { response } = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'question',
      buttons: ['Cancel', 'Continue'],
      defaultId: 1,
      cancelId: 0,
      message: 'Get a permanent address?',
      detail: [
        `A permanent address stays the same every time, so you send your traders one link and never have to again. It looks like https://${TS_HOSTNAME}.your-name.ts.net.`,
        'Tailscale provides it free. You sign in once, with a Google, Microsoft, GitHub or Apple account. Up to two pages open in your browser: one to sign in, one to approve public access to this app. Nothing else on this Mac is shared.',
        'Your temporary link stops working when you continue.',
      ].join('\n\n'),
    });
    if (response !== 1) return;
  }
  saveConfig({ ...config, fixedAddress: !config.fixedAddress, shareOnInternet: true });
  log('app', `internet sharing now uses ${config.fixedAddress ? 'a permanent address' : 'a temporary link'}`);
  stopTunnel();
  startTunnel();
  await tunnelSettled(75_000);
  return showSharing();
}

// ---------------------------------------------------------------------------
// Hosting: letting other people join from the same network
// ---------------------------------------------------------------------------

/** Addresses other devices on the network can reach this Mac at, most useful first. */
function networkAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push({ name, url: `http://${entry.address}:${apiPort}` });
    }
  }
  // en0 is the built-in Wi-Fi or Ethernet on a Mac; VPNs and virtual adapters come after.
  return found.sort((a, b) => Number(b.name === 'en0') - Number(a.name === 'en0')).map((entry) => entry.url);
}

async function showHosting() {
  if (!config) return;
  const addresses = networkAddresses();
  const window = mainWindow ?? undefined;

  if (!config.hostOnNetwork) {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      buttons: ['Cancel', 'Turn On and Restart'],
      defaultId: 1,
      cancelId: 0,
      message: 'Let other people join from your network?',
      detail: [
        `While this is on, anyone on the same Wi-Fi or office network can open ${APP_NAME} in a web browser and join your competitions with an invite code. They need nothing installed.`,
        'This Mac is the server: it has to stay on, with this app open, for as long as they trade. The app will keep it awake.',
        'Connections on your network are not encrypted. Use this at home or at work, not on public Wi-Fi.',
        'If macOS asks whether to allow incoming connections, choose Allow.',
      ].join('\n\n'),
    });
    if (response !== 1) return;
    saveConfig({ ...config, hostOnNetwork: true });
    log('app', 'hosting turned on; restarting');
    return restartApp();
  }

  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    buttons: ['Close', 'Copy Address', 'Turn Off and Restart'],
    defaultId: 0,
    cancelId: 0,
    message: addresses.length ? 'Other people can join at:' : 'Hosting is on, but this Mac is not connected to a network.',
    detail: [
      ...(addresses.length ? [addresses.join('\n')] : []),
      'To invite someone, open the Admin console and copy a competition\'s invite link. They pick their own Trader ID and password.',
      'Only devices on the same network can reach this address. For people elsewhere, use Share on the Internet… instead.',
    ].join('\n\n'),
  });
  if (response === 1 && addresses[0]) clipboard.writeText(addresses[0]);
  if (response === 2) {
    saveConfig({ ...config, hostOnNetwork: false });
    log('app', 'hosting turned off; restarting');
    return restartApp();
  }
}

const fromApp = (event) => origin !== null && (event.senderFrame?.url ?? '').startsWith(`${origin}/`);

ipcMain.handle('gomer:hosting', (event) => {
  if (!fromApp(event)) throw new Error('Not available here.');
  // The public link comes first: it works for everyone, wherever they are.
  const addresses = [...(tunnel.url ? [tunnel.url] : []), ...(config.hostOnNetwork ? networkAddresses() : [])];
  return {
    enabled: Boolean(config.hostOnNetwork || config.shareOnInternet),
    addresses,
    internet: { enabled: Boolean(config.shareOnInternet), state: tunnel.state, url: tunnel.url, permanent: Boolean(config.fixedAddress) },
  };
});
ipcMain.on('gomer:open-hosting', (event) => {
  if (fromApp(event)) void showSharing();
});

// ---------------------------------------------------------------------------
// Market Data settings: where the user connects real prices
// ---------------------------------------------------------------------------

const ALPACA_DATA_URL = (process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
const ALPACA_FEEDS = ['iex', 'sip'];

function openSettings() {
  if (!mainWindow || !config) return;
  if (settingsWindow) return settingsWindow.focus();

  settingsWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true, // a sheet attached to the main window on macOS
    width: 520,
    // Taller while the practice market is the source of prices: its hours are chosen here too.
    height: config.alpacaApiKey && config.alpacaApiSecret ? 660 : 768,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    backgroundColor: '#0c1117',
    webPreferences: {
      preload: path.join(HERE, 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => (settingsWindow = null));
  // This window only ever shows the bundled settings page.
  settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void settingsWindow.loadFile(path.join(HERE, 'settings.html'));
}

const fromSettings = (event) => settingsWindow !== null && event.sender === settingsWindow.webContents;
const maskKey = (key) => (key.length > 6 ? `${key.slice(0, 2)}…${key.slice(-4)}` : '…');

/** Normalises what the form sent. An empty secret means "keep the saved one" when the key is unchanged. */
function readKeys(input) {
  const key = String(input?.key ?? '').trim();
  let secret = String(input?.secret ?? '').trim();
  if (!secret && key && key === config.alpacaApiKey) secret = config.alpacaApiSecret;
  const feed = ALPACA_FEEDS.includes(input?.feed) ? input.feed : 'iex';
  if (!key || !secret) return { error: 'Enter both the API key ID and the secret key.' };
  if (/\s/.test(key) || /\s/.test(secret) || key.length > 200 || secret.length > 200) return { error: 'Those do not look like Alpaca keys. Copy each value again without spaces.' };
  return { key, secret, feed };
}

/** Asks Alpaca for one quote with the given keys. Returns { ok, message } in words for the user. */
async function testAlpaca({ key, secret, feed }) {
  let response;
  try {
    response = await fetch(`${ALPACA_DATA_URL}/v2/stocks/AAPL/snapshot?feed=${feed}`, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, message: 'Could not reach Alpaca. Check your internet connection and try again.' };
  }
  const text = await response.text().catch(() => '');
  if (response.ok) {
    let last = null;
    try {
      last = JSON.parse(text)?.latestTrade?.p ?? null;
    } catch {
      // a 200 with an unexpected body still proves the keys work
    }
    return { ok: true, message: last ? `Connected. Apple (AAPL) last traded at $${Number(last).toFixed(2)}.` : 'Connected to Alpaca.' };
  }
  if (/subscription/i.test(text)) return { ok: false, message: 'Your Alpaca plan does not include that feed. Choose IEX instead.' };
  if (response.status === 401 || response.status === 403) return { ok: false, message: 'Alpaca did not accept these keys. Check that both values were copied in full.' };
  if (response.status === 429) return { ok: false, message: 'Alpaca is rate limiting this account right now. Wait a minute and try again.' };
  return { ok: false, message: `Alpaca answered with an error (${response.status}). Try again in a moment.` };
}

ipcMain.handle('gomer:settings:get', (event) => {
  if (!fromSettings(event)) throw new Error('Not available here.');
  const connected = Boolean(config.alpacaApiKey && config.alpacaApiSecret);
  return {
    connected,
    key: config.alpacaApiKey ?? '',
    keyHint: connected ? maskKey(config.alpacaApiKey) : '',
    feed: ALPACA_FEEDS.includes(config.alpacaFeed) ? config.alpacaFeed : 'iex',
    practiceHours: config.practiceHours === 'always' ? 'always' : 'exchange',
  };
});

/** Whether the built-in practice market keeps exchange hours or runs around the clock. */
ipcMain.handle('gomer:settings:practice-hours', async (event, input) => {
  if (!fromSettings(event)) throw new Error('Not available here.');
  const practiceHours = input?.practiceHours === 'always' ? 'always' : 'exchange';
  if (practiceHours === config.practiceHours) return { ok: true, message: 'Already set that way.' };
  saveConfig({ ...config, practiceHours });
  log('app', `market data: practice market hours set to ${practiceHours}; restarting`);
  setTimeout(() => void restartApp(), 900);
  return { ok: true, message: practiceHours === 'always' ? 'Restarting with a practice market that never closes…' : 'Restarting with a practice market that keeps exchange hours…' };
});

/** US market hours as this Mac's clock shows them, for the note in the settings sheet. */
ipcMain.handle('gomer:settings:hours', async (event) => {
  if (!fromSettings(event)) throw new Error('Not available here.');
  try {
    const hours = await (await fetch(`${origin}/api/market/hours`, { signal: AbortSignal.timeout(4000) })).json();
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    const day = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
    const opens = new Date(hours.session.opensAt);
    const closes = new Date(hours.session.closesAt);
    const today = opens.toDateString() === new Date().toDateString();
    return {
      range: `${time.format(opens)} to ${time.format(closes)}`,
      next: hours.open ? `open now, until ${time.format(closes)}` : `${today ? 'today' : day.format(opens)} at ${time.format(opens)}`,
    };
  } catch {
    return null;
  }
});

ipcMain.handle('gomer:settings:test', async (event, input) => {
  if (!fromSettings(event)) throw new Error('Not available here.');
  const keys = readKeys(input);
  return keys.error ? { ok: false, message: keys.error } : testAlpaca(keys);
});

ipcMain.handle('gomer:settings:save', async (event, input) => {
  if (!fromSettings(event)) throw new Error('Not available here.');
  const keys = readKeys(input);
  if (keys.error) return { ok: false, message: keys.error };
  // Never save keys that do not work: the app would restart into a dead feed.
  const result = await testAlpaca(keys);
  if (!result.ok) return result;
  saveConfig({ ...config, alpacaApiKey: keys.key, alpacaApiSecret: keys.secret, alpacaFeed: keys.feed });
  log('app', `market data: Alpaca keys saved (${keys.feed}); restarting`);
  setTimeout(() => void restartApp(), 900); // long enough to read the confirmation
  return { ok: true, message: `${result.message} Restarting with real prices…` };
});

ipcMain.handle('gomer:settings:clear', async (event) => {
  if (!fromSettings(event)) throw new Error('Not available here.');
  saveConfig({ ...config, alpacaApiKey: '', alpacaApiSecret: '' });
  log('app', 'market data: switched back to simulated prices; restarting');
  setTimeout(() => void restartApp(), 900);
  return { ok: true, message: 'Keys removed. Restarting with simulated prices…' };
});

ipcMain.on('gomer:settings:close', (event) => {
  if (fromSettings(event)) settingsWindow?.close();
});
ipcMain.on('gomer:settings:open-alpaca', (event) => {
  if (fromSettings(event)) void shell.openExternal('https://app.alpaca.markets/');
});
ipcMain.on('gomer:open-window', (event, name) => {
  const sender = event.senderFrame?.url ?? '';
  if (origin !== null && sender.startsWith(`${origin}/`) && Object.hasOwn(LAB_WINDOWS, name)) openLabWindow(name);
});
ipcMain.on('gomer:open-market-data', (event) => {
  const sender = event.senderFrame?.url ?? '';
  if (origin !== null && sender.startsWith(`${origin}/`)) openSettings();
});

// ---------------------------------------------------------------------------
// One-click sign-in for the accounts this app created
// ---------------------------------------------------------------------------

ipcMain.handle('gomer:sign-in', async (event, account) => {
  const sender = event.senderFrame?.url ?? '';
  if (origin === null || !sender.startsWith(`${origin}/`)) throw new Error('Not available here.');
  if (account !== 'trader' && account !== 'admin') throw new Error('Unknown account.');

  // No password involved: the owner can change the built-in accounts' passwords and still get in here.
  const response = await fetch(`${origin}/api/auth/desktop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-desktop-key': config.desktopKey },
    body: JSON.stringify({ account }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? 'Sign-in failed.');
  return { token: body.token, user: body.user };
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Opened again while already running: show the window, bringing it back if it had been closed.
    if (!mainWindow) return void app.emit('activate');
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    openLog();
    log('app', `${APP_NAME} ${app.getVersion()} starting (packaged: ${app.isPackaged})`);
    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), credits: 'Paper trading terminal. Simulated trading only.' });
    if (!app.isPackaged) app.dock?.setIcon(path.join(HERE, 'build', 'icon.png'));
    buildMenu();
    await createWindow();

    try {
      await startPlatform();
      // Diagnostics: GOMER_SELFTEST_DIR=<dir> drives the interface, saves
      // screenshots and a result.json there, then quits. See selftest.mjs.
      const selfTest = process.env.GOMER_SELFTEST_DIR ? await import('./selftest.mjs') : null;
      selfTest?.recordHttpErrors(mainWindow);
      await mainWindow?.loadURL(`${origin}/`);
      if (!selfTest) reportRestore();
      void selfTest?.run({
        directory: path.resolve(process.env.GOMER_SELFTEST_DIR ?? '.'),
        origin,
        mainWindow,
        settingsWindow: () => settingsWindow,
        labWindow: (name) => labWindows.get(name) ?? null,
        quit: () => app.quit(),
      });
    } catch (err) {
      log('app', `startup failed: ${err?.stack ?? err}`);
      if (process.env.GOMER_SELFTEST_DIR) {
        fs.mkdirSync(process.env.GOMER_SELFTEST_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.GOMER_SELFTEST_DIR, 'result.json'), JSON.stringify({ ok: false, error: String(err?.message ?? err) }, null, 2));
      } else {
        dialog.showErrorBox(`${APP_NAME} could not start`, `${err?.message ?? err}\n\nDetails are in:\n${LOG_FILE}`);
      }
      app.quit();
    }
  });

  let saidStillRunning = false;

  // Normally the window is the app: closing it quits, so nothing keeps running unseen. While the
  // app is shared, though, it is a server, and closing a window must not cut everyone off.
  app.on('window-all-closed', () => {
    if (quitting || !othersDependOnThis()) return void app.quit();
    if (saidStillRunning || !Notification.isSupported()) return;
    saidStillRunning = true;
    new Notification({ title: `${APP_NAME} is still running`, body: 'Your link stays up so traders stay connected. Click the Dock icon to open the window again. To stop, choose Quit.' }).show();
  });

  // Clicking the Dock icon brings the window back.
  app.on('activate', () => {
    if (mainWindow || !platformReady || quitting) return;
    createWindow();
    void mainWindow?.loadURL(`${origin}/`);
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopPlatform()
      .catch((err) => log('app', `shutdown error: ${err?.message ?? err}`))
      .finally(() => app.quit());
  });

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
}
