# Jupiter Perps PDA Resolution

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md).

**Date:** 2025-12-03  
**Status:** Perpetuals Account Resolved ✅ | Position PDA Resolved ✅ | Transaction Building In Progress ⚠️

## ✅ Resolved Issues

### 1. Perpetuals Account Address
**Problem:** Perpetuals account was not found at derived PDA.  
**Solution:** Perpetuals account is a singleton, derived with seeds `[b"perpetuals"]` (NOT `[b"perpetuals", pool]`).

**Correct Derivation:**
```javascript
const seeds = [Buffer.from('perpetuals')];
const [perpetualsPDA, bump] = PublicKey.findProgramAddressSync(seeds, programId);
// Result: H4ND9aYttUVLFmNypZqLjZ52FYiGvdEB45GmwNoKEjTj
```

**Verification:**
- ✅ Account exists and is initialized
- ✅ Contains pool data
- ✅ Can be fetched successfully

### 2. Position PDA Derivation
**Problem:** Position PDA seeds were incorrect - missing `collateralCustody`.  
**Solution:** Position PDA includes `collateralCustody` in seeds.

**Correct Derivation:**
```javascript
const seeds = [
  Buffer.from('position'),
  owner.toBuffer(),
  pool.toBuffer(),
  custody.toBuffer(),
  collateralCustody.toBuffer(), // ← This was missing!
  sideBuffer, // 0 = long, 1 = short
];
```

**Verification:**
- ✅ Position PDA now matches program expectations
- ✅ Error changed from "ConstraintSeeds" to "writable privilege escalated"

## ⚠️ Current Issue

### Transaction Building: "Writable Privilege Escalated"

**Error:**
```
Cross-program invocation with unauthorized signer or writable account
"zMdzSEkiFFERUMTiA59A8SGQeaVMLVNBgm5biYByXga's writable privilege escalated"
```

**Root Cause:**
The position PDA is marked as writable, but when a PDA is writable in a cross-program invocation, the program needs to sign for it using the seeds. Our current instruction conversion from `@solana/kit` format to `@solana/web3.js` format may not be preserving PDA signing information.

**Possible Solutions:**

1. **Use @solana/kit Transaction Building**
   - The `jup-perps-client` uses `@solana/kit` which may handle PDAs automatically
   - Need to use `@solana/kit`'s transaction building instead of `@solana/web3.js` Transaction

2. **Add PDA Seeds to Transaction**
   - Include position PDA seeds in the transaction for program signing
   - Use `Transaction.partialSign()` or include seeds in instruction

3. **Check Instruction Account Roles**
   - Verify that position account is correctly marked as writable
   - Ensure program can sign for the PDA

## 📝 Implementation Status

### ✅ Working
- Perpetuals account derivation and fetching
- Position PDA derivation (with collateralCustody)
- Position Request PDA derivation
- Pool and custody data fetching
- Quote calculation
- Instruction building
- Transaction signing

### ⚠️ In Progress
- Transaction execution (PDA signing issue)

### 📋 Next Steps

1. **Research @solana/kit Transaction Building**
   - Check if we should use `@solana/kit`'s transaction methods
   - Look for examples of sending transactions with jup-perps-client

2. **Add PDA Seeds to Transaction**
   - Include position PDA seeds in transaction
   - Ensure program can sign for writable PDAs

3. **Test Transaction Execution**
   - Once PDA signing is resolved, test with smallest position
   - Verify transaction succeeds on-chain

## 🔍 Research Needed

- How to send transactions with `@solana/kit` and `jup-perps-client`
- How to handle PDA signing in cross-program invocations
- Examples of successful Jupiter Perps position opening transactions

## 📁 Files Modified

- `services/jupiterPerps.js` - Updated PDA derivations
- `test-query-perpetuals.js` - Created to find perpetuals account
- `docs/PERPS_PDA_RESOLUTION.md` - This file


