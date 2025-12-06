/**
 * Query Jupiter Perpetuals Account
 * Attempts to find the perpetuals account address by querying on-chain
 */

import { createSolanaRpc } from '@solana/kit';
import { Connection, PublicKey } from '@solana/web3.js';
import jupPerpsClient from './services/jup-perps-wrapper.cjs';
const { fetchPerpetuals, PERPETUALS_PROGRAM_ADDRESS } = jupPerpsClient;
import 'dotenv/config';

const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';

async function queryPerpetualsAccount() {
  try {
    console.log('🔍 Querying Jupiter Perpetuals Account...\n');
    
    const rpc = createSolanaRpc(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
    );
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    
    const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
    console.log('Program ID:', programId.toBase58());
    
    // Method 1: Try the known address from README
    console.log('\n📋 Method 1: Trying known address from README...');
    const knownAddress = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG';
    try {
      const perpetuals = await fetchPerpetuals(rpc, knownAddress);
      console.log('✅ Found perpetuals account at known address!');
      console.log('   Address:', knownAddress);
      console.log('   Pools:', perpetuals.data.pools.length);
      console.log('   Admin:', perpetuals.data.admin);
      return knownAddress;
    } catch (error) {
      console.log('❌ Known address not found:', error.message);
    }
    
    // Method 2: Query all program accounts and find perpetuals account
    console.log('\n📋 Method 2: Querying all program accounts...');
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          dataSize: 200, // Approximate size of perpetuals account
        },
      ],
    });
    
    console.log(`Found ${accounts.length} program accounts`);
    
    // Try to identify perpetuals account by discriminator
    const PERPETUALS_DISCRIMINATOR = new Uint8Array([28, 167, 98, 191, 104, 82, 108, 196]);
    
    for (const account of accounts) {
      const data = account.account.data;
      if (data.length >= 8) {
        const discriminator = new Uint8Array(data.slice(0, 8));
        if (discriminator.every((byte, i) => byte === PERPETUALS_DISCRIMINATOR[i])) {
          console.log('✅ Found perpetuals account!');
          console.log('   Address:', account.pubkey.toBase58());
          
          // Try to fetch it properly
          try {
            const perpetuals = await fetchPerpetuals(rpc, account.pubkey.toBase58());
            console.log('   Pools:', perpetuals.data.pools.length);
            console.log('   Admin:', perpetuals.data.admin);
            return account.pubkey.toBase58();
          } catch (error) {
            console.log('   Error fetching:', error.message);
          }
        }
      }
    }
    
    // Method 3: Try deriving PDA with different seeds
    console.log('\n📋 Method 3: Trying different PDA derivations...');
    
    // Try [b"perpetuals"] without pool
    const seeds1 = [Buffer.from('perpetuals')];
    const [pda1, bump1] = PublicKey.findProgramAddressSync(seeds1, programId);
    console.log('   Trying [b"perpetuals"]:', pda1.toBase58());
    try {
      const perpetuals = await fetchPerpetuals(rpc, pda1.toBase58());
      console.log('   ✅ Found!');
      return pda1.toBase58();
    } catch (error) {
      console.log('   ❌ Not found');
    }
    
    // Try with pool
    const poolPubkey = new PublicKey(JUPITER_PERPS_POOL);
    const seeds2 = [Buffer.from('perpetuals'), poolPubkey.toBuffer()];
    const [pda2, bump2] = PublicKey.findProgramAddressSync(seeds2, programId);
    console.log('   Trying [b"perpetuals", pool]:', pda2.toBase58());
    try {
      const perpetuals = await fetchPerpetuals(rpc, pda2.toBase58());
      console.log('   ✅ Found!');
      return pda2.toBase58();
    } catch (error) {
      console.log('   ❌ Not found');
    }
    
    console.log('\n❌ Could not find perpetuals account');
    return null;
    
  } catch (error) {
    console.error('❌ Error querying perpetuals account:', error.message);
    console.error(error.stack);
    return null;
  }
}

queryPerpetualsAccount().then(address => {
  if (address) {
    console.log(`\n✅ Perpetuals account address: ${address}`);
    process.exit(0);
  } else {
    console.log('\n❌ Could not determine perpetuals account address');
    process.exit(1);
  }
});

