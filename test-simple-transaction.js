/**
 * Test Simple Transaction with @solana/kit
 * Tests basic transaction building and signing to verify signer adapter works
 */

import { 
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  pipe,
  address,
} from '@solana/kit';
import { getWallet } from './services/walletManager.js';
import nacl from 'tweetnacl';
import 'dotenv/config';

async function testSimpleTransaction() {
  try {
    console.log('🧪 Testing Simple Transaction with @solana/kit...\n');
    
    const wallet = getWallet();
    const rpc = createSolanaRpc(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
    );
    
    console.log('📝 Wallet Address:', wallet.publicKey.toBase58());
    
    // Create a signer adapter from Keypair
    // @solana/kit expects signTransactions to return SignatureDictionary[]
    // SignatureDictionary is Record<Address, SignatureBytes> - an object mapping addresses to signatures
    const walletAddress = address(wallet.publicKey.toBase58());
    const walletSigner = {
      address: walletAddress,
      async signTransactions(transactions) {
        console.log('   Signing', transactions.length, 'transaction(s)...');
        return transactions.map(tx => {
          // TransactionMessage has 'messageBytes' property
          const messageBytes = tx.messageBytes || tx;
          const message = Buffer.from(messageBytes);
          // @solana/web3.js Keypair uses nacl.sign.detached for signing
          const signature = nacl.sign.detached(message, wallet.secretKey);
          // Return SignatureDictionary: { [address]: signatureBytes }
          // This is what @solana/kit expects - an object mapping addresses to signatures
          return {
            [walletAddress]: signature
          };
        });
      },
      async signMessage(message) {
        // message is Uint8Array
        const msgBuffer = Buffer.from(message);
        // Use nacl for signing
        const signature = nacl.sign.detached(msgBuffer, wallet.secretKey);
        // signMessage also returns SignatureDictionary
        return {
          [walletAddress]: signature
        };
      },
    };
    
    console.log('✅ Signer adapter created');
    
    // Get latest blockhash
    console.log('\n📡 Fetching latest blockhash...');
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    console.log('✅ Blockhash:', latestBlockhash.blockhash.slice(0, 16) + '...');
    
    // Build a minimal transaction message (no instructions - just testing the structure)
    console.log('\n🔨 Building transaction message...');
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => {
        console.log('   - Created base transaction');
        return tx;
      },
      (tx) => {
        const txWithFeePayer = setTransactionMessageFeePayerSigner(walletSigner, tx);
        console.log('   - Set fee payer');
        return txWithFeePayer;
      },
      (tx) => {
        const txWithLifetime = setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx);
        console.log('   - Set transaction lifetime');
        return txWithLifetime;
      },
    );
    
    console.log('✅ Transaction message built');
    
    // Sign transaction
    console.log('\n✍️  Signing transaction...');
    try {
      const signedTransaction = await signTransactionMessageWithSigners(transactionMessage, [walletSigner]);
      console.log('✅ Transaction signed successfully!');
      console.log('   Signer adapter works correctly with @solana/kit');
    } catch (signError) {
      console.error('❌ Signing failed:', signError.message);
      console.error('   This indicates the signer adapter needs adjustment');
      throw signError;
    }
    
    console.log('\n✅ Simple transaction test completed successfully!');
    console.log('   The signer adapter works correctly with @solana/kit');
    
    return true;
  } catch (error) {
    console.error('\n❌ Simple transaction test failed:');
    console.error('   Error:', error.message);
    if (error.stack) {
      console.error('   Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
    }
    return false;
  }
}

testSimpleTransaction().then(success => {
  process.exit(success ? 0 : 1);
});

