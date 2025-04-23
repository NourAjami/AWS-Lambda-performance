/**
 * Scalability Testing Script for AWS Lambda
 * 
 * This script tests how Lambda handles different concurrency levels,
 * including sudden spikes in traffic.
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
const MEMORY_SIZES = [512, 1024, 2048]; 
const CONCURRENCY_LEVELS = [1, 10, 50]; 
const SPIKE_TEST_MULTIPLIER = 5;
// Number of test iterations for each configuration 
const TESTS_PER_CONFIG = 2; 

// Initialize AWS clients
const lambda = new AWS.Lambda({ region: AWS_REGION });
const cloudwatch = new AWS.CloudWatch({ region: AWS_REGION });

// Results storage
const results = [];
const testMetrics = [];

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
 * Sleep for a specified number of seconds
 */
async function sleep(seconds) {
  console.log(`Sleeping for ${seconds} seconds...`);
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
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
  await sleep(30); 
  console.log('Configuration update completed');
}

/**
 * Invoke Lambda function
 */
async function invokeLambda(imageData, options = {}) {
  const startTime = Date.now();
  
  // Unique identifier for this invocation
  const requestId = `scalability-test-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  
  // Prepare payload
  const payload = {
    operation: options.operation || 'resize',
    image: imageData,
    options: options.processingOptions || { width: 800 },
    requestId 
  };
  
  try {
    const response = await lambda.invoke({
      FunctionName: LAMBDA_FUNCTION_NAME,
      Payload: JSON.stringify(payload)
    }).promise();
    
    const duration = Date.now() - startTime;
    const result = JSON.parse(response.Payload);
    
    // Check for errors
    if (result.statusCode >= 400) {
      console.error(`Error invoking Lambda: ${JSON.stringify(result)}`);
      return {
        success: false,
        duration,
        error: result.error,
        ...options.testInfo
      };
    }
    
    // Get performance data
    const perfData = result.performanceData;
    return {
      success: true,
      ...options.testInfo,
      invocationTime: new Date().toISOString(),
      clientMeasuredDuration: duration,
      coldStart: perfData.coldStart,
      processingTime: perfData.processingTime,
      totalDuration: perfData.totalDuration,
      peakMemoryUsage: perfData.peakMemoryUsage
    };
  } catch (error) {
    console.error(`Exception invoking Lambda: ${error.message}`);
    return {
      success: false,
      duration: Date.now() - startTime,
      error: error.message,
      ...options.testInfo
    };
  }
}

/**
 * Run a batch of concurrent Lambda invocations
 */
async function runConcurrentBatch(imageData, concurrency, memorySize, testInfo = {}) {
  console.log(`Running ${concurrency} concurrent requests (Memory: ${memorySize}MB)`);
  
  const promises = [];
  const batchStartTime = Date.now();
  
  // Launch all concurrent requests
  for (let i = 0; i < concurrency; i++) {
    promises.push(invokeLambda(imageData, {
      testInfo: {
        ...testInfo,
        memorySize,
        concurrency,
        requestIndex: i
      }
    }));
  }
  
  // Wait for all requests to complete
  const batchResults = await Promise.all(promises);
  const batchDuration = (Date.now() - batchStartTime) / 1000; // seconds
  
  // Add results to global array
  results.push(...batchResults);
  
  // Calculate batch statistics
  const successCount = batchResults.filter(r => r.success).length;
  const successRate = (successCount / batchResults.length) * 100;
  
  const durations = batchResults.filter(r => r.success).map(r => r.totalDuration);
  const avgDuration = durations.length ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;
  const minDuration = durations.length ? Math.min(...durations) : 0;
  const maxDuration = durations.length ? Math.max(...durations) : 0;
  
  // Calculate percentiles
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const p95Index = Math.floor(sortedDurations.length * 0.95);
  const p99Index = Math.floor(sortedDurations.length * 0.99);
  const p95Duration = sortedDurations[p95Index] || maxDuration;
  const p99Duration = sortedDurations[p99Index] || maxDuration;
  
  // Log results
  console.log(`Batch completed in ${batchDuration.toFixed(2)}s`);
  console.log(`Success rate: ${successRate.toFixed(1)}% (${successCount}/${batchResults.length})`);
  console.log(`Avg duration: ${avgDuration.toFixed(2)}ms, Min: ${minDuration}ms, Max: ${maxDuration}ms`);
  console.log(`P95: ${p95Duration}ms, P99: ${p99Duration}ms`);
  
  // Return batch metrics
  return {
    memorySize,
    concurrency,
    requestCount: batchResults.length,
    successCount,
    successRate,
    batchDuration,
    avgDuration,
    minDuration,
    maxDuration,
    p95Duration,
    p99Duration,
    timestamp: new Date().toISOString(),
    ...testInfo
  };
}

/**
 * Run a steady load test with consistent concurrency
 */
async function runSteadyLoadTest(imageData, concurrency, memorySize, iterations) {
  console.log(`\n==== STEADY LOAD TEST: ${concurrency} concurrent requests, ${memorySize}MB ====\n`);
  
  const testMetrics = [];
  
  // Run multiple iterations
  for (let i = 0; i < iterations; i++) {
    console.log(`\nIteration ${i + 1}/${iterations}`);
    
    const batchMetrics = await runConcurrentBatch(imageData, concurrency, memorySize, {
      testType: 'steady',
      iteration: i
    });
    
    testMetrics.push(batchMetrics);
    
    // Short delay between iterations
    if (i < iterations - 1) {
      await sleep(5);
    }
  }
  
  // Calculate aggregate metrics
  const avgSuccessRate = testMetrics.reduce((sum, m) => sum + m.successRate, 0) / testMetrics.length;
  const avgDuration = testMetrics.reduce((sum, m) => sum + m.avgDuration, 0) / testMetrics.length;
  const maxDuration = Math.max(...testMetrics.map(m => m.maxDuration));
  const avgP95 = testMetrics.reduce((sum, m) => sum + m.p95Duration, 0) / testMetrics.length;
  
  // Calculate approximate throughput (requests per minute)
  const totalRequests = testMetrics.reduce((sum, m) => sum + m.requestCount, 0);
  const totalDuration = testMetrics.reduce((sum, m) => sum + m.batchDuration, 0);
  const throughput = (totalRequests / totalDuration) * 60;
  
  console.log('\n==== STEADY LOAD TEST RESULTS ====');
  console.log(`Average Success Rate: ${avgSuccessRate.toFixed(1)}%`);
  console.log(`Average Duration: ${avgDuration.toFixed(2)}ms`);
  console.log(`Maximum Duration: ${maxDuration}ms`);
  console.log(`Average P95 Duration: ${avgP95.toFixed(2)}ms`);
  console.log(`Throughput: ${throughput.toFixed(2)} requests/minute`);
  
  // Return aggregated test results
  return {
    testType: 'steady',
    memorySize,
    concurrency,
    iterations,
    batches: testMetrics,
    avgSuccessRate,
    avgDuration,
    maxDuration,
    avgP95Duration: avgP95,
    throughput
  };
}

/**
 * Run a spike test with a sudden increase in concurrency
 */
async function runSpikeTest(imageData, baseConcurrency, memorySize) {
  const spikeConcurrency = baseConcurrency * SPIKE_TEST_MULTIPLIER;
  
  console.log(`\n==== SPIKE TEST: ${baseConcurrency} to ${spikeConcurrency} concurrent requests, ${memorySize}MB ====\n`);
  
  // Run a few batches at base concurrency to establish baseline
  console.log('Running baseline load...');
  const baselineMetrics = [];
  for (let i = 0; i < 2; i++) {
    const metrics = await runConcurrentBatch(imageData, baseConcurrency, memorySize, {
      testType: 'spike_baseline',
      phase: 'baseline',
      iteration: i
    });
    baselineMetrics.push(metrics);
    await sleep(5);
  }
  
  // Run the spike load
  console.log('\nRunning spike load...');
  const spikeMetrics = await runConcurrentBatch(imageData, spikeConcurrency, memorySize, {
    testType: 'spike_peak',
    phase: 'spike'
  });
  
  // Run a few more batches at base concurrency to measure recovery
  console.log('\nRunning recovery load...');
  const recoveryMetrics = [];
  for (let i = 0; i < 2; i++) {
    const metrics = await runConcurrentBatch(imageData, baseConcurrency, memorySize, {
      testType: 'spike_recovery',
      phase: 'recovery',
      iteration: i
    });
    recoveryMetrics.push(metrics);
    await sleep(5);
  }
  
  // Calculate aggregate metrics
  const baselineAvgDuration = baselineMetrics.reduce((sum, m) => sum + m.avgDuration, 0) / baselineMetrics.length;
  const recoveryAvgDuration = recoveryMetrics.reduce((sum, m) => sum + m.avgDuration, 0) / recoveryMetrics.length;
  const recoveryRatio = recoveryAvgDuration / baselineAvgDuration;
  
  console.log('\n==== SPIKE TEST RESULTS ====');
  console.log(`Baseline Avg Duration: ${baselineAvgDuration.toFixed(2)}ms`);
  console.log(`Spike Avg Duration: ${spikeMetrics.avgDuration.toFixed(2)}ms`);
  console.log(`Spike Success Rate: ${spikeMetrics.successRate.toFixed(1)}%`);
  console.log(`Recovery Avg Duration: ${recoveryAvgDuration.toFixed(2)}ms`);
  console.log(`Recovery/Baseline Ratio: ${recoveryRatio.toFixed(2)}x`);
  
  // Return aggregated test results
  return {
    testType: 'spike',
    memorySize,
    baseConcurrency,
    spikeConcurrency,
    baselineMetrics,
    spikeMetrics,
    recoveryMetrics,
    baselineAvgDuration,
    recoveryAvgDuration,
    recoveryRatio
  };
}

/**
 * Fetch CloudWatch metrics for Lambda function
 */
async function fetchCloudWatchMetrics(startTime, endTime) {
  console.log('Fetching CloudWatch metrics...');
  
  const metrics = [
    { name: 'Invocations', stat: 'Sum' },
    { name: 'Errors', stat: 'Sum' },
    { name: 'Duration', stat: 'Average' },
    { name: 'Duration', stat: 'Maximum' },
    { name: 'Duration', stat: 'p95' },
    { name: 'ConcurrentExecutions', stat: 'Maximum' },
    { name: 'Throttles', stat: 'Sum' }
  ];
  
  const params = {
    MetricDataQueries: metrics.map((metric, index) => ({
      Id: `m${index}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/Lambda',
          MetricName: metric.name,
          Dimensions: [
            {
              Name: 'FunctionName',
              Value: LAMBDA_FUNCTION_NAME
            }
          ]
        },
        Period: 60,
        Stat: metric.stat
      }
    })),
    StartTime: startTime,
    EndTime: endTime
  };
  
  try {
    const response = await cloudwatch.getMetricData(params).promise();
    
    // Format the results for easier analysis
    const formattedMetrics = {};
    
    metrics.forEach((metric, index) => {
      const key = `${metric.name}_${metric.stat}`;
      const metricResult = response.MetricDataResults.find(r => r.Id === `m${index}`);
      
      if (metricResult) {
        formattedMetrics[key] = {
          values: metricResult.Values,
          timestamps: metricResult.Timestamps
        };
      }
    });
    
    return formattedMetrics;
  } catch (error) {
    console.error('Error fetching CloudWatch metrics:', error);
    return {};
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('Starting Scalability Testing for AWS Lambda');
  
  try {
    // Load test image
    console.log('Loading test image...');
    const imageData = await loadTestImage();
    console.log('Test image loaded successfully');
    
    // Run tests for each memory configuration
    for (const memorySize of MEMORY_SIZES) {
      // Update Lambda memory
      await updateLambdaMemory(memorySize);
      
      // Run tests for each concurrency level
      for (const concurrency of CONCURRENCY_LEVELS) {
        // Run steady load test
        const steadyResults = await runSteadyLoadTest(imageData, concurrency, memorySize, TESTS_PER_CONFIG);
        testMetrics.push(steadyResults);
        
        // Run spike test for concurrency levels greater than 1
        if (concurrency > 1) {
          const baseConcurrency = Math.max(1, Math.floor(concurrency / 2));
          const spikeResults = await runSpikeTest(imageData, baseConcurrency, memorySize);
          testMetrics.push(spikeResults);
        }
      }
    }
    
    // Save raw results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsFile = `scalability-results-${timestamp}.json`;
    await writeFileAsync(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\nRaw results saved to ${resultsFile}`);
    
    // Save test metrics
    const metricsFile = `scalability-metrics-${timestamp}.json`;
    await writeFileAsync(metricsFile, JSON.stringify(testMetrics, null, 2));
    console.log(`Test metrics saved to ${metricsFile}`);
    
    // Print summary
    console.log('\n==== SCALABILITY TESTING SUMMARY ====');
    
    // Steady load test summary
    const steadyTests = testMetrics.filter(m => m.testType === 'steady');
    console.log('\nSteady Load Test Results:');
    for (const memory of MEMORY_SIZES) {
      const memoryTests = steadyTests.filter(t => t.memorySize === memory);
      if (memoryTests.length > 0) {
        console.log(`\n  Memory: ${memory}MB`);
        for (const test of memoryTests) {
          console.log(`    Concurrency ${test.concurrency}: Throughput ${test.throughput.toFixed(2)} req/min, Avg ${test.avgDuration.toFixed(0)}ms, P95 ${test.avgP95Duration.toFixed(0)}ms`);
        }
      }
    }
    
    // Spike test summary
    const spikeTests = testMetrics.filter(m => m.testType === 'spike');
    console.log('\nSpike Test Results:');
    for (const memory of MEMORY_SIZES) {
      const memoryTests = spikeTests.filter(t => t.memorySize === memory);
      if (memoryTests.length > 0) {
        console.log(`\n  Memory: ${memory}MB`);
        for (const test of memoryTests) {
          console.log(`    Base ${test.baseConcurrency} to Spike ${test.spikeConcurrency}: Success Rate ${test.spikeMetrics.successRate.toFixed(1)}%, Recovery Ratio ${test.recoveryRatio.toFixed(2)}x`);
        }
      }
    }
    
  } catch (error) {
    console.error('Error running tests:', error);
  }
}

runAllTests();