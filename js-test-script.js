/**
 * Lambda Image Processing Performance Test Script
 * This script tests performance across different image sizes, operations, and memory settings
 * Uses S3 for storing and retrieving large images to avoid Lambda payload size limitations
 */

const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const crypto = require('crypto');

const credentials = new AWS.SharedIniFileCredentials({profile: 'lambda-project'});
AWS.config.credentials = credentials;

// Configuration - use only one bucket name consistently
const LAMBDA_FUNCTION_NAME = 'image-processing-lambda';
const AWS_REGION = 'us-east-1'; // Change to your region
const S3_BUCKET_NAME = 'lambda-image-processing-test-nourajami';

// Test parameters that we're going to test
const IMAGE_SIZES = ['100kb', '1mb', '5mb', '10mb'];
const OPERATIONS = ['resize', 'color-adjustment', 'complex-filtering', 'format-conversion'];
// MB
const MEMORY_SIZES = [512, 1024, 2048]; 
const CONCURRENCY_LEVELS = [1, 5, 10, 15, 20]; 

// Initialize AWS clients
const lambda = new AWS.Lambda({ region: AWS_REGION });
const s3 = new AWS.S3({ region: AWS_REGION });

// Results storage
const results = [];

/**
 * Ensure the S3 bucket exists, create it if it doesn't
 */
async function ensureBucketExists() {
  try {
    console.log(`Checking if S3 bucket ${S3_BUCKET_NAME} exists...`);
    await s3.headBucket({ Bucket: S3_BUCKET_NAME }).promise();
    console.log(`Bucket ${S3_BUCKET_NAME} exists`);
    return true;
  } catch (error) {
    console.error(`Error: Bucket ${S3_BUCKET_NAME} does not exist or is not accessible: ${error.message}`);
    console.log('Please create this bucket manually in the AWS Console');
    return false;
  }
}

/**
 * Generate a unique key for S3 object
 */
function generateS3Key(size, prefix = 'test-images') {
  const randomId = crypto.randomBytes(4).toString('hex');
  return `${prefix}/sample-${size}-${randomId}.jpg`;
}

/**
 * Upload an image to S3
 */
async function uploadImageToS3(imageData, size) {
  const key = generateS3Key(size);
  
  console.log(`Uploading ${size} image to S3...`);
  await s3.putObject({
    Bucket: S3_BUCKET_NAME,
    Key: key,
    Body: imageData,
    ContentType: 'image/jpeg',
    ACL: 'bucket-owner-full-control'
  }).promise();
  
  console.log(`Uploaded ${size} image to S3: s3://${S3_BUCKET_NAME}/${key}`);
  
  // Verify the object is accessible
  try {
    await s3.headObject({ Bucket: S3_BUCKET_NAME, Key: key }).promise();
    console.log(`Verified S3 object is accessible: s3://${S3_BUCKET_NAME}/${key}`);
  } catch (error) {
    console.error(`Warning: Uploaded S3 object may not be accessible: ${error.message}`);
  }
  
  return { bucket: S3_BUCKET_NAME, key };
}

/**
 * Load test images of different sizes from the test-images directory
 * and upload them to S3 for larger images
 */
