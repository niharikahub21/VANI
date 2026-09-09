// test-interruption.js
// Repeatable script to verify interruption handling.
// Sends a first request, then immediately sends a second request
// to simulate a user interrupting mid-response, and measures timing.

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function runInterruptionTest() {
  console.log('--- Starting interruption test ---');

  const start1 = Date.now();
  const firstRequest = axios.post(`${BASE_URL}/api/process`, {
    text: 'What are extensions',
  });

  // Wait 1 second (simulating the user starting to hear the response)
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const start2 = Date.now();
  console.log(`Sending interrupting command at +${start2 - start1}ms`);

  const secondRequest = axios.post(`${BASE_URL}/api/process`, {
    text: 'What are bottlenecks',
  });

  const [firstResult, secondResult] = await Promise.allSettled([
    firstRequest,
    secondRequest,
  ]);

  const end = Date.now();

  console.log(`First request status: ${firstResult.status}`);
  console.log(`Second request status: ${secondResult.status}`);

  if (secondResult.status === 'fulfilled') {
    console.log('Second (interrupting) response:', secondResult.value.data.spoken_response);
  }

  console.log(`Total test duration: ${end - start1}ms`);
  console.log('--- Test complete ---');
}

runInterruptionTest().catch((err) => console.error('Test failed:', err.message));