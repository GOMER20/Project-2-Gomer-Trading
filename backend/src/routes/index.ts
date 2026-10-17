import { Router } from 'express';
import * as at from '../controllers/at.controller.js';
import * as auth from '../controllers/auth.controller.js';
import * as bots from '../controllers/bot.controller.js';
import * as competitions from '../controllers/competition.controller.js';
import * as hft from '../controllers/hft.controller.js';
import * as marketData from '../controllers/market.controller.js';
import * as orders from '../controllers/order.controller.js';
import * as portfolios from '../controllers/portfolio.controller.js';
import * as users from '../controllers/user.controller.js';
import { gatewayRouter } from '../gateway/rest.js';
import { requireAuth, requireOwner, requireRole } from '../middleware/auth.js';
import { inviteLimiter, loginAddressLimiter, loginLimiter, orderLimiter, passwordLimiter, signUpLimiter } from '../middleware/rateLimit.js';
import { riskCheck } from '../middleware/risk.js';

const admin = requireRole('ADMIN');

const authRoutes = Router()
  .post('/login', loginAddressLimiter, loginLimiter, auth.login)
  .post('/join', inviteLimiter, signUpLimiter, auth.join)
  .post('/desktop', auth.desktopSignIn)
  .put('/password', requireAuth, passwordLimiter, auth.changePassword)
  .get('/me', requireAuth, auth.me);

const userRoutes = Router()
  .use(requireAuth, admin)
  .get('/', users.listUsers)
  .post('/', users.createUser)
  .put('/:id/password', users.resetPassword)
  .put('/:id/active', users.setActive);

/** Trading programs: who may connect through the bot gateway, and which sandbox each trades in. */
const botRoutes = Router()
  .use(requireAuth, admin)
  .get('/', bots.list)
  .post('/', bots.create)
  .put('/:id', bots.update)
  .post('/:id/rotate', bots.rotate)
  .delete('/:id', bots.remove);

const competitionRoutes = Router()
  .use(requireAuth)
  .get('/', competitions.list)
  .post('/', admin, competitions.create)
  .get('/:id', competitions.get)
  .get('/:id/leaderboard', competitions.leaderboard)
  .get('/:id/results', competitions.results)
  .put('/:id/invite', admin, competitions.setInvite)
  .put('/:id/balance', requireOwner, competitions.setBalance)
  .get('/:id/participants', admin, competitions.listParticipants)
  .post('/:id/participants', admin, competitions.addParticipants);

const inviteRoutes = Router()
  .get('/:code', inviteLimiter, competitions.invitePreview)
  .post('/:code/join', inviteLimiter, requireAuth, competitions.joinWithCode);

const portfolioRoutes = Router()
  .use(requireAuth)
  .get('/:competitionId', portfolios.getPortfolio)
  .get('/:competitionId/positions', portfolios.getPositions)
  .get('/:competitionId/orders', portfolios.getOrders)
  .get('/:competitionId/executions', portfolios.getExecutions);

const orderRoutes = Router()
  .use(requireAuth)
  // auth -> throttle -> risk gate -> matching engine
  .post('/', orderLimiter, riskCheck, orders.placeOrder)
  .delete('/:id', orders.cancelOrder);

const marketRoutes = Router()
  .use(requireAuth)
  .get('/symbols', marketData.symbols)
  .get('/quote/:symbol', marketData.quote)
  .get('/depth/:symbol', marketData.depth)
  .get('/bars/:symbol', marketData.bars);

export const apiRouter = Router()
  .use('/auth', authRoutes)
  .use('/users', userRoutes)
  .use('/bots', botRoutes)
  // HFT, the order book engine running beside the exchange in test mode, and AT, the trading
  // algorithm: their windows, for the people the exchange belongs to.
  .get('/hft', requireAuth, requireOwner, hft.status)
  .get('/hft/sessions', requireAuth, requireOwner, hft.sessions)
  .get('/hft/strategy', requireAuth, requireOwner, hft.strategy)
  .post('/hft/strategy/kill', requireAuth, requireOwner, hft.killStrategy)
  .get('/at', requireAuth, requireOwner, at.dashboard)
  // One account's starting money, without touching anyone else in its competition.
  .put('/accounts/:portfolioId/balance', requireAuth, requireOwner, competitions.setAccountBalance)
  // Trading programs sign in with an API key, not a session.
  .use('/gateway/v1', gatewayRouter)
  .use('/competitions', competitionRoutes)
  .use('/invites', inviteRoutes)
  // Public: market hours are the same for everyone and need no account.
  .get('/market/hours', marketData.hours)
  .use('/portfolios', portfolioRoutes)
  .use('/orders', orderRoutes)
  .use('/market', marketRoutes);
