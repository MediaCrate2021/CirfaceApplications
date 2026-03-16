//-------------------------//
// logger.ts
// Code implemented by Cirface.com / MMG
//
// Structured logger for Migration Tool.
// Log level is driven by the LOG_LEVEL environment variable:
//   info  — production: auth events, migration events, errors
//   debug — staging: all of the above + every API request and full stack traces
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'migration-tool' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
