import { config } from '../config.js';
import { engine } from '../engine/matchingEngine.js';
import { logger } from '../lib/logger.js';
import { market } from '../market/marketData.js';
import { marketHours } from '../market/usMarketHours.js';
import { HftMirror } from './hftMirror.js';

/** HFT, running beside this server in test mode: see hftMirror.ts. */
export const hft = new HftMirror({
  mode: config.hft.mode,
  binary: config.hft.binary,
  dataDir: config.hft.dataDir,
  recordLimitMb: config.hft.recordLimitMb,
  keepSessions: config.hft.keepSessions,
  market,
  engine,
  symbols: config.marketData.defaultSymbols,
  // Each US market session is a session of its own in HFT.
  marketSession: () => {
    const hours = marketHours();
    return hours.open ? hours.session.date : null;
  },
  log: {
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  },
});
