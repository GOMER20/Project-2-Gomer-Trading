import { logger } from '../lib/logger.js';
import { migrate } from './migrate.js';
import { pool } from './pool.js';

// Command-line entry: `npm run db:migrate`.
migrate()
  .then((applied) => {
    logger.info(applied.length ? `Migrations complete (${applied.length} applied)` : 'Database is up to date');
  })
  .catch((err) => {
    logger.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
