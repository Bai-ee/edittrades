/**
 * Query Position Request Account On-Chain
 * Try to find an existing position request and inspect its structure
 */

import { createSolanaRpc } from '@solana/kit';
import { Connection, PublicKey } from '@solana/web3.js';
import jupPerpsClient from './services/jup-perps-wrapper.cjs';
import 'dotenv/config';

const { fetchPositionRequest, PERPETUALS_PROGRAM_ADDRESS } = jupPerpsClient;
const EXPECTED_PDA = 'Ek4ExHtNvqPXm3tsSnPbS6ySs9Gn9e4cYDXfTEmin5K3';

async function queryPositionRequest() {
  try {
    console.log('🔍 Querying Position Request Account...\n');
    
    const rpc = createSolanaRpc(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
    );
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    
    const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
    
    // Try to fetch the expected PDA
    console.log('📋 Trying to fetch expected PDA:', EXPECTED_PDA);
    try {
      const positionRequest = await fetchPositionRequest(rpc, EXPECTED_PDA);
      console.log('✅ Found position request account!');
      console.log('   Owner:', positionRequest.data.owner);
      console.log('   Pool:', positionRequest.data.pool);
      console.log('   Custody:', positionRequest.data.custody);
      console.log('   Position:', positionRequest.data.position);
      console.log('   Mint:', positionRequest.data.mint);
      console.log('   Counter (from data):', positionRequest.data.sizeUsdDelta?.toString() || 'N/A');
      
      // Now we can derive the PDA using the actual account data
      const owner = new PublicKey(positionRequest.data.owner);
      const pool = new PublicKey(positionRequest.data.pool);
      const custody = new PublicKey(positionRequest.data.custody);
      const position = new PublicKey(positionRequest.data.position);
      
      console.log('\n🔍 Testing derivation with actual account data...');
      
      // Try different seed combinations with actual data
      const testSeeds = [
        {
          name: '[b"position_request", owner, pool, custody, position, counter=0]',
          seeds: [
            Buffer.from('position_request'),
            owner.toBuffer(),
            pool.toBuffer(),
            custody.toBuffer(),
            position.toBuffer(),
            Buffer.allocUnsafe(8).fill(0),
          ],
        },
        {
          name: '[b"position_request", pool, custody, position, owner, counter=0]',
          seeds: [
            Buffer.from('position_request'),
            pool.toBuffer(),
            custody.toBuffer(),
            position.toBuffer(),
            owner.toBuffer(),
            Buffer.allocUnsafe(8).fill(0),
          ],
        },
      ];
      
      for (const test of testSeeds) {
        const [pda, bump] = PublicKey.findProgramAddressSync(test.seeds, programId);
        const matches = pda.toBase58() === EXPECTED_PDA;
        console.log(`${matches ? '✅' : '❌'} ${test.name}`);
        console.log(`   Derived: ${pda.toBase58()}`);
        if (matches) {
          console.log('\n🎉 FOUND THE CORRECT SEEDS!');
          return test;
        }
      }
      
    } catch (error) {
      console.log('❌ Could not fetch position request:', error.message);
    }
    
    // Alternative: Query all position request accounts
    console.log('\n📋 Querying all position request accounts...');
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          dataSize: 200, // Approximate size
        },
      ],
    });
    
    console.log(`Found ${accounts.length} program accounts`);
    
    // Try to identify position request accounts by discriminator
    // Position request discriminator: [12, 38, 250, 199, 46, 154, 32, 216]
    const POSITION_REQUEST_DISCRIMINATOR = new Uint8Array([12, 38, 250, 199, 46, 154, 32, 216]);
    
    for (const account of accounts.slice(0, 10)) { // Check first 10
      const data = account.account.data;
      if (data.length >= 8) {
        const discriminator = new Uint8Array(data.slice(0, 8));
        if (discriminator.every((byte, i) => byte === POSITION_REQUEST_DISCRIMINATOR[i])) {
          console.log('\n✅ Found position request account!');
          console.log('   Address:', account.pubkey.toBase58());
          
          try {
            const positionRequest = await fetchPositionRequest(rpc, account.pubkey.toBase58());
            console.log('   Owner:', positionRequest.data.owner);
            console.log('   Pool:', positionRequest.data.pool);
            console.log('   Custody:', positionRequest.data.custody);
            console.log('   Position:', positionRequest.data.position);
            
            // Try to derive PDA
            const owner = new PublicKey(positionRequest.data.owner);
            const pool = new PublicKey(positionRequest.data.pool);
            const custody = new PublicKey(positionRequest.data.custody);
            const position = new PublicKey(positionRequest.data.position);
            
            const seeds = [
              Buffer.from('position_request'),
              owner.toBuffer(),
              pool.toBuffer(),
              custody.toBuffer(),
              position.toBuffer(),
              Buffer.allocUnsafe(8).fill(0),
            ];
            const [derivedPDA] = PublicKey.findProgramAddressSync(seeds, programId);
            console.log('   Derived PDA:', derivedPDA.toBase58());
            console.log('   Matches:', derivedPDA.toBase58() === account.pubkey.toBase58());
            
            if (derivedPDA.toBase58() === account.pubkey.toBase58()) {
              console.log('\n🎉 FOUND THE CORRECT SEEDS!');
              return { seeds, account: account.pubkey.toBase58() };
            }
          } catch (error) {
            console.log('   Error fetching:', error.message);
          }
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    return null;
  }
}

queryPositionRequest().then(result => {
  if (result) {
    console.log('\n✅ Position request PDA derivation found!');
    process.exit(0);
  } else {
    console.log('\n❌ Could not determine position request PDA derivation');
    process.exit(1);
  }
});