async function loadTestImages() {
  const images = {};
  
  // Ensure the S3 bucket exists
  await ensureBucketExists();
  
  for (const size of IMAGE_SIZES) {
    try {
      const filePath = path.join(__dirname, 'test-images', `sample-${size}.jpg`);
      const imageData = await readFileAsync(filePath);
      
      // For images <= 1MB, keep the base64 encoding for direct Lambda invocation (5MB and 10MB images will be uploaded to S3)
      // For larger images, upload to S3 and store the reference
      if (size === '100kb' || size === '1mb') {
        images[size] = {
          type: 'base64',
          data: imageData.toString('base64'),
          size: imageData.length
        };
        console.log(`Loaded ${size} image: ${filePath} (${imageData.length} bytes) - using direct payload`);
      } else {
        // Upload to S3 for larger images
        const s3Ref = await uploadImageToS3(imageData, size);
        images[size] = {
          type: 's3',
          bucket: s3Ref.bucket,
          key: s3Ref.key,
          size: imageData.length
        };
        console.log(`Loaded ${size} image: ${filePath} (${imageData.length} bytes) - using S3`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`Warning: Image file for ${size} not found at expected path`);
      } else {
        console.log(`Error processing ${size} image: ${error.message}`);
      }
    }
  }
  
  return images;
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Invoke Lambda function with the given parameters
 */
async function invokeLambda(imageInfo, operation, options, memorySize = null, saveImages = false) {
  // Update Lambda memory configuration if specified
  if (memorySize !== null) {
    console.log(`Updating Lambda memory to ${memorySize}MB...`);
    await lambda.updateFunctionConfiguration({
      FunctionName: LAMBDA_FUNCTION_NAME,
      MemorySize: memorySize
    }).promise();
    
    // Wait for update to complete
    await sleep(5000); // 5 seconds
  }
  
  // Add returnIntermediateResults flag to options
  let enhancedOptions = {
    ...options,
    returnIntermediateResults: saveImages,
  };
  
  // Prepare payload based on image type (direct or S3)
  let payload;
  
  if (imageInfo.type === 'base64') {
    // Direct image payload for smaller images
    enhancedOptions.skipImageData = (operation === 'format-conversion' && !saveImages);
    
    payload = {
      operation,
      image: imageInfo.data,
      options: enhancedOptions,
      sourceType: 'direct'
    };
  } else if (imageInfo.type === 's3') {
    // For S3 images, always save results to S3 and avoid returning large payloads
    enhancedOptions = {
      ...enhancedOptions,
      skipImageData: true,
      storeResultInS3: true,
      resultS3Bucket: S3_BUCKET_NAME,
      resultS3Prefix: `results/${operation}`
    };
    
    payload = {
      operation,
      imageSource: {
        bucket: imageInfo.bucket,
        key: imageInfo.key
      },
      options: enhancedOptions,
      sourceType: 's3'
    };
    
    console.log(`Using S3 source: s3://${imageInfo.bucket}/${imageInfo.key}`);
  } else {
    throw new Error(`Unknown image type: ${imageInfo.type}`);
  }
  
  // Invoke Lambda with more detailed error handling
  const startTime = Date.now();
  try {
    const response = await lambda.invoke({
      FunctionName: LAMBDA_FUNCTION_NAME,
      Payload: JSON.stringify(payload),
      LogType: 'Tail'  
    }).promise();
    
    // Get the execution logs if available
    if (response.LogResult) {
      const logs = Buffer.from(response.LogResult, 'base64').toString('utf-8');
      if (logs && logs.trim()) {
        console.log(`Lambda execution logs (truncated):`);
        // Show just the last few lines of logs to avoid cluttering the output
        const logLines = logs.split('\n');
        const lastFewLines = logLines.slice(Math.max(0, logLines.length - 5)).join('\n');
        console.log(lastFewLines);
      }
    }
    
    // Process response
    let responsePayload;
    try {
      responsePayload = JSON.parse(response.Payload);
    } catch (error) {
      console.error(`Error parsing Lambda response: ${error.message}`);
      console.log(`Raw response payload: ${response.Payload}`);
      throw new Error(`Failed to parse Lambda response: ${error.message}`);
    }
    
    const totalDuration = Date.now() - startTime;
    
    // Check for Lambda errors
    if (responsePayload.errorType || responsePayload.errorMessage) {
      console.log(`Error response:`, responsePayload);
      return {
        error: true,
        statusCode: responsePayload.statusCode || 500,
        message: responsePayload.errorMessage || 'Unknown error',
        clientMeasuredDuration: totalDuration,
        totalDuration: 0
      };
    }
    
    // Save images only if explicitly requested and they exist in the response
    if (saveImages) {
      // Handle final image result
      if (responsePayload.final) {
        let finalImageData;
        
        // The response could contain the image directly or as an S3 reference
        if (responsePayload.final.data) {
          // Direct image data
          finalImageData = Buffer.from(responsePayload.final.data, 'base64');
        } else if (responsePayload.final.s3Location) {
          // S3 reference - download the file
          const s3Loc = responsePayload.final.s3Location;
          try {
            const s3Object = await s3.getObject({
              Bucket: s3Loc.bucket,
              Key: s3Loc.key
            }).promise();
            finalImageData = s3Object.Body;
            console.log(`Downloaded result from S3: s3://${s3Loc.bucket}/${s3Loc.key}`);
          } catch (error) {
            console.error(`Error downloading result from S3: ${error.message}`);
          }
        }
        
        if (finalImageData) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const outputDir = path.join(__dirname, 'output-images');
          
          // Create output directory if it doesn't exist
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          
          const finalFormat = responsePayload.final.format || 'jpg';
          const finalImagePath = path.join(outputDir, `${operation}-final-${timestamp}.${finalFormat}`);
          await writeFileAsync(finalImagePath, finalImageData);
          console.log(`Saved final image to: ${finalImagePath}`);
        }
      }
      
      // Handle intermediate results if available
      if (responsePayload.intermediateResults && Array.isArray(responsePayload.intermediateResults)) {
        const outputDir = path.join(__dirname, 'output-images');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        for (let i = 0; i < responsePayload.intermediateResults.length; i++) {
          const result = responsePayload.intermediateResults[i];
          let intermediateData;
          
          if (result.data) {
            // Direct image data
            intermediateData = Buffer.from(result.data, 'base64');
          } else if (result.s3Location) {
            // S3 reference - download the file
            const s3Loc = result.s3Location;
            try {
              const s3Object = await s3.getObject({
                Bucket: s3Loc.bucket,
                Key: s3Loc.key
              }).promise();
              intermediateData = s3Object.Body;
            } catch (error) {
              console.error(`Error downloading intermediate result from S3: ${error.message}`);
            }
          }
          
          if (intermediateData) {
            const format = result.format || 'jpg';
            const intermediateImagePath = path.join(
              outputDir, 
              `${operation}-${result.label}-${timestamp}.${format}`
            );
            await writeFileAsync(intermediateImagePath, intermediateData);
            console.log(`Saved intermediate image to: ${intermediateImagePath}`);
          }
        }
      }
    }
    
    // For S3 images, if performance data is missing, create a basic record with timing info
    if (!responsePayload.performanceData && imageInfo.type === 's3') {
      console.log(`No performance data returned for S3 image. Creating basic record.`);
      return {
        sourceType: 's3',
        imageSize: imageInfo.size,
        clientMeasuredDuration: totalDuration,
        processingTime: responsePayload.processingTime || 0,
        totalDuration: responsePayload.totalDuration || totalDuration
      };
    }
    
    // Extract performance data
    if (responsePayload.performanceData) {
      const perfData = responsePayload.performanceData;
      perfData.clientMeasuredDuration = totalDuration;
      perfData.imageSize = imageInfo.size; 
      perfData.sourceType = imageInfo.type; 
      return perfData;
    } else {
      console.log(`Warning: No performance data in response:`, responsePayload);
      return {
        error: true,
        statusCode: responsePayload.statusCode || 500,
        message: responsePayload.error || 'Unknown error',
        clientMeasuredDuration: totalDuration
      };
    }
  } catch (error) {
    console.log(`Error invoking Lambda:`, error);
    return {
      error: true,
      errorMessage: error.message,
      errorCode: error.code,
      clientMeasuredDuration: Date.now() - startTime,
      totalDuration: 0
    };
  }
}

