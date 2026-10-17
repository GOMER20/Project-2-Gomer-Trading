// Wires the Market Data settings form. This runs in the sandboxed preload
// world: it can touch the page's DOM and talk to the main process, and the
// page itself runs no script at all.
const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);
  const fields = { key: $('key'), secret: $('secret'), feed: $('feed') };
  const buttons = [$('test'), $('save'), $('simulated'), $('cancel'), $('apply-hours')];
  const practiceHours = $('practice-hours');
  const status = $('status');

  const show = (kind, text) => {
    status.className = `status ${kind}`;
    status.textContent = text;
  };
  const input = () => ({ key: fields.key.value, secret: fields.secret.value, feed: fields.feed.value, practiceHours: practiceHours.value });
  /** Runs one request with the buttons disabled; returns its { ok, message } result. */
  const run = async (channel, busyText) => {
    buttons.forEach((button) => (button.disabled = true));
    show('busy', busyText);
    try {
      const result = await ipcRenderer.invoke(channel, input());
      show(result.ok ? 'ok' : 'bad', result.message);
      return result;
    } catch (err) {
      show('bad', 'Something went wrong. Please try again.');
      return { ok: false };
    } finally {
      buttons.forEach((button) => (button.disabled = false));
    }
  };

  const current = await ipcRenderer.invoke('gomer:settings:get');
  $('current').textContent = current.connected
    ? `real prices from Alpaca (key ${current.keyHint})`
    : `the practice market, ${current.practiceHours === 'always' ? 'running around the clock' : 'keeping exchange hours'}`;
  // The practice market's hours only matter while it is the source of prices.
  $('practice').hidden = current.connected;
  practiceHours.value = current.practiceHours;
  const hoursChanged = () => practiceHours.value !== current.practiceHours;
  $('apply-hours').disabled = true;
  practiceHours.addEventListener('change', () => ($('apply-hours').disabled = !hoursChanged()));
  $('apply-hours').addEventListener('click', async () => {
    await run('gomer:settings:practice-hours', 'Changing the practice market…');
    $('apply-hours').disabled = !hoursChanged();
  });
  fields.key.value = current.key;
  fields.feed.value = current.feed;
  // The saved secret is never sent to this page; an empty field means "keep it".
  if (current.connected) fields.secret.placeholder = 'saved — leave empty to keep it';
  $('simulated').hidden = !current.connected;

  // Market hours in this Mac's own time zone; the New York wording stays if they cannot be fetched.
  ipcRenderer.invoke('gomer:settings:hours').then((hours) => {
    if (hours) practiceHours.options[0].textContent = `Real exchange hours: ${hours.range} your time`;
    if (hours) $('hours').textContent = `US stocks trade ${hours.range} your time on weekdays (9:30 am to 4:00 pm in New York). The next session is ${hours.next}. Outside those hours you will see the last session's prices.`;
  });

  $('test').addEventListener('click', () => void run('gomer:settings:test', 'Contacting Alpaca…'));
  $('form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run('gomer:settings:save', 'Checking the keys…');
  });
  $('simulated').addEventListener('click', () => void run('gomer:settings:clear', 'Switching to simulated prices…'));
  $('cancel').addEventListener('click', () => ipcRenderer.send('gomer:settings:close'));
  $('open-alpaca').addEventListener('click', () => ipcRenderer.send('gomer:settings:open-alpaca'));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ipcRenderer.send('gomer:settings:close');
  });
  fields.key.focus();
});
