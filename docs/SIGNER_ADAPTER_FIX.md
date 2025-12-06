# Signer Adapter Fix for @solana/kit

**Date:** 2025-12-03  
**Status:** Signer Adapter Implemented ✅ | Signature Attachment Issue ⚠️

## Research Findings

### 1. TransactionMessage Structure
- `@solana/kit`'s `signTransactionMessageWithSigners` receives `TransactionMessage` objects
- `TransactionMessage` has a `messageBytes` property containing the serialized transaction (Uint8Array)
- This is what needs to be signed

### 2. Keypair Signing
- `@solana/web3.js` Keypair doesn't expose a direct `sign()` method
- Keypair uses `tweetnacl` internally for signing
- We need to use `nacl.sign.detached(message, secretKey)` directly

### 3. Signer Adapter Implementation

**Correct Implementation:**
```javascript
import nacl from 'tweetnacl';

const walletSigner = {
  address: address(wallet.publicKey.toBase58()),
  async signTransactions(transactions) {
    // transactions is an array of TransactionMessage objects
    return transactions.map(tx => {
      // TransactionMessage has 'messageBytes' property
      const messageBytes = tx.messageBytes || tx;
      const message = Buffer.from(messageBytes);
      // Use nacl to sign (same as @solana/web3.js Keypair uses internally)
      const signature = nacl.sign.detached(message, wallet.secretKey);
      // Return signature as Uint8Array
      return signature;
    });
  },
  async signMessage(message) {
    // message is Uint8Array
    const msgBuffer = Buffer.from(message);
    // Use nacl to sign
    const signature = nacl.sign.detached(msgBuffer, wallet.secretKey);
    return signature;
  },
};
```

### 4. Current Issue

**Error:** "Transaction is missing signatures for addresses"

**Status:** 
- ✅ Signing works (signature is created)
- ⚠️ Signature attachment needs verification
- The error suggests the signature format might need adjustment

## Next Steps

1. **Verify Signature Format**
   - Check if signature needs to be in a specific format
   - Verify TransactionMessage signature attachment process

2. **Test with Actual Instruction**
   - Test with the Jupiter Perps instruction
   - Verify PDA signing is preserved

3. **Final Integration**
   - Update `services/jupiterPerps.js` with working signer
   - Test full transaction flow

## Files Modified

- `services/jupiterPerps.js` - Updated signer adapter
- `test-simple-transaction.js` - Created test for signer adapter
- `docs/SIGNER_ADAPTER_FIX.md` - This file


