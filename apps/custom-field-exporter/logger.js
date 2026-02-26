//-------------------------//
// logger.js
// Code implemented by Cirface.com / MMG
//
// Structured logger for Custom Field Exporter.
// Log level is driven by the LOG_LEVEL environment variable:
//   info  — production: auth events, CSV exports, errors
//   debug — staging: all of the above + every API request and full stack traces
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Custom Field Explorer
// Last updated by: 2026FEB26 - LMR
//-------------------------//

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'custom-field-exporter' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