/**
 * Test cold start vs. warm start performance
 */
async function testColdStartVsWarm(images) {
  console.log("\n=== TESTING COLD START VS WARM START PERFORMANCE ===\n");
  
  for (const memorySize of MEMORY_SIZES) {
    console.log(`\nTesting with ${memorySize}MB memory configuration`);
    
    // Update Lambda memory
    await lambda.updateFunctionConfiguration({
      FunctionName: LAMBDA_FUNCTION_NAME,
      MemorySize: memorySize
    }).promise();
    
    // Wait for update to complete (this forces a cold start)
    await sleep(10000);
    
    // Test each image size
    for (const size in images) {
      if (images[size]) {
        console.log(`Testing ${size} image...`);
        
        // Cold start test
        console.log("  Cold start invocation...");
        const coldResult = await invokeLambda(
          images[size],
          'resize',
          { width: 800 },
          null,
          false
        );
        
        coldResult.testType = 'cold_start';
        coldResult.imageSize = size;
        coldResult.memorySize = memorySize;
        results.push(coldResult);
        
        // Warm start test (immediate invocation)
        console.log("  Warm start invocation...");
        const warmResult = await invokeLambda(
          images[size],
          'resize',
          { width: 800 },
          null,
          false
        );
        
        warmResult.testType = 'warm_start';
        warmResult.imageSize = size;
        warmResult.memorySize = memorySize;
        results.push(warmResult);
        
        // Calculate improvement
        const coldDuration = coldResult.totalDuration || 0;
        const warmDuration = warmResult.totalDuration || 0;
        const improvement = coldDuration > 0 
          ? ((coldDuration - warmDuration) / coldDuration * 100) 
          : 0;
        
        console.log(`  Cold start: ${coldDuration}ms, Warm start: ${warmDuration}ms`);
        console.log(`  Improvement: ${improvement.toFixed(1)}%`);
        
        // Wait a moment before next test
        await sleep(1000);
      }
    }
  }
}

