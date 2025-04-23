/**
 * AWS Lambda Function for Image Processing Performance Analysis
 * Using Jimp library
 */

// Import Jimp correctly in ES Modules according to docs
import { Jimp } from "jimp";
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

// Configuration constants
const OPERATIONS = {
  RESIZE: 'resize',
  COLOR_ADJUSTMENT: 'color-adjustment',
  COMPLEX_FILTERING: 'complex-filtering',
  FORMAT_CONVERSION: 'format-conversion',
  WATERMARK: 'watermark'
};

// Track cold start
const coldStartTime = Date.now();
let isWarmStart = false;

/**
 * Main Lambda handler function
 */
export const handler = async (event, context) => {
  // Start timing for overall execution
  const startTime = Date.now();
  
  // Track if this is a cold start
  const thisColdStart = !isWarmStart;
  const coldStartLatency = thisColdStart ? Date.now() - coldStartTime : 0;
  isWarmStart = true; // Set for future invocations
  
  try {
    // Extract parameters from the event
    const {
      operation = OPERATIONS.RESIZE,
      image, // base64-encoded image
      imageSource, // S3 reference { bucket, key }
      sourceType, 
      options = {},
      requestId = null // For tracking cold-start test requests
    } = event;
    
    // Variable to hold our image buffer
    let imageBuffer;
    
    // Handle different source types
    if (sourceType === 's3') {
      if (!imageSource || !imageSource.bucket || !imageSource.key) {
        throw new Error('S3 source requires bucket and key properties');
      }
      
      console.log(`Downloading image from S3: s3://${imageSource.bucket}/${imageSource.key}`);
      
      try {
        // Import AWS SDK for S3 operations
        const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
        
        // Initialize S3 client
        const s3Client = new S3Client({ region: process.env.AWS_REGION });
        
        // Get the object from S3
        const s3Response = await s3Client.send(
          new GetObjectCommand({
            Bucket: imageSource.bucket,
            Key: imageSource.key,
          })
        );
        
        // Read the S3 object stream into a buffer
        const chunks = [];
        for await (const chunk of s3Response.Body) {
          chunks.push(chunk);
        }
        imageBuffer = Buffer.concat(chunks);
        
        console.log(`Successfully downloaded image from S3 (${imageBuffer.length} bytes)`);
      } catch (error) {
        console.error('Error downloading from S3:', error);
        throw new Error(`Failed to download image from S3: ${error.message}`);
      }
    } else {
      // Direct image data provided in request
      if (!image) {
        throw new Error('Image data is required for direct mode');
      }
      
      // Decode base64 image
      imageBuffer = Buffer.from(image, 'base64');
    }
    
    // Resource utilization metrics
    const memoryUsage = process.memoryUsage();
    
    // Create performance metadata
    const perfData = {
      coldStart: thisColdStart,
      coldStartLatency: coldStartLatency,
      operationType: operation,
      sourceType: sourceType || 'direct',
      memoryAllocated: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
      startTime: startTime,
      inputSize: imageBuffer.length,
      memoryUsage: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024)
      }
    };
    
    // Check if we need to store the result in S3
    const storeResultInS3 = options.storeResultInS3 === true;
    let s3ResultLocation = null;
    
    // Process image based on the requested operation
    console.log(`Processing image with operation: ${operation}`);
    let processedImage;
    
    try {
      const processingStart = Date.now();
      processedImage = await processImage(imageBuffer, operation, options);
      perfData.processingTime = Date.now() - processingStart;
    } catch (error) {
      console.error('Error processing image:', error);
      // Even if image processing fails, we still return performance data
      perfData.totalDuration = Date.now() - startTime;
      perfData.error = error.message;
      
      return {
        statusCode: 500,
        performanceData: perfData,
        error: error.message
      };
    }
    
    // Calculate final metrics
    perfData.totalDuration = Date.now() - startTime;
    
    // Handle different return structures
    let finalImage, intermediateResults;
    if (processedImage.final) {
      finalImage = processedImage.final;
      intermediateResults = processedImage.intermediateResults || [];
      perfData.outputSize = finalImage.data.length;
      perfData.compressionRatio = (imageBuffer.length / finalImage.data.length).toFixed(2);
    } else {
      finalImage = processedImage;
      intermediateResults = [];
      perfData.outputSize = processedImage.data.length;
      perfData.compressionRatio = (imageBuffer.length / processedImage.data.length).toFixed(2);
    }
    
    // Store result in S3 if requested
    if (storeResultInS3) {
      try {
        const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
        const s3Client = new S3Client({ region: process.env.AWS_REGION });
        
        const resultBucket = options.resultS3Bucket || imageSource?.bucket;
        const resultKey = `${options.resultS3Prefix || 'results'}/${operation}-${Date.now()}.${finalImage.format}`;
        
        await s3Client.send(
          new PutObjectCommand({
            Bucket: resultBucket,
            Key: resultKey,
            Body: finalImage.data,
            ContentType: `image/${finalImage.format}`
          })
        );
        
        s3ResultLocation = {
          bucket: resultBucket,
          key: resultKey
        };
        
        console.log(`Stored result in S3: s3://${resultBucket}/${resultKey}`);
      } catch (error) {
        console.error('Error storing result in S3:', error);
      }
    }
    
    // Add final memory usage
    const finalMemoryUsage = process.memoryUsage();
    perfData.peakMemoryUsage = {
      rss: Math.round(finalMemoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(finalMemoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(finalMemoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(finalMemoryUsage.external / 1024 / 1024)
    };
    
    console.log('Performance data:', JSON.stringify(perfData, null, 2));
    
    // Check if we should skip returning the image data to reduce response size
    const skipImageData = options.skipImageData === true;
    
    return {
      statusCode: 200,
      performanceData: perfData, 
      final: {
        data: skipImageData ? 'Image data skipped to reduce response size' : 
              (finalImage.data.length < 6000000 ? finalImage.data.toString('base64') : 'Image too large to return in response'),
        format: finalImage.format,
        info: finalImage.info,
        s3Location: s3ResultLocation // This will be null if not stored in S3
      },
      intermediateResults: skipImageData ? [] : intermediateResults
    };
  } catch (error) {
    console.error('Unhandled error in Lambda handler:', error);
    
    // Create basic performance data even for errors
    const errorPerfData = {
      coldStart: thisColdStart,
      coldStartLatency: thisColdStart ? Date.now() - coldStartTime : 0,
      totalDuration: Date.now() - startTime,
      error: error.message
    };
    
    return {
      statusCode: 500,
      performanceData: errorPerfData,  
      error: error.message,
      stack: error.stack
    };
  }
};

/**
 * Process image based on the requested operation using Jimp
 */
async function processImage(imageBuffer, operation, options) {
  // Early check for skipImageData to avoid unnecessary processing
  const skipImageData = options.skipImageData === true;
  const returnIntermediateResults = options.returnIntermediateResults === true;
  
  // Load image with Jimp
  const image = await Jimp.read(imageBuffer);
  
  // Define the correct MIME types
  const MIME_TYPES = {
    JPEG: 'image/jpeg',
    PNG: 'image/png', 
    BMP: 'image/bmp',
    GIF: 'image/gif'
  };
  
  // Define format map early so it can be used by saveIntermediateResult
  const formatMap = {
    [MIME_TYPES.JPEG]: 'jpeg',
    [MIME_TYPES.PNG]: 'png',
    [MIME_TYPES.BMP]: 'bmp',
    [MIME_TYPES.GIF]: 'gif'
  };
  
  let format = options.outputFormat || MIME_TYPES.JPEG;
  let quality = options.quality || 80;
  
  // Track intermediate results if requested
  const intermediateResults = [];
  const saveIntermediateResult = async (label) => {
    if (returnIntermediateResults) {
      const buffer = await image.getBuffer(format);
      intermediateResults.push({
        label,
        data: buffer,
        format: formatMap[format] || 'jpeg',
        info: {
          width: image.width,
          height: image.height,
          format: format
        }
      });
    }
  };
  
  // Apply operations
  switch (operation) {
    case OPERATIONS.RESIZE:
      // Simple resize operation
      const width = options.width || 800;
      const height = options.height || Jimp.AUTO;
      image.resize({ w: width, h: height });
      await saveIntermediateResult('resize');
      break;
      
    case OPERATIONS.COLOR_ADJUSTMENT:
      // Color adjustment operations
      if (options.brightness !== undefined) {
        // Jimp brightness is from -1 to +1
        const brightness = Math.max(-1, Math.min(1, (options.brightness - 1)));
        image.brightness(brightness);
      }
      
      if (options.contrast !== undefined) {
        // Jimp contrast is from -1 to +1
        const contrast = Math.max(-1, Math.min(1, (options.contrast - 1)));
        image.contrast(contrast);
      }
      
      // Saturation in Jimp
      if (options.saturation !== undefined) {
        const saturation = options.saturation - 1; 
        // Note: Jimp doesn't have direct saturation, we can simulate with color manipulation
        if (saturation > 0) {
          image.color([
            { apply: 'saturate', params: [saturation * 100] }
          ]);
        } else if (saturation < 0) {
          image.color([
            { apply: 'desaturate', params: [Math.abs(saturation) * 100] }
          ]);
        }
      }
      
      // Additional adjustments
      if (options.grayscale) {
        image.greyscale();
      }
      
      await saveIntermediateResult('color-adjustment');
      break;
      
    case OPERATIONS.COMPLEX_FILTERING:
      // Complex filtering operations
      
      // Apply blur if specified
      if (options.blur) {
        const radius = options.blurSigma || 5;
        image.blur(radius);
      }
      
      // Apply gaussian blur 
      if (options.gaussianBlur) {
        const radius = options.gaussianRadius || 3;
        image.gaussian(radius);
      }
      
      // Apply posterize
      if (options.posterize) {
        const levels = options.posterizeLevels || 5;
        image.posterize(levels);
      }
      
      // Apply sepia
      if (options.sepia) {
        image.sepia();
      }
      
      // Apply dither
      if (options.dither) {
        image.dither565();
      }
      
      // Apply normalize for tone adjustment
      if (options.normalise || options.normalize) {
        image.normalize();
      }
      
      // Invert colors
      if (options.invert) {
        image.invert();
      }
      
      await saveIntermediateResult('complex-filtering');
      break;
      
    case OPERATIONS.FORMAT_CONVERSION:
      // Format conversion operations
      switch (options.targetFormat) {
        case 'jpeg':
          format = MIME_TYPES.JPEG;
          break;
          
        case 'png':
          format = MIME_TYPES.PNG;
          break;
          
        case 'bmp':
          format = MIME_TYPES.BMP;
          break;
          
        case 'gif':
          format = MIME_TYPES.GIF;
          break;
          
        default:
          format = MIME_TYPES.JPEG;
      }
      
      // Quality setting (0-100)
      quality = options.quality || 80;
      await saveIntermediateResult('format-conversion');
      break;
      
    case OPERATIONS.WATERMARK:
      await saveIntermediateResult('watermark');
      break;
      
    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
  
  // Get image info for metadata
  const imageInfo = {
    width: image.width,
    height: image.height,
    format: format
  };
  
  // Get final buffer
  const buffer = await image.getBuffer(format);
  
  // If intermediate results requested, return them along with final result
  if (returnIntermediateResults) {
    return {
      final: {
        data: skipImageData ? Buffer.from('') : buffer,
        format: formatMap[format] || 'jpeg',
        info: imageInfo
      },
      intermediateResults: skipImageData ? [] : intermediateResults
    };
  }
  
  // Otherwise, just return the final result
  return {
    data: skipImageData ? Buffer.from('') : buffer,
    format: formatMap[format] || 'jpeg',
    info: imageInfo
  };
}