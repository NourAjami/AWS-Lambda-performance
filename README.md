# AWS-Lambda-performance

This project provides a comprehensive suite of Node.js scripts for analyzing the performance characteristics of AWS Lambda functions for image processing workloads. The suite is designed to evaluate various performance aspects including cold start behavior, concurrency handling, memory allocation impacts, and operation-specific performance metrics.
Project Components

**Lambda Function (index.mjs)** - An AWS Lambda function that performs image processing using the Jimp library
**Scalability Tests (scalability-js.js)** - Tests Lambda's behavior under varying concurrency levels
**Comprehensive Performance Tests (js-test-script.js)** - Evaluates performance across different image sizes, operations, and memory configurations
**Cold Start Analysis (cold-start-js.js)** - Specifically analyzes cold start behavior with different inactivity periods
