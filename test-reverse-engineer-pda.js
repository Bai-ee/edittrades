/**
 * Reverse-engineer Position Request PDA
 * We know the expected PDA: Ek4ExHtNvqPXm3tsSnPbS6ySs9Gn9e4cYDXfTEmin5K3
 * Let's try all possible seed combinations to find what produces it
 */

import { PublicKey } from '@solana/web3.js';
import { getWallet } from './services/walletManager.js';
import 'dotenv/config';

const PERPETUALS_PROGRAM_ADDRESS = 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu';
const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
const EXPECTED_PDA = 'Ek4ExHtNvqPXm3tsSnPbS6ySs9Gn9e4cYDXfTEmin5K3';

async function reverseEngineerPDA() {
  try {
    console.log('🔍 Reverse-engineering Position Request PDA...\n');
    console.log('Expected PDA:', EXPECTED_PDA);
    console.log('');
    
    const wallet = getWallet();
    const owner = wallet.publicKey;
    const pool = new PublicKey(JUPITER_PERPS_POOL);
    const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
    const custody = new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'); // SOL custody
    const collateralCustody = new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'); // USDC custody
    const side = 0; // long
    
    // Derive position PDA
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
    
    // Derive perpetuals PDA
    const [perpetualsPDA] = PublicKey.findProgramAddressSync([Buffer.from('perpetuals')], programId);
    
    console.log('Position PDA:', positionPDA.toBase58());
    console.log('Perpetuals PDA:', perpetualsPDA.toBase58());
    console.log('');
    
    // Try comprehensive seed combinations
    const combinations = [
      // With position
      { name: '[b"position_request", position, counter=0]', seeds: [Buffer.from('position_request'), positionPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", position, owner, counter=0]', seeds: [Buffer.from('position_request'), positionPDA.toBuffer(), owner.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", position, pool, counter=0]', seeds: [Buffer.from('position_request'), positionPDA.toBuffer(), pool.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", position, custody, counter=0]', seeds: [Buffer.from('position_request'), positionPDA.toBuffer(), custody.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", position, perpetuals, counter=0]', seeds: [Buffer.from('position_request'), positionPDA.toBuffer(), perpetualsPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      
      // With owner, pool, custody
      { name: '[b"position_request", owner, pool, custody, counter=0]', seeds: [Buffer.from('position_request'), owner.toBuffer(), pool.toBuffer(), custody.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", owner, pool, custody, position, counter=0]', seeds: [Buffer.from('position_request'), owner.toBuffer(), pool.toBuffer(), custody.toBuffer(), positionPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", owner, pool, custody, perpetuals, counter=0]', seeds: [Buffer.from('position_request'), owner.toBuffer(), pool.toBuffer(), custody.toBuffer(), perpetualsPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      
      // With perpetuals
      { name: '[b"position_request", perpetuals, pool, owner, position, counter=0]', seeds: [Buffer.from('position_request'), perpetualsPDA.toBuffer(), pool.toBuffer(), owner.toBuffer(), positionPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", perpetuals, owner, pool, position, counter=0]', seeds: [Buffer.from('position_request'), perpetualsPDA.toBuffer(), owner.toBuffer(), pool.toBuffer(), positionPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", perpetuals, pool, position, owner, counter=0]', seeds: [Buffer.from('position_request'), perpetualsPDA.toBuffer(), pool.toBuffer(), positionPDA.toBuffer(), owner.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      
      // Different orders
      { name: '[b"position_request", pool, owner, custody, position, counter=0]', seeds: [Buffer.from('position_request'), pool.toBuffer(), owner.toBuffer(), custody.toBuffer(), positionPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", pool, custody, owner, position, counter=0]', seeds: [Buffer.from('position_request'), pool.toBuffer(), custody.toBuffer(), owner.toBuffer(), positionPDA.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      
      // Without position (for new positions)
      { name: '[b"position_request", owner, pool, custody, collateralCustody, counter=0]', seeds: [Buffer.from('position_request'), owner.toBuffer(), pool.toBuffer(), custody.toBuffer(), collateralCustody.toBuffer(), Buffer.allocUnsafe(8).fill(0)] },
      { name: '[b"position_request", owner, pool, custody, collateralCustody, side, counter=0]', seeds: [Buffer.from('position_request'), owner.toBuffer(), pool.toBuffer(), custody.toBuffer(), collateralCustody.toBuffer(), sideBuffer, Buffer.allocUnsafe(8).fill(0)] },
    ];
    
    for (const combo of combinations) {
      const [pda, bump] = PublicKey.findProgramAddressSync(combo.seeds, programId);
      const matches = pda.toBase58() === EXPECTED_PDA;
      if (matches) {
        console.log(`\n🎉 FOUND IT!`);
        console.log(`✅ ${combo.name}`);
        console.log(`   PDA: ${pda.toBase58()}`);
        console.log(`   Bump: ${bump}`);
        return combo;
      }
    }
    
    console.log('❌ None of the combinations matched');
    console.log('\n💡 The program might be deriving it differently, or the account might be created by the program.');
    return null;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

reverseEngineerPDA().then(result => {
  if (result) {
    console.log('\n✅ Correct seed combination found!');
    process.exit(0);
  } else {
    console.log('\n❌ Could not reverse-engineer the PDA');
    process.exit(1);
  }
});


