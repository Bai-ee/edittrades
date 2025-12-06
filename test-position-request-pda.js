/**
 * Test Position Request PDA Derivation
 * Try different seed combinations to find the correct one
 */

import { PublicKey } from '@solana/web3.js';
import { getWallet } from './services/walletManager.js';
import 'dotenv/config';

const PERPETUALS_PROGRAM_ADDRESS = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';

// Expected PDA from error logs
const EXPECTED_PDA = 'Ek4ExHtNvqPXm3tsSnPbS6ySs9Gn9e4cYDXfTEmin5K3';

async function testPositionRequestPDAs() {
  try {
    console.log('🔍 Testing Position Request PDA Derivations...\n');
    
    const wallet = getWallet();
    const owner = wallet.publicKey;
    const pool = new PublicKey(JUPITER_PERPS_POOL);
    const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
    
    // For testing, we need a position PDA first
    // Let's use a dummy custody and collateral custody
    const custody = new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'); // SOL custody
    const collateralCustody = new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'); // USDC custody
    const side = 0; // long
    
    // Derive position PDA first
    const sideBuffer = Buffer.allocUnsafe(1);
    sideBuffer.writeUInt8(side, 0);
    const positionSeeds = [
      Buffer.from('position'),
      owner.toBuffer(),
      pool.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      sideBuffer,
    ];
    const [positionPDA] = PublicKey.findProgramAddressSync(positionSeeds, programId);
    console.log('Position PDA:', positionPDA.toBase58());
    console.log('Expected Position Request PDA:', EXPECTED_PDA);
    console.log('\n');
    
    // Get mint address (SOL mint for testing)
    const mint = new PublicKey('So11111111111111111111111111111111111111112');
    
    // Try different seed combinations
    const combinations = [
      {
        name: '[b"position_request", owner, counter]',
        seeds: [
          Buffer.from('position_request'),
          owner.toBuffer(),
          Buffer.allocUnsafe(8).fill(0), // counter = 0
        ],
      },
      {
        name: '[b"position_request", owner, pool, counter]',
        seeds: [
          Buffer.from('position_request'),
          owner.toBuffer(),
          pool.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", owner, pool, custody, counter]',
        seeds: [
          Buffer.from('position_request'),
          owner.toBuffer(),
          pool.toBuffer(),
          custody.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", owner, pool, custody, position, counter]',
        seeds: [
          Buffer.from('position_request'),
          owner.toBuffer(),
          pool.toBuffer(),
          custody.toBuffer(),
          positionPDA.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", owner, pool, custody, position, mint, counter]',
        seeds: [
          Buffer.from('position_request'),
          owner.toBuffer(),
          pool.toBuffer(),
          custody.toBuffer(),
          positionPDA.toBuffer(),
          mint.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", pool, custody, position, owner, counter]',
        seeds: [
          Buffer.from('position_request'),
          pool.toBuffer(),
          custody.toBuffer(),
          positionPDA.toBuffer(),
          owner.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", pool, owner, custody, position, counter]',
        seeds: [
          Buffer.from('position_request'),
          pool.toBuffer(),
          owner.toBuffer(),
          custody.toBuffer(),
          positionPDA.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", owner, position, pool, custody, counter]',
        seeds: [
          Buffer.from('position_request'),
          owner.toBuffer(),
          positionPDA.toBuffer(),
          pool.toBuffer(),
          custody.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", owner, pool, position, custody, counter]',
        seeds: [
          Buffer.from('position_request'),
          owner.toBuffer(),
          pool.toBuffer(),
          positionPDA.toBuffer(),
          custody.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
    ];
    
    for (const combo of combinations) {
      const [pda, bump] = PublicKey.findProgramAddressSync(combo.seeds, programId);
      const matches = pda.toBase58() === EXPECTED_PDA;
      console.log(`${matches ? '✅' : '❌'} ${combo.name}`);
      console.log(`   PDA: ${pda.toBase58()}`);
      console.log(`   Bump: ${bump}`);
      if (matches) {
        console.log('\n🎉 FOUND THE CORRECT SEEDS!');
        return combo;
      }
      console.log('');
    }
    
    console.log('❌ None of the combinations matched the expected PDA');
    return null;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

testPositionRequestPDAs().then(result => {
  if (result) {
    console.log('\n✅ Correct seed combination found!');
    process.exit(0);
  } else {
    console.log('\n❌ Could not find correct seed combination');
    process.exit(1);
  }
});