/**
 * Test different image processing operations
 */
async function testOperations(images) {
  console.log("\n=== TESTING OPERATIONS ===\n");
  
  // Operation configurations
  const operationConfigs = {
    'resize': { width: 800 },
    'color-adjustment': {
      brightness: 1.2,
      saturation: 1.5,
      contrast: 1.3
    },
    'complex-filtering': {
      blur: true,
      blurSigma: 3,
      median: true
    },
    'format-conversion': {
      targetFormat: 'png',
      quality: 80
    }
  };
  
  // Test each operation
  for (const operation of OPERATIONS) {
    console.log(`\nTesting ${operation} operation`);
    
    // Test with different image sizes
    for (const size in images) {
      if (images[size]) {
        console.log(`  Processing ${size} image...`);
        
        // Get the base options for this operation
        const options = {...operationConfigs[operation] || {}};
        
        // For large images or S3 sources, always store results in S3
        if (images[size].type === 's3') {
          options.storeResultInS3 = true;
          options.resultS3Bucket = S3_BUCKET_NAME;
          options.resultS3Prefix = `results/${operation}`;
        }
        
        // Format conversion should always skip returning image data
        if (operation === 'format-conversion') {
          options.skipImageData = true;
        }
        
        // Warm up
        try {
          await invokeLambda(images[size], operation, options);
        } catch (error) {
          console.log(`  Warm-up error: ${error.message}`);
        }
        
        // Measure
        let result;
        const startTime = Date.now();
        
        try {
          // Only save representative samples
          const saveThisImage = (size === '1mb' && operation !== 'format-conversion');
          result = await invokeLambda(images[size], operation, options, null, saveThisImage);
        } catch (error) {
          console.log(`  Error: ${error.message}`);
          result = { 
            error: true, 
            errorMessage: error.message 
          };
        }
        
        const duration = Date.now() - startTime;
        console.log(`  Completed in ${duration}ms`);
        
        // Record result - include all results, even errors
        result.testType = 'operation_test';
        result.operation = operation;
        result.imageSize = size;
        results.push(result);
      }
    }
  }
}

/**
 * Test performance under different concurrency levels
 */
