import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.logLevel,
  redact: ['req.headers.authorization', 'password', 'token', '*.password', '*.token'],
  transport: config.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } },
});
