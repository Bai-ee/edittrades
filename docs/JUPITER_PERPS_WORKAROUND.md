# Jupiter Perps Client Library Workaround

## Problem

The `jup-perps-client` npm package has ES module compatibility issues. The package uses directory imports (e.g., `import ... from '../types'`) which are not supported in Node.js ES modules. This prevents direct import of the package in our ESM codebase.

## Solution

We've implemented a two-part workaround:

### 1. CommonJS Wrapper

Created `services/jup-perps-wrapper.cjs` that uses CommonJS `require()` to import the patched package:

```javascript
const jupPerpsClient = require('jup-perps-client');
module.exports = jupPerpsClient;
```

### 2. Package Patching

Patched the `jup-perps-client` package to fix all directory imports by:

1. **Fixing index files** to use explicit `.js` extensions:
   - `dist/index.js`
   - `dist/accounts/index.js`
   - `dist/types/index.js`
   - `dist/instructions/index.js`
   - `dist/errors/index.js`
   - `dist/programs/index.js`
   - `dist/shared/index.js`

2. **Fixing cross-directory imports** in all `.js` files:
   - Changed `from '../types'` → `from '../types/index.js'`
   - Changed `from '../programs'` → `from '../programs/index.js'`
   - Changed `from '../errors'` → `from '../errors/index.js'`
   - Changed `from '../instructions'` → `from '../instructions/index.js'`
   - Changed `from '../accounts'` → `from '../accounts/index.js'`
   - Changed `from '../shared'` → `from '../shared/index.js'`

3. **Fixing same-directory imports**:
   - Changed `from '.'` → `from './index.js'` or specific file imports

## Usage

Import the wrapper in ESM modules:

```javascript
import jupPerpsClient from './jup-perps-wrapper.cjs';

const { fetchPool, fetchCustody, PERPETUALS_PROGRAM_ADDRESS } = jupPerpsClient;
```

## Important Notes

⚠️ **Warning**: These patches are applied directly to `node_modules/jup-perps-client`. They will be lost if you:
- Run `npm install` or `npm ci`
- Delete `node_modules`
- Update the package

### Maintaining the Patch

To preserve the patch, you have two options:

1. **Manual re-application**: Re-run the patching commands after each `npm install`
2. **Use patch-package** (recommended for production):
   ```bash
   npm install --save-dev patch-package
   npx patch-package jup-perps-client
   ```
   Then add to `package.json`:
   ```json
   "scripts": {
     "postinstall": "patch-package"
   }
   ```

## Testing

Run the test script to verify the workaround:

```bash
node test-perps-wrapper.js
```

Expected output:
- ✅ Wrapper imported successfully
- ✅ Pool and custody data fetching working
- ✅ Market discovery working
- ✅ Quote calculation working

## Status

✅ **Working**:
- Package import via CommonJS wrapper
- Pool and custody data fetching
- Market discovery
- Quote calculation
- Trade execution flow (structure)

⏳ **Pending**:
- Full transaction building (requires PDA derivation)
- Position opening/closing (requires instruction building)
- Stop loss/take profit (requires instruction building)

## Files Modified

- `services/jup-perps-wrapper.cjs` (NEW)
- `node_modules/jup-perps-client/dist/**/*.js` (PATCHED)

## Related Documentation

- `docs/JUPITER_PERPS_INTEGRATION_STATUS.md` - Integration status
- `docs/JUPITER_PERPETUALS_INTEGRATION.md` - Full integration guide


