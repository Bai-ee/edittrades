/**
 * Test Position Request PDA with different seed combinations
 * Based on Jupiter docs: derived from Position address + constant seeds + counter
 */

import { PublicKey } from '@solana/web3.js';
import { getWallet } from './services/walletManager.js';
import 'dotenv/config';

const PERPETUALS_PROGRAM_ADDRESS = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
const EXPECTED_PDA = 'Ek4ExHtNvqPXm3tsSnPbS6ySs9Gn9e4cYDXfTEmin5K3';

async function testPositionRequestSeeds() {
  try {
    console.log('🔍 Testing Position Request PDA Seeds...\n');
    
    const wallet = getWallet();
    const owner = wallet.publicKey;
    const pool = new PublicKey(JUPITER_PERPS_POOL);
    const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
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
    
    // Test different seed combinations based on docs
    const combinations = [
      {
        name: '[b"position_request", position, counter]',
        seeds: [
          Buffer.from('position_request'),
          positionPDA.toBuffer(),
          Buffer.allocUnsafe(8).fill(0), // counter = 0
        ],
      },
      {
        name: '[position, b"position_request", counter]',
        seeds: [
          positionPDA.toBuffer(),
          Buffer.from('position_request'),
          Buffer.allocUnsafe(8).fill(0),
        ],
      },
      {
        name: '[b"position_request", position, counter as u64]',
        seeds: [
          Buffer.from('position_request'),
          positionPDA.toBuffer(),
          Buffer.allocUnsafe(8).fill(0),
        ],
        counterFormat: 'u64',
      },
      {
        name: '[b"position_request", position, counter as u8]',
        seeds: [
          Buffer.from('position_request'),
          positionPDA.toBuffer(),
          Buffer.allocUnsafe(1).fill(0), // u8 instead of u64
        ],
      },
      {
        name: '[b"position_request", position, counter as u32]',
        seeds: [
          Buffer.from('position_request'),
          positionPDA.toBuffer(),
          Buffer.allocUnsafe(4).fill(0), // u32 instead of u64
        ],
      },
      {
        name: '[b"position_request", position, counter (big endian)]',
        seeds: [
          Buffer.from('position_request'),
          positionPDA.toBuffer(),
          (() => {
            const buf = Buffer.allocUnsafe(8);
            buf.writeBigUInt64BE(BigInt(0), 0);
            return buf;
          })(),
        ],
      },
      {
        name: '[b"position_request", position, counter (little endian)]',
        seeds: [
          Buffer.from('position_request'),
          positionPDA.toBuffer(),
          (() => {
            const buf = Buffer.allocUnsafe(8);
            buf.writeBigUInt64LE(BigInt(0), 0);
            return buf;
          })(),
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
    console.log('\n💡 Note: The position account might not exist yet for a new position.');
    console.log('   The program might derive the position request differently for new positions.');
    return null;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

testPositionRequestSeeds().then(result => {
  if (result) {
    console.log('\n✅ Correct seed combination found!');
    process.exit(0);
  } else {
    console.log('\n❌ Could not find correct seed combination');
    process.exit(1);
  }
});


