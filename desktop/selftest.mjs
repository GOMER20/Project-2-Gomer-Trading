// Built-in diagnostics, loaded only when GOMER_SELFTEST_DIR is set.
//
//   GOMER_SELFTEST_DIR=<dir>          where screenshots and result.json go
//   GOMER_SELFTEST_MODE=full          (default) trader sign-in, sign-out, admin console
//                       trader        trader sign-in only; leaves the session signed in
//                       market-data   connects real prices through the settings window,
//                                     then switches back (spans three app restarts)
//                       practice-hours changes the practice market's hours through the settings
//                                     window and back (spans three app restarts)
//   GOMER_SELFTEST_KEY / _SECRET      keys to enter in market-data mode
//
// It drives the real interface the way a person would, then quits the app.

import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every failed HTTP response the window sees, with its time since launch. */
const httpErrors = [];
export function recordHttpErrors(window) {
  const started = Date.now();
  window.webContents.session.webRequest.onCompleted((details) => {
    if (details.statusCode >= 400) httpErrors.push(`+${Date.now() - started}ms ${details.statusCode} ${details.method} ${new URL(details.url).pathname}`);
  });
}

const onLogin = (account) => `location.pathname === '/login' && !!document.querySelector('[data-quick-login="${account}"]')`;
const ON_TERMINAL = `location.pathname === '/' && document.body.textContent.includes('Total equity')`;
const SIGN_OUT = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Log out')?.click()`;
const QUOTES_STREAMING = `[...document.querySelectorAll('tr[aria-selected]')].filter((row) => /\\d+\\.\\d{2}/.test(row.textContent)).length >= 5`;
const badge = (label) => `document.querySelector('header').textContent.includes(${JSON.stringify(label)})`;

