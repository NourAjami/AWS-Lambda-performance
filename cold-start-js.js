/**
 * Cold Start Analysis Script for AWS Lambda
 * 
 * This script specifically tests how different inactivity periods affect
 * cold start behavior in AWS Lambda image processing functions.
 */

const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

const credentials = new AWS.SharedIniFileCredentials({profile: 'lambda-project'});
AWS.config.credentials = credentials;

// Configuration
const LAMBDA_FUNCTION_NAME = 'image-processing-lambda';
const AWS_REGION = 'us-east-1';

// Test parameters

// MB - removed 128MB which is too low
const MEMORY_SIZES = [512, 1024, 2048]; 
// Minutes - reduced to practical intervals
const INACTIVITY_PERIODS = [1, 5, 10]; 
// Number of tests to run for each configuration
const TESTS_PER_CONFIG = 1; 

// Initialize AWS client
const lambda = new AWS.Lambda({ region: AWS_REGION });

// Results storage
const results = [];

/**
 * Load a test image
 */
async function loadTestImage() {
  try {
    // Use a 1MB image for consistency across tests
    const imagePath = path.join(__dirname, 'test-images', 'sample-1mb.jpg');
    const imageData = await readFileAsync(imagePath);
    return imageData.toString('base64');
  } catch (error) {
    console.error(`Error loading test image: ${error.message}`);
    throw error;
  }
}

/**
 * Sleep for a specified number of minutes
 */
async function sleep(minutes) {
  const ms = minutes * 60 * 1000;
  console.log(`Sleeping for ${minutes} minutes...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Update Lambda function memory configuration
 */
async function updateLambdaMemory(memorySize) {
  console.log(`Setting Lambda memory to ${memorySize}MB...`);
  
  await lambda.updateFunctionConfiguration({
    FunctionName: LAMBDA_FUNCTION_NAME,
    MemorySize: memorySize
  }).promise();
  
  console.log('Waiting for configuration update to complete...');
  await sleep(0.5); 
  console.log('Configuration update completed');
}

/**
 * Invoke Lambda function
 */
async function invokeLambda(imageData, testInfo) {
  const startTime = Date.now();
  
  // Unique identifier for this invocation
  const requestId = `cold-test-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  
  // Prepare payload
  const payload = {
    operation: 'resize',
    image: imageData,
    options: { 
      width: 800,
      skipImageData: true 
    },
    requestId 
  };
  
  try {
    const response = await lambda.invoke({
      FunctionName: LAMBDA_FUNCTION_NAME,
      Payload: JSON.stringify(payload)
    }).promise();
    
    const duration = Date.now() - startTime;
    const result = JSON.parse(response.Payload);
    
    console.log('Lambda response status:', result.statusCode);
    
    // Check if performanceData exists
    if (!result.performanceData) {
      console.error('No performance data in response:', JSON.stringify(result, null, 2));
      return {
        success: false,
        duration,
        error: 'Missing performance data in response',
        ...testInfo
      };
    }
    
    // Check for errors
    if (result.statusCode >= 400) {
      console.error(`Error invoking Lambda: ${JSON.stringify(result)}`);
      return {
        success: false,
        duration,
        error: result.error || 'Unknown error',
        performanceData: result.performanceData, 
        ...testInfo
      };
    }
    
    // Get performance data
    const perfData = result.performanceData;
    
    return {
      success: true,
      inactivityPeriod: testInfo.inactivityPeriod,
      memorySize: testInfo.memorySize,
      testIndex: testInfo.testIndex,
      invocationTime: new Date().toISOString(),
      clientMeasuredDuration: duration,
      coldStart: perfData.coldStart,
      coldStartLatency: perfData.coldStartLatency || 0,
      processingTime: perfData.processingTime || 0,
      totalDuration: perfData.totalDuration || duration,
      peakMemoryUsage: perfData.peakMemoryUsage || {}
    };
  } catch (error) {
    console.error(`Exception invoking Lambda: ${error.message}`);
    return {
      success: false,
      duration: Date.now() - startTime,
      error: error.message,
      ...testInfo
    };
  }
}

/**
 * Invoke Lambda function with retries
 */
async function invokeLambdaWithRetries(imageData, testInfo, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await invokeLambda(imageData, testInfo);
    } catch (error) {
      console.error(`Network error (attempt ${attempt+1}/${maxRetries}): ${error.message}`);
      if (attempt < maxRetries - 1) {
        console.log('Retrying in 5 seconds...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw error;
      }
    }
  }
}

/**
 * Run a test with specific configuration
 */
