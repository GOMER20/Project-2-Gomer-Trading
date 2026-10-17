/**
 * A bot for the standard gateway: JSON over WebSocket. Needs Node.js 22 or
 * newer and nothing else.
 *
 * A tiny market maker: it keeps one buy order a few cents under the best bid
 * and one sell order a few cents over the best ask, replaces them as the
 * market moves, and prints every execution report. It stops after 20 seconds
 * and flattens whatever it is left holding.
 *
 *   GOMER_API_KEY=gtk_... node ws_bot.mjs ws://localhost:4000/gateway AAPL
 *   GOMER_API_KEY=gtk_... node ws_bot.mjs wss://your-address.example/gateway AAPL
 */
const [url = 'ws://localhost:4000/gateway', symbol = 'AAPL'] = process.argv.slice(2);
const apiKey = process.env.GOMER_API_KEY;
if (!apiKey) throw new Error('Set GOMER_API_KEY to the key from the Admin console.');

const EDGE = 0.03; // how far from the touch to quote, in dollars
const SIZE = 10;
const cents = (value) => Math.round(value * 100) / 100;

const socket = new WebSocket(url);
const send = (message) => socket.send(JSON.stringify(message));
let nextId = 1;
let position = 0;
/** side -> { clOrdId, price } for the quote currently working on that side */
const quotes = { BUY: null, SELL: null };

function quote(side, price) {
  const working = quotes[side];
  if (working?.price === price) return; // already there
  if (working) send({ op: 'order.cancel', clOrdId: working.clOrdId });
  const clOrdId = `mm-${Date.now()}-${nextId++}`;
  quotes[side] = { clOrdId, price };
  send({ op: 'order.new', clOrdId, symbol, side, type: 'LIMIT', tif: 'GTC', qty: SIZE, price });
}

socket.addEventListener('open', () => send({ op: 'logon', apiKey }));
socket.addEventListener('close', (event) => console.log(`disconnected (${event.reason || event.code})`));
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  switch (message.op) {
    case 'logon.ack':
      console.log(`logged on as ${message.traderId} in "${message.competition.name}", ${message.limits.ordersPerSecond} orders a second`);
      send({ op: 'subscribe', channels: ['bbo'], symbols: [symbol] });
      setTimeout(finish, 20_000);
      break;
    case 'bbo':
      if (finishing) break;
      quote('BUY', cents(message.b - EDGE));
      quote('SELL', cents(message.a + EDGE));
      break;
    case 'exec':
      if (message.lastQty > 0) {
        position += message.side === 'BUY' ? message.lastQty : -message.lastQty;
        console.log(`${message.execType}: ${message.side} ${message.lastQty} ${message.symbol} @ ${message.lastPx}  (position ${position})`);
        // That quote is spent; the next market update replaces it.
        if (message.ordStatus === 'FILLED' && quotes[message.side]?.clOrdId === message.clOrdId) quotes[message.side] = null;
      }
      if (finishing && message.clOrdId === 'flatten' && message.ordStatus !== 'NEW') socket.close();
      break;
    case 'reject':
      // Expected now and then: cancelling a quote that filled a moment earlier is "too late to cancel".
      if (message.code !== 'TOO_LATE_TO_CANCEL') console.log(`rejected (${message.code}): ${message.text}`);
      if (message.ref === 'order.new') for (const side of ['BUY', 'SELL']) if (quotes[side]?.clOrdId === message.clOrdId) quotes[side] = null;
      break;
  }
});

let finishing = false;
function finish() {
  finishing = true;
  for (const side of ['BUY', 'SELL']) if (quotes[side]) send({ op: 'order.cancel', clOrdId: quotes[side].clOrdId });
  if (position === 0) return socket.close();
  console.log(`flattening ${position} shares`);
  send({ op: 'order.new', clOrdId: 'flatten', symbol, side: position > 0 ? 'SELL' : 'BUY', type: 'MARKET', tif: 'IOC', qty: Math.abs(position) });
}
