/**
 * CommonJS Wrapper for jup-perps-client
 * 
 * This wrapper imports the patched package which has fixed directory imports.
 * The package has been patched to use explicit .js file extensions.
 */

// Import from the patched package
const jupPerpsClient = require('jup-perps-client');

// Re-export everything
module.exports = jupPerpsClient;