async function runTest(imageData, memorySize, inactivityPeriod, testIndex) {
  console.log(`\n=== TEST ${testIndex + 1}: Memory=${memorySize}MB, Inactivity=${inactivityPeriod}min ===`);
  
  // Sleep for the inactivity period
  await sleep(inactivityPeriod);
  
  // Invoke Lambda (potentially cold start)
  console.log('Invoking Lambda function...');
  const testInfo = { memorySize, inactivityPeriod, testIndex };
  const result = await invokeLambdaWithRetries(imageData, testInfo); 
  
  // Log result
  if (result.success) {
    console.log(`Invocation completed in ${result.clientMeasuredDuration}ms`);
    console.log(`Cold start: ${result.coldStart ? 'YES' : 'NO'}`);
    if (result.coldStart) {
      console.log(`Cold start latency: ${result.coldStartLatency}ms`);
    }
  } else {
    console.log(`Invocation failed: ${result.error}`);
  }
  
  // Add to results
  results.push(result);
  
  // If this was a cold start, do an immediate follow-up test to measure warm start
  // Make sure this is working correctly (had some issues with this)
  if (result.success && result.coldStart) {
    console.log('\n=== IMMEDIATE FOLLOW-UP (WARM START) ===');
    console.log('Invoking Lambda function again...');
    
    const warmTestInfo = { 
      memorySize, 
      inactivityPeriod: 0, 
      testIndex 
    };
    
    const warmResult = await invokeLambdaWithRetries(imageData, warmTestInfo);
    
    if (warmResult.success) {
      console.log(`Warm invocation completed in ${warmResult.clientMeasuredDuration}ms`);
      console.log(`Cold start: ${warmResult.coldStart ? 'YES' : 'NO'}`);
      
      // Calculate improvement
      const coldDuration = result.totalDuration;
      const warmDuration = warmResult.totalDuration;
      const improvement = ((coldDuration - warmDuration) / coldDuration * 100).toFixed(1);
      console.log(`Performance improvement: ${improvement}%`);
    }
    
    // Add to results
    results.push(warmResult);
  }
  
  return result;
}

/**
 * Analyze test results
 */
