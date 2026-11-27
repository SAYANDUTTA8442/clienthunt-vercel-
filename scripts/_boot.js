'use strict';
/**
 * Shared start-up for CLI scripts. Loads .env.local / .env FIRST, then requires the script's own modules, and turns a
 * configuration problem into one readable line instead of a stack trace. Never prints values.
 */
require('../lib/env');

module.exports = function boot(modulePath) {
  try { return require(modulePath); }
  catch (e) {
    if (e && e.code === 'CLIENTHUNT_CONFIG') { console.error('Configuration error: ' + e.message); process.exit(1); }
    throw e;
  }
};