async function testConcurrency(images, imageSize = '1mb') {
  console.log("\n=== TESTING CONCURRENCY ===\n");
  
  // Use a fixed memory size for concurrency testing
  const memorySize = 1024;
  await lambda.updateFunctionConfiguration({
    FunctionName: LAMBDA_FUNCTION_NAME,
    MemorySize: memorySize
  }).promise();
  await sleep(10000); 
  
  // Get test image
  const imageInfo = images[imageSize];
  if (!imageInfo) {
    console.log(`Error: Image data for size ${imageSize} not available`);
    return;
  }
  
  // Test each concurrency level
  for (const concurrency of CONCURRENCY_LEVELS) {
    console.log(`\nTesting with concurrency level ${concurrency}`);
    
    // Function to execute for a single request with retries
    const executeTest = async (i) => {
      const operation = 'resize';
      const options = { width: 800 };
      
      // Save images only for the first request of each concurrency level
      const saveImages = (i === 0);
      
      // For high concurrency, increase the backoff to avoid throttling
      const baseBackoffMs = 200 * Math.min(concurrency, 10);
      
      // Add retry logic for throttling errors
      let retries = 0;
      const maxRetries = 5; 
      let result;
      
      // For high concurrency, add a small delay based on index to spread out requests
      if (concurrency > 10 && i > 0) {
        await sleep(i * 100); 
      }
      
      while (retries <= maxRetries) {
        try {
          result = await invokeLambda(imageInfo, operation, options, null, saveImages);
          break; // Success, exit retry loop
        } catch (error) {
          if (error.code === 'TooManyRequestsException' && retries < maxRetries) {
            retries++;
            console.log(`Request ${i} throttled, retrying (${retries}/${maxRetries})...`);
            // Exponential backoff with jitter
            const jitter = Math.random() * 500;
            await sleep(Math.pow(2, retries) * baseBackoffMs + jitter);
          } else {
            throw error; 
          }
        }
      }
      
      result.concurrencyTest = true;
      result.concurrencyLevel = concurrency;
      result.requestIndex = i;
      result.imageSize = imageSize;
      result.memorySize = memorySize;
      return result;
    };
    
    // Execute concurrent requests with better error handling
    const startTime = Date.now();
    try {
      // Create all promise objects
      const promises = Array(concurrency).fill().map((_, i) => executeTest(i));
      
      // Use Promise.allSettled to handle failures in individual promises
      const promiseResults = await Promise.allSettled(promises);
      const totalTime = (Date.now() - startTime) / 1000;
      
      // Process results, handling both fulfilled and rejected promises
      const batchResults = promiseResults.map((pr, i) => {
        if (pr.status === 'fulfilled') {
          return pr.value;
        } else {
          console.log(`Request ${i} failed: ${pr.reason}`);
          return {
            error: true,
            errorMessage: pr.reason?.message || 'Promise rejected',
            concurrencyTest: true,
            concurrencyLevel: concurrency,
            requestIndex: i,
            imageSize: imageSize,
            memorySize: memorySize,
            totalDuration: 0
          };
        }
      });
      
      // Add results
      results.push(...batchResults);
      
      // Calculate statistics for successful requests
      const successfulResults = batchResults.filter(r => !r.error);
      const durations = successfulResults.map(r => r.totalDuration || 0);
      const avgDuration = durations.length 
        ? durations.reduce((sum, val) => sum + val, 0) / durations.length 
        : 0;
      const maxDuration = durations.length ? Math.max(...durations) : 0;
      const minDuration = durations.length ? Math.min(...durations) : 0;
      
      console.log(`  Completed ${successfulResults.length}/${concurrency} concurrent requests in ${totalTime.toFixed(2)}s`);
      console.log(`  Avg: ${avgDuration.toFixed(2)}ms, Min: ${minDuration.toFixed(2)}ms, Max: ${maxDuration.toFixed(2)}ms`);
    } catch (error) {
      console.log(`Error during concurrency test (level ${concurrency}):`, error);
    }
    
    // Wait longer between concurrency tests to avoid throttling
    // Increase wait time for higher concurrency levels
    const waitTime = 10000 + (concurrency > 10 ? 5000 : 0);
    console.log(`Waiting ${waitTime/1000}s before next concurrency level test...`);
    await sleep(waitTime);
  }
}

/**
 * Clean up S3 objects created during testing
 */
