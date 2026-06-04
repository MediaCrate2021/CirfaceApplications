//-------------------------//
// packages/core/src/logger.ts
// Code implemented by Cirface.com / MMG
//
// Structured logger shared across Cirface tools.
// Log level is driven by the LOG_LEVEL environment variable:
//   info  — production: auth events, migration events, errors
//   debug — staging: all of the above + every API request and full stack traces
//-------------------------//

import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'cirface-tools' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
