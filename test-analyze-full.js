/**
 * Test script to verify what analyze-full API actually returns
 * Run: node test-analyze-full.js
 */

// Use built-in fetch (Node 18+) or node-fetch
const fetch = globalThis.fetch || (await import('node-fetch')).default;

const API_URL = 'http://localhost:3000/api/analyze-full';
const SYMBOL = 'BTCUSDT';
const MODE = 'STANDARD';

async function testAnalyzeFull() {
  try {
    console.log('🧪 Testing analyze-full API...');
    console.log(`📡 URL: ${API_URL}?symbol=${SYMBOL}&mode=${MODE}\n`);

    const response = await fetch(`${API_URL}?symbol=${SYMBOL}&mode=${MODE}`);
    
    if (!response.ok) {
      console.error(`❌ API Error: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error('Error details:', errorText);
      return;
    }

    const data = await response.json();
    
    console.log('✅ API Response received\n');
    console.log('📊 Top-level keys:', Object.keys(data));
    console.log('\n🔍 Checking analysis object...');
    
    if (data.analysis) {
      console.log('✅ analysis object exists');
      console.log('   Analysis keys:', Object.keys(data.analysis));
      
      // Check first timeframe
      const firstTf = Object.keys(data.analysis)[0];
      if (firstTf) {
        console.log(`\n📈 Sample timeframe: ${firstTf}`);
        const tfData = data.analysis[firstTf];
        console.log('   Timeframe keys:', Object.keys(tfData || {}));
        
        // Check for advanced modules
        console.log('\n🔬 Advanced Modules Check:');
        console.log(`   marketStructure: ${tfData?.marketStructure ? '✅ PRESENT' : '❌ MISSING'}`);
        console.log(`   volatility: ${tfData?.volatility ? '✅ PRESENT' : '❌ MISSING'}`);
        console.log(`   volumeProfile: ${tfData?.volumeProfile ? '✅ PRESENT' : '❌ MISSING'}`);
        console.log(`   liquidityZones: ${tfData?.liquidityZones ? '✅ PRESENT' : '❌ MISSING'}`);
        console.log(`   fairValueGaps: ${tfData?.fairValueGaps ? '✅ PRESENT' : '❌ MISSING'}`);
        console.log(`   divergences: ${tfData?.divergences ? '✅ PRESENT' : '❌ MISSING'}`);
        
        // Show what IS present
        console.log('\n📋 What IS present:');
        if (tfData?.indicators) {
          console.log('   ✅ indicators:', Object.keys(tfData.indicators));
        }
        if (tfData?.structure) {
          console.log('   ✅ structure:', Object.keys(tfData.structure));
        }
      }
    } else {
      console.log('❌ analysis object MISSING');
    }
    
    // Check timeframes summary
    console.log('\n📊 Checking timeframes summary...');
    if (data.timeframes) {
      console.log('✅ timeframes summary exists');
      const firstTfSummary = Object.keys(data.timeframes)[0];
      if (firstTfSummary) {
        console.log(`   Sample timeframe (${firstTfSummary}) keys:`, Object.keys(data.timeframes[firstTfSummary]));
      }
    } else {
      console.log('❌ timeframes summary MISSING');
    }
    
    // Save sample to file for inspection
    const fs = await import('fs');
    const sampleData = {
      topLevelKeys: Object.keys(data),
      analysisKeys: data.analysis ? Object.keys(data.analysis) : [],
      sampleTimeframe: firstTf ? {
        keys: Object.keys(data.analysis[firstTf]),
        hasMarketStructure: !!data.analysis[firstTf]?.marketStructure,
        hasVolatility: !!data.analysis[firstTf]?.volatility,
        hasVolumeProfile: !!data.analysis[firstTf]?.volumeProfile,
        hasLiquidityZones: !!data.analysis[firstTf]?.liquidityZones,
        hasFairValueGaps: !!data.analysis[firstTf]?.fairValueGaps,
        hasDivergences: !!data.analysis[firstTf]?.divergences,
        actualKeys: Object.keys(data.analysis[firstTf] || {})
      } : null
    };
    
    fs.writeFileSync('test-api-output.json', JSON.stringify(sampleData, null, 2));
    console.log('\n💾 Sample structure saved to test-api-output.json');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\n⚠️  Server not running! Start it with: npm start');
    }
  }
}

testAnalyzeFull();