export async function run({ directory, origin, mainWindow, settingsWindow, labWindow, quit }) {
  const mode = process.env.GOMER_SELFTEST_MODE || 'full';
  const result = { ok: false, mode, origin, steps: [], httpErrors };
  fs.mkdirSync(directory, { recursive: true });

  const evaluateIn = (contents, code) => contents.executeJavaScript(code, true);
  const evaluate = (code) => evaluateIn(mainWindow.webContents, code);
  const waitIn = async (contents, description, code, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluateIn(contents(), code).catch(() => false)) return result.steps.push(description);
      await sleep(250);
    }
    throw new Error(`timed out waiting for: ${description}`);
  };
  const waitFor = (description, code, timeoutMs) => waitIn(() => mainWindow.webContents, description, code, timeoutMs);
  const capture = async (name, window = mainWindow) => fs.writeFileSync(path.join(directory, name), (await window.webContents.capturePage()).toPNG());

  /** Gets to the terminal as TRADER01, whether or not a session was saved. */
  async function reachTerminal() {
    await waitFor('interface loads', `(${onLogin('trader')}) || (${ON_TERMINAL})`);
    await sleep(2500); // a saved session that is no longer valid bounces to the login page
    result.resumedSession = await evaluate(ON_TERMINAL);
    if (!result.resumedSession) {
      result.steps.push('login page offers one-click sign-in');
      await capture('login.png');
      await evaluate(`document.querySelector('[data-quick-login="trader"]').click()`);
    }
    await waitFor('terminal opens', ON_TERMINAL);
    await waitFor('live feed connects', `document.body.textContent.includes('Live')`);
  }

  /** The Test Lab beside the sign-in box, and the AT and HFT windows its buttons open (signed in by the app itself). */
  async function testLab() {
    await waitFor('the opening screen loads', onLogin('trader'));
    await waitFor('the Test Lab (AT and HFT) is beside the sign-in box', `document.body.textContent.includes('TEST LAB') && document.body.textContent.includes('Algorithmic Trading · AT') && document.body.textContent.includes('High-Frequency Trading · HFT')`);
    await waitFor('the Test Lab shows live figures', `document.body.textContent.includes('Time per order') && !document.body.textContent.includes('Loading…')`);
    await capture('opening-screen.png');
    for (const [name, shows] of [
      ['at', `document.body.textContent.includes('Success rate') || document.body.textContent.includes('not set up on this exchange')`],
      ['hft', `document.body.textContent.includes('Time per order')`],
    ]) {
      await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Open ${name.toUpperCase()} window')).click()`);
      const deadline = Date.now() + 10_000;
      while (!labWindow(name) && Date.now() < deadline) await sleep(100);
      if (!labWindow(name)) throw new Error(`the ${name.toUpperCase()} window did not open`);
      await waitIn(() => labWindow(name).webContents, `the ${name.toUpperCase()} window opens, signed in, with its statistics`, `location.pathname === '/${name}' && (${shows})`);
      await sleep(1500); // let its charts draw
      await capture(`${name}-window.png`, labWindow(name));
      labWindow(name).close();
    }
  }

  async function standardRun() {
    // A fresh profile opens on the sign-in screen, where the Test Lab is.
    if (mode === 'full') await testLab();
    await reachTerminal();
    await waitFor('quotes are streaming', QUOTES_STREAMING);
    await waitFor('portfolio is loaded', `/Cash\\$[\\d,]+\\.\\d{2}/.test(document.querySelector('header').textContent)`);
    await waitFor('leaderboard is populated', `document.body.textContent.includes('ranked by total equity')`);
    await sleep(2500); // let the chart finish drawing
    await capture('terminal.png');
    result.title = await evaluate('document.title');

    result.cash = await evaluate(`document.querySelector('header').textContent.match(/Cash(\\$[\\d,]+\\.\\d{2})/)?.[1]`);
    if (mode === 'trader') return;

    await evaluate(SIGN_OUT);
    await waitFor('signing out returns to the login page', onLogin('admin'));
    await evaluate(`document.querySelector('[data-quick-login="admin"]').click()`);
    await waitFor('admin console opens', `location.pathname === '/admin' && document.body.textContent.includes('GOMER TRADING · ADMIN')`);
    await waitFor('admin console lists accounts and competitions', `/Accounts \\(\\d+\\)/.test(document.body.textContent) && document.body.textContent.includes('Demo Trading Challenge')`);
    await sleep(500);
    await capture('admin.png');
    result.accounts = await evaluate(`document.body.textContent.match(/Accounts \\((\\d+)\\)/)?.[1]`);
    await evaluate(`location.assign('/')`);
    await waitFor('terminal reachable from the admin session', ON_TERMINAL);
    await evaluate(SIGN_OUT);
    await waitFor('signed out at the end', onLogin('trader'));
  }

  /**
   * Phase 1: simulated -> open settings from the badge, reject bad keys, accept good ones, save.
   * Phase 2: (after the restart) real prices are streaming; switch back to simulated.
   * Phase 3: (after the second restart) simulated again.
   * Returns false when the app is about to restart itself and the run continues in the next launch.
   */
  async function marketDataRun() {
    const phaseFile = path.join(directory, 'phase.txt');
    const phase = fs.existsSync(phaseFile) ? Number(fs.readFileSync(phaseFile, 'utf8')) : 1;
    const settings = () => settingsWindow().webContents;
    const field = (id, value) => `document.getElementById('${id}').value = ${JSON.stringify(value)}`;
    const statusIs = (kind, text) => `document.getElementById('status').className === 'status ${kind}' && document.getElementById('status').textContent.includes(${JSON.stringify(text)})`;
    const openSettingsFromBadge = async (label) => {
      await evaluate(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
      const deadline = Date.now() + 10_000;
      while (!settingsWindow() && Date.now() < deadline) await sleep(100);
      if (!settingsWindow()) throw new Error('the Market Data window did not open');
    };
    result.steps.push(`phase ${phase}`);
    await reachTerminal();

    if (phase === 1) {
      await waitFor('prices start out simulated', badge('Simulated market'));
      await openSettingsFromBadge('Simulated market');
      await waitIn(settings, 'settings window shows the current source', `document.getElementById('current').textContent.startsWith('the practice market')`);

      await evaluateIn(settings(), `${field('key', process.env.GOMER_SELFTEST_KEY)}; ${field('secret', 'definitely-not-the-secret')}; document.getElementById('test').click()`);
      await waitIn(settings, 'wrong keys are rejected with an explanation', statusIs('bad', 'did not accept these keys'));
      await evaluateIn(settings(), `${field('secret', '')}; document.getElementById('save').click()`);
      await waitIn(settings, 'saving without a secret is refused', statusIs('bad', 'Enter both'));

      await evaluateIn(settings(), `${field('secret', process.env.GOMER_SELFTEST_SECRET)}; document.getElementById('test').click()`);
      await waitIn(settings, 'correct keys pass the connection test', statusIs('ok', 'Connected'));
      result.testMessage = await evaluateIn(settings(), `document.getElementById('status').textContent`);
      await capture('settings.png', settingsWindow());

      fs.writeFileSync(phaseFile, '2');
      fs.writeFileSync(path.join(directory, 'phase1.json'), JSON.stringify(result, null, 2));
      await evaluateIn(settings(), `document.getElementById('save').click()`);
      await waitIn(settings, 'keys are saved and the app restarts', statusIs('ok', 'Restarting with real prices'));
      return false;
    }

    if (phase === 2) {
      await waitFor('prices are real-time after the restart', badge('Real-time prices'));
      await waitFor('quotes are streaming from the provider', QUOTES_STREAMING);
      await sleep(2500);
      await capture('real-time.png');
      result.aapl = await evaluate(`[...document.querySelectorAll('tr[aria-selected]')].find((row) => row.textContent.startsWith('AAPL'))?.textContent`);

      await openSettingsFromBadge('Real-time prices');
      await waitIn(settings, 'settings window shows the saved key, masked', `/real prices from Alpaca \\(key .{2}….{4}\\)/.test(document.getElementById('current').textContent)`);
      result.secretFieldIsEmpty = (await evaluateIn(settings(), `document.getElementById('secret').value`)) === '';
      fs.writeFileSync(phaseFile, '3');
      fs.writeFileSync(path.join(directory, 'phase2.json'), JSON.stringify(result, null, 2));
      await evaluateIn(settings(), `document.getElementById('simulated').click()`);
      await waitIn(settings, 'switching back restarts the app', statusIs('ok', 'Restarting with simulated prices'));
      return false;
    }

    await waitFor('prices are simulated again after the second restart', badge('Simulated market'));
    await waitFor('simulated quotes are streaming', QUOTES_STREAMING);
    return true;
  }

  /**
   * The practice market's hours, through the real settings window.
   * Phase 1: it keeps exchange hours; set it to run around the clock (the app restarts).
   * Phase 2: prices move whatever the hour; set it back (the app restarts).
   * Phase 3: it keeps exchange hours again: open or closed as the US market is right now.
   */
  async function practiceHoursRun() {
    const phaseFile = path.join(directory, 'phase.txt');
    const phase = fs.existsSync(phaseFile) ? Number(fs.readFileSync(phaseFile, 'utf8')) : 1;
    const settings = () => settingsWindow().webContents;
    const statusIs = (kind, text) => `document.getElementById('status').className === 'status ${kind}' && document.getElementById('status').textContent.includes(${JSON.stringify(text)})`;
    const feedIs = (state) => `fetch('/health').then((r) => r.json()).then((h) => h.feed.state === ${JSON.stringify(state)})`;
    const openSettings = async () => {
      await evaluate(`[...document.querySelectorAll('header button')].find((b) => ['Market closed', 'Simulated market'].includes(b.textContent.trim())).click()`);
      const deadline = Date.now() + 10_000;
      while (!settingsWindow() && Date.now() < deadline) await sleep(100);
      if (!settingsWindow()) throw new Error('the Market Data window did not open');
    };
    const choose = (value) => `(() => { const s = document.getElementById('practice-hours'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return !document.getElementById('apply-hours').disabled; })()`;
    /** With exchange hours the screen has to agree with the calendar, whichever way it falls today. */
    const followsTheExchange = async (label) => {
      const hours = await evaluate(`fetch('/api/market/hours').then((r) => r.json())`);
      result.marketOpen = hours.open;
      if (hours.alwaysOpen) throw new Error('the server says its prices ignore market hours');
      await waitFor(`${label}: the feed is ${hours.open ? 'trading' : 'closed'}, as the US market is`, feedIs(hours.open ? 'streaming' : 'closed'));
      await waitFor(`${label}: the top bar says so`, badge(hours.open ? 'Simulated market' : 'Market closed'));
      if (!hours.open) {
        const quote = (symbol) => `[...document.querySelectorAll('tr[aria-selected]')].find((row) => row.textContent.startsWith('${symbol}'))?.textContent`;
        const before = await evaluate(quote('AAPL'));
        await sleep(3000);
        if (!before || before !== (await evaluate(quote('AAPL')))) throw new Error('prices moved while the market is closed');
        result.steps.push(`${label}: prices stand still`);
        await waitFor(`${label}: the ticket explains that market orders have to wait`, `document.querySelector('p[role="status"]')?.textContent.includes('The market is closed')`);
      }
    };
    result.steps.push(`phase ${phase}`);
    await reachTerminal();

    if (phase === 1) {
      await followsTheExchange('at first');
      await capture('exchange-hours.png');
      await openSettings();
      await waitIn(settings, 'settings window says the practice market keeps exchange hours', `document.getElementById('current').textContent.includes('keeping exchange hours')`);
      await waitIn(settings, 'the choice is offered, set to exchange hours, with nothing to apply yet', `!document.getElementById('practice').hidden && document.getElementById('practice-hours').value === 'exchange' && document.getElementById('apply-hours').disabled`);
      await waitIn(settings, 'the hours are shown in local time', `/\\d.+ to .+ your time/.test(document.getElementById('practice-hours').options[0].textContent)`, 8000);
      result.exchangeOption = await evaluateIn(settings(), `document.getElementById('practice-hours').options[0].textContent`);
      if (!(await evaluateIn(settings(), choose('always')))) throw new Error('Apply stayed disabled after choosing around the clock');
      await capture('settings-hours.png', settingsWindow());
      fs.writeFileSync(phaseFile, '2');
      fs.writeFileSync(path.join(directory, 'phase1.json'), JSON.stringify(result, null, 2));
      await evaluateIn(settings(), `document.getElementById('apply-hours').click()`);
      await waitIn(settings, 'the change is saved and the app restarts', statusIs('ok', 'never closes'));
      return false;
    }

    if (phase === 2) {
      await waitFor('around the clock: the feed is trading', feedIs('streaming'));
      await waitFor('around the clock: the top bar says simulated market', badge('Simulated market'));
      await waitFor('around the clock: quotes are streaming', QUOTES_STREAMING);
      if (!(await evaluate(`fetch('/api/market/hours').then((r) => r.json()).then((h) => h.alwaysOpen === true)`))) throw new Error('the server does not report running around the clock');
      await capture('around-the-clock.png');
      await openSettings();
      await waitIn(settings, 'settings window says it runs around the clock', `document.getElementById('current').textContent.includes('running around the clock') && document.getElementById('practice-hours').value === 'always'`);
      if (!(await evaluateIn(settings(), choose('exchange')))) throw new Error('Apply stayed disabled after choosing exchange hours');
      fs.writeFileSync(phaseFile, '3');
      fs.writeFileSync(path.join(directory, 'phase2.json'), JSON.stringify(result, null, 2));
      await evaluateIn(settings(), `document.getElementById('apply-hours').click()`);
      await waitIn(settings, 'switching back restarts the app', statusIs('ok', 'keeps exchange hours'));
      return false;
    }

    await followsTheExchange('after switching back');
    await capture('exchange-hours-again.png');
    return true;
  }

  let finished = true;
  try {
    if (mode === 'market-data') finished = await marketDataRun();
    else if (mode === 'practice-hours') finished = await practiceHoursRun();
    else await standardRun();
    result.ok = true;
  } catch (err) {
    result.error = String(err?.message ?? err);
    await capture('failure.png').catch(() => undefined);
  }
  // Mid-run restarts are triggered by the app itself; only a finished or failed run reports and quits.
  if (!finished && result.ok) return;
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  quit();
}
