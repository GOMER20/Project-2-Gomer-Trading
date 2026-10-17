import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const tooMany = (message: string) => ({ error: { code: 'RATE_LIMITED', message } });

const isLoopback = (ip: string | undefined) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/**
 * Slows password guessing against one account: ten wrong passwords for the
 * same trader ID from the same address, then a fifteen-minute wait.
 *
 * Keyed on the trader ID as well as the address on purpose. A whole class or
 * office shares one address, and when a competition opens they all sign in at
 * once; limiting by address alone would lock most of them out.
 */
/** Only a rejected password counts as a failed attempt; "busy" answers and server faults do not. */
const wrongPassword = (_req: unknown, res: { statusCode: number }) => res.statusCode !== 401;

export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: wrongPassword,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${String((req.body as { traderId?: unknown } | undefined)?.traderId ?? '').trim().toUpperCase().slice(0, 64)}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany('Too many failed login attempts for this trader ID. Try again in a few minutes.'),
});

/** Stops one address from guessing its way through many accounts. */
export const loginAddressLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 1000,
  skipSuccessfulRequests: true,
  requestWasSuccessful: wrongPassword,
  skip: (req) => isLoopback(req.ip),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany('Too many failed login attempts from this address. Try again in a few minutes.'),
});

/** Accounts one address may create through invite codes. The desktop app's own window is exempt. */
export const signUpLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 40,
  skip: (req) => isLoopback(req.ip),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany('Too many accounts created from this address. Try again later.'),
});

/** Looking up invite codes; tight enough that codes cannot be guessed. */
export const inviteLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  skip: (req) => isLoopback(req.ip),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany('Too many invite codes tried from this address. Try again in a few minutes.'),
});

/**
 * Coarse shield for the whole API. Generous enough for a room full of traders
 * behind one address, low enough to stop a runaway script from monopolising the server.
 */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 6000,
  // Callers on this machine are the desktop app itself or a local reverse proxy.
  // Counting them as one address would throttle every trader together.
  skip: (req) => isLoopback(req.ip),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany('Too many requests from this address. Slow down and try again shortly.'),
});

/** Per-trader order throttle; applied after authentication so it can key on the user. */
/** Guessing the current password through the change-password form is as limited as guessing it at sign-in. */
export const passwordLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? 'anonymous',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

export const orderLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (req) => req.user?.id ?? 'anonymous',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany('Order rate limit reached (120 per minute).'),
});