function analyzeResults() {
  const coldStartFrequency = {};
  const avgLatencies = {};
  const coldWarmRatios = {};
  
  // Group by memory size and inactivity period
  for (const memorySize of MEMORY_SIZES) {
    coldStartFrequency[memorySize] = {};
    avgLatencies[memorySize] = {};
    coldWarmRatios[memorySize] = {};
    
    for (const inactivityPeriod of INACTIVITY_PERIODS) {
      // Get all test results for this configuration
      const configTests = results.filter(r => 
        r.success && 
        r.memorySize === memorySize && 
        r.inactivityPeriod === inactivityPeriod
      );
      
      if (configTests.length === 0) continue;
      
      // Calculate cold start frequency
      const coldStarts = configTests.filter(r => r.coldStart);
      const frequency = (coldStarts.length / configTests.length) * 100;
      coldStartFrequency[memorySize][inactivityPeriod] = frequency;
      
      // Calculate average cold start latency
      if (coldStarts.length > 0) {
        const avgLatency = coldStarts.reduce((sum, r) => sum + r.coldStartLatency, 0) / coldStarts.length;
        avgLatencies[memorySize][inactivityPeriod] = avgLatency;
      }
      
      // Calculate cold vs warm performance ratio
      // Find cases where we have both cold and warm tests
      const coldWarmPairs = [];
      for (let i = 0; i < results.length - 1; i++) {
        const r1 = results[i];
        const r2 = results[i + 1];
        
        if (r1.success && r2.success && 
            r1.memorySize === memorySize && 
            r1.testIndex === r2.testIndex &&
            r1.coldStart && !r2.coldStart) {
          coldWarmPairs.push({ cold: r1, warm: r2 });
        }
      }
      
      if (coldWarmPairs.length > 0) {
        const ratios = coldWarmPairs.map(pair => pair.cold.totalDuration / pair.warm.totalDuration);
        const avgRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
        coldWarmRatios[memorySize][inactivityPeriod] = avgRatio;
      }
    }
  }
  
  return {
    coldStartFrequency,
    avgLatencies,
    coldWarmRatios
  };
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('Starting Cold Start Analysis for AWS Lambda');
  
  try {
    // Load test image
    console.log('Loading test image...');
    const imageData = await loadTestImage();
    console.log('Test image loaded successfully');
    
    // Run tests for each memory configuration and inactivity period
    for (const memorySize of MEMORY_SIZES) {
      console.log(`\n===== TESTING WITH MEMORY SIZE: ${memorySize}MB =====`);
      
      // Update Lambda memory configuration
      try {
        await updateLambdaMemory(memorySize);
      } catch (error) {
        console.error(`Error updating Lambda memory to ${memorySize}MB: ${error.message}`);
        console.log(`Skipping tests for ${memorySize}MB configuration...`);
        continue; // Skip this memory size
      }
      
      // Run warm-up invocation to verify this memory size works
      console.log('Running warm-up invocation...');
      const warmupResult = await invokeLambda(imageData, { memorySize, inactivityPeriod: 0, testIndex: -1 });
      
      // Check if warm-up failed due to memory issues
      if (!warmupResult.success && 
          (warmupResult.error === 'Missing performance data in response' || 
           warmupResult.error?.includes('OutOfMemory'))) {
        console.log(`\nWarm-up failed - Lambda likely running out of memory at ${memorySize}MB.`);
        console.log(`Skipping all tests for ${memorySize}MB configuration...`);
        continue; 
      }
      
      // Run tests with different inactivity periods
      let memoryFailures = 0;
      const MAX_MEMORY_FAILURES = 3;
      
      for (const inactivityPeriod of INACTIVITY_PERIODS) {
        let periodFailures = 0;
        const MAX_PERIOD_FAILURES = 2;
        
        for (let i = 0; i < TESTS_PER_CONFIG; i++) {
          const result = await runTest(imageData, memorySize, inactivityPeriod, i);
          
          // Check if test failed due to memory issues
          if (!result.success && 
              (result.error === 'Missing performance data in response' || 
               result.error?.includes('OutOfMemory'))) {
            memoryFailures++;
            periodFailures++;
            
            // If we've had multiple failures for this memory size, skip remaining tests
            if (memoryFailures >= MAX_MEMORY_FAILURES) {
              console.log(`\nToo many memory failures for ${memorySize}MB configuration.`);
              console.log(`Skipping remaining tests for this memory size...`);
              break; 
            }
            
            // If we've had multiple failures for this period, skip to next period
            if (periodFailures >= MAX_PERIOD_FAILURES) {
              console.log(`\nToo many failures for ${inactivityPeriod}min inactivity period.`);
              console.log(`Skipping to next inactivity period...`);
              break; 
            }
          }
        }
        
        // Check if we should skip remaining inactivity periods
        if (memoryFailures >= MAX_MEMORY_FAILURES) {
          break;
        }
      }
    }
    
    // Analyze results
    console.log('\n=== COLD START ANALYSIS RESULTS ===');
    const analysis = analyzeResults();
    
    // Print cold start frequency by memory size and inactivity period
    console.log('\nCold Start Frequency (% of invocations):');
    for (const memorySize in analysis.coldStartFrequency) {
      console.log(`\n  Memory: ${memorySize}MB`);
      for (const inactivityPeriod in analysis.coldStartFrequency[memorySize]) {
        const frequency = analysis.coldStartFrequency[memorySize][inactivityPeriod];
        console.log(`    After ${inactivityPeriod} min inactivity: ${frequency.toFixed(1)}%`);
      }
    }
    
    // Print average cold start latency
    console.log('\nAverage Cold Start Latency (ms):');
    for (const memorySize in analysis.avgLatencies) {
      console.log(`\n  Memory: ${memorySize}MB`);
      for (const inactivityPeriod in analysis.avgLatencies[memorySize]) {
        const latency = analysis.avgLatencies[memorySize][inactivityPeriod];
        console.log(`    After ${inactivityPeriod} min inactivity: ${latency.toFixed(2)}ms`);
      }
    }
    
    // Print cold vs warm ratios
    console.log('\nCold vs Warm Execution Time Ratio:');
    for (const memorySize in analysis.coldWarmRatios) {
      console.log(`\n  Memory: ${memorySize}MB`);
      for (const inactivityPeriod in analysis.coldWarmRatios[memorySize]) {
        const ratio = analysis.coldWarmRatios[memorySize][inactivityPeriod];
        console.log(`    After ${inactivityPeriod} min inactivity: ${ratio.toFixed(2)}x slower`);
      }
    }
    
    // Save raw results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsFile = `cold-start-results-${timestamp}.json`;
    await writeFileAsync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\nRaw results saved to ${resultsFile}`);
    
    // Save analysis
    const analysisFile = `cold-start-analysis-${timestamp}.json`;
    await writeFileAsync(analysisFile, JSON.stringify(analysis, null, 2));
    console.log(`Analysis saved to ${analysisFile}`);
    
  } catch (error) {
    console.error('Error running tests:', error);
  }
}

runAllTests();