async function cleanupS3Objects() {
  console.log('\nCleaning up S3 test objects...');
  
  try {
    // List all objects in the test-images prefix
    const listResponse = await s3.listObjectsV2({
      Bucket: S3_BUCKET_NAME,
      Prefix: 'test-images/'
    }).promise();
    
    if (listResponse.Contents && listResponse.Contents.length > 0) {
      // Delete all objects
      const deleteParams = {
        Bucket: S3_BUCKET_NAME,
        Delete: {
          Objects: listResponse.Contents.map(obj => ({ Key: obj.Key }))
        }
      };
      
      await s3.deleteObjects(deleteParams).promise();
      console.log(`Deleted ${listResponse.Contents.length} test objects from S3`);
    } else {
      console.log('No test objects found to delete');
    }
    
    // Also clean up results directory
    const resultsListResponse = await s3.listObjectsV2({
      Bucket: S3_BUCKET_NAME,
      Prefix: 'results/'
    }).promise();
    
    if (resultsListResponse.Contents && resultsListResponse.Contents.length > 0) {
      // Delete all result objects
      const deleteParams = {
        Bucket: S3_BUCKET_NAME,
        Delete: {
          Objects: resultsListResponse.Contents.map(obj => ({ Key: obj.Key }))
        }
      };
      
      await s3.deleteObjects(deleteParams).promise();
      console.log(`Deleted ${resultsListResponse.Contents.length} result objects from S3`);
    }
  } catch (error) {
    console.error(`Error cleaning up S3 objects: ${error.message}`);
  }
}

/**
 * Analyze test results and generate report
 */
async function analyzeResults() {
  console.log("\n=== ANALYZING RESULTS ===\n");
  
  // Save raw results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = `lambda_test_results_${timestamp}.json`;
  await writeFileAsync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`Raw results saved to ${resultsFile}`);
  
  // Generate summary report
  const report = [];
  
  // Helper to group results by criteria
  const groupBy = (array, key) => {
    return array.reduce((result, item) => {
      const keyValue = item[key];
      if (!result[keyValue]) {
        result[keyValue] = [];
      }
      result[keyValue].push(item);
      return result;
    }, {});
  };
  
  // Helper to calculate average
  const average = (array, key) => {
    if (!array.length) return 0;
    return array.reduce((sum, item) => sum + (item[key] || 0), 0) / array.length;
  };
  
  // Cold start vs warm start summary
  const coldWarmResults = results.filter(r => r.testType === 'cold_start' || r.testType === 'warm_start');
  if (coldWarmResults.length) {
    console.log("\nCold Start vs Warm Start Summary:");
    const byMemory = groupBy(coldWarmResults, 'memorySize');
    
    for (const memorySize in byMemory) {
      const memoryResults = byMemory[memorySize];
      const coldResults = memoryResults.filter(r => r.testType === 'cold_start');
      const warmResults = memoryResults.filter(r => r.testType === 'warm_start');
      
      const coldAvg = average(coldResults, 'totalDuration');
      const warmAvg = average(warmResults, 'totalDuration');
      const improvement = coldAvg > 0 ? ((coldAvg - warmAvg) / coldAvg * 100) : 0;
      
      console.log(`  ${memorySize}MB - Cold: ${coldAvg.toFixed(2)}ms, Warm: ${warmAvg.toFixed(2)}ms, Improvement: ${improvement.toFixed(1)}%`);
      
      // Add to report
      report.push({
        test_type: 'cold_vs_warm',
        memory_size: parseInt(memorySize),
        cold_avg_ms: coldAvg,
        warm_avg_ms: warmAvg,
        improvement_pct: improvement
      });
    }
  }
  
  // Operation performance summary - include only successful operations
  const opResults = results.filter(r => r.testType === 'operation_test' && !r.error);
  if (opResults.length) {
    console.log("\nOperation Performance Summary:");
    const byOperation = groupBy(opResults, 'operation');
    
    for (const operation in byOperation) {
      const opData = byOperation[operation];
      const bySize = groupBy(opData, 'imageSize');
      
      for (const size in bySize) {
        const sizeData = bySize[size];
        const avgProcessingTime = average(sizeData, 'processingTime');
        const avgTotalTime = average(sizeData, 'clientMeasuredDuration');
        
        console.log(`  ${operation} on ${size} image:`);
        console.log(`    Processing time: ${avgProcessingTime.toFixed(2)}ms`);
        console.log(`    Total time: ${avgTotalTime.toFixed(2)}ms`);
        
        // Add to report
        report.push({
          test_type: 'operation',
          operation,
          image_size: size,
          avg_processing_time_ms: avgProcessingTime,
          avg_total_time_ms: avgTotalTime
        });
      }
    }
  }
  
  // List unsuccessful operations
  const failedOpResults = results.filter(r => r.testType === 'operation_test' && r.error);
  if (failedOpResults.length) {
    console.log("\nFailed Operations Summary:");
    for (const result of failedOpResults) {
      console.log(`  ${result.operation} on ${result.imageSize} image failed: ${result.message || result.errorMessage || 'Unknown error'}`);
    }
  }
  
  // Concurrency performance summary
  const concurrencyResults = results.filter(r => r.concurrencyTest && !r.error);
  if (concurrencyResults.length) {
    console.log("\nConcurrency Performance Summary:");
    const byLevel = groupBy(concurrencyResults, 'concurrencyLevel');
    
    for (const level in byLevel) {
      const levelData = byLevel[level];
      const avgTime = average(levelData, 'totalDuration');
      const maxTime = Math.max(...levelData.map(r => r.totalDuration || 0));
      
      console.log(`  Concurrency ${level}: Avg: ${avgTime.toFixed(2)}ms, Max: ${maxTime.toFixed(2)}ms`);
      
      // Add to report
      report.push({
        test_type: 'concurrency',
        concurrency_level: parseInt(level),
        avg_duration_ms: avgTime,
        max_duration_ms: maxTime
      });
    }
  }
  
  // S3 vs Direct payload comparison
  const successfulResults = results.filter(r => !r.error);
  const bySourceType = groupBy(successfulResults, 'sourceType');
  if (bySourceType['s3'] && bySourceType['direct']) {
    console.log("\nS3 vs Direct Payload Comparison:");
    
    const s3Results = bySourceType['s3'];
    const directResults = bySourceType['direct'];
    
    const s3Avg = average(s3Results, 'totalDuration');
    const directAvg = average(directResults, 'totalDuration');
    
    console.log(`  S3 Source Avg: ${s3Avg.toFixed(2)}ms`);
    console.log(`  Direct Payload Avg: ${directAvg.toFixed(2)}ms`);
    console.log(`  Overhead: ${(s3Avg - directAvg).toFixed(2)}ms (${((s3Avg / directAvg) * 100 - 100).toFixed(1)}%)`);
    
    // Add to report
    report.push({
      test_type: 's3_vs_direct',
      s3_avg_ms: s3Avg,
      direct_avg_ms: directAvg,
      overhead_ms: s3Avg - directAvg,
      overhead_pct: (s3Avg / directAvg) * 100 - 100
    });
  }
  
  // Save summary report
  const reportFile = `lambda_test_report_${timestamp}.json`;
  await writeFileAsync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nSummary report saved to ${reportFile}`);
}

/**
 * Main function to run all tests
 */
async function main() {
  console.log("Starting Lambda Image Processing Performance Tests with S3 Support");
  
  try {
    // Load and prepare test images (upload larger ones to S3)
    const images = await loadTestImages();
    if (Object.keys(images).length === 0) {
      console.log("Error: No test images found. Tests cannot continue.");
      return;
    }
    
    // Run tests
    await testColdStartVsWarm(images);
    await testOperations(images);
    await testConcurrency(images);
    
    // Analyze results
    await analyzeResults();
    
    // Clean up S3 objects
    await cleanupS3Objects();
    
    console.log("\nAll tests completed successfully!");
    
  } catch (error) {
    console.error("Error during testing:", error);
  }
}

main();