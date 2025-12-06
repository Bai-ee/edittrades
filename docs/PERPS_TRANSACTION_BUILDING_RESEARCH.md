# Jupiter Perps Transaction Building Research

**Date:** 2025-12-03  
**Status:** Research Complete | Implementation In Progress

## Research Findings

### 1. @solana/kit Transaction Building

**Key Functions:**
- `createTransactionMessage({ version: 0 })` - Create base transaction
- `setTransactionMessageFeePayerSigner(signer, tx)` - Set fee payer
- `setTransactionMessageLifetimeUsingBlockhash(blockhash, tx)` - Set lifetime
- `appendTransactionMessageInstruction(instruction, tx)` - Add instruction
- `signTransactionMessageWithSigners(tx, signers)` - Sign transaction
- `sendAndConfirmTransactionFactory({ rpc })` - Send and confirm

**Transaction Flow:**
```javascript
const transactionMessage = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayerSigner(signer, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  (tx) => appendTransactionMessageInstruction(instruction, tx),
);

const signedTransaction = await signTransactionMessageWithSigners(transactionMessage, [signer]);
const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc });
const signature = await sendAndConfirmTransaction(signedTransaction);
```

### 2. Instruction Format from jup-perps-client

The instruction from `getCreateIncreasePositionMarketRequestInstruction` returns:
```javascript
{
  accounts: [
    { address: string, role: 'writable' | 'readonly' | 'writableSigner' | 'readonlySigner' },
    // ...
  ],
  programAddress: string,
  data: Uint8Array,
}
```

This format should be compatible with `@solana/kit`'s `appendTransactionMessageInstruction`.

### 3. TransactionSigner Interface

`@solana/kit` expects a `TransactionSigner` with:
- `address`: Address type
- `signTransactions(transactions: Uint8Array[]): Promise<Uint8Array[]>`
- `signMessage(message: Uint8Array): Promise<Uint8Array>`

**Keypair to Signer Adapter:**
```javascript
const walletSigner = {
  address: address(keypair.publicKey.toBase58()),
  async signTransactions(transactions) {
    return transactions.map(tx => {
      const message = Buffer.from(tx);
      const signature = keypair.sign(message);
      // Return signed transaction
      return signature;
    });
  },
  async signMessage(message) {
    const msgBuffer = Buffer.from(message);
    const signature = keypair.sign(msgBuffer);
    return signature;
  },
};
```

### 4. PDA Signing Issue

**Error:** "writable privilege escalated" for position PDA

**Root Cause:**
When a PDA is marked as writable in a cross-program invocation, the program needs to sign for it using the PDA seeds. The instruction builder from `jup-perps-client` should handle this automatically, but we need to ensure:
1. The instruction is used directly (not converted to @solana/web3.js format)
2. The transaction is built with @solana/kit (preserves PDA signing info)
3. The signer interface is correctly implemented

## Implementation Status

### ✅ Completed
- Research on @solana/kit transaction building
- Understanding of instruction format from jup-perps-client
- TransactionSigner interface requirements

### ⚠️ In Progress
- Creating proper Keypair to TransactionSigner adapter
- Testing transaction building with @solana/kit
- Resolving PDA signing issue

### 📋 Next Steps

1. **Fix Signer Adapter**
   - Ensure `signTransactions` returns properly signed transactions
   - Verify `signMessage` returns correct signature format
   - Test with @solana/kit transaction building

2. **Test Transaction Building**
   - Verify instruction format is compatible
   - Test transaction signing
   - Test transaction sending

3. **Resolve PDA Signing**
   - Ensure position PDA seeds are available for program signing
   - Verify instruction includes all necessary PDA information
   - Test transaction execution

## Resources

- [@solana/kit Documentation](https://www.solanakit.com/docs/getting-started/build-transaction)
- [Jupiter Perpetuals API](https://dev.jup.ag/docs/perp-api/)
- [jup-perps-client README](node_modules/jup-perps-client/README.md)


