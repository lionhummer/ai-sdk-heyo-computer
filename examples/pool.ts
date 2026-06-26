// Best-of-N: run the same task in N parallel sandboxes and keep the best result.
//
// Prerequisites:
//   1. A running heyvm API server (`heyvm --api --port 3000`) or `transport: 'cli'`.
//   2. A model API key configured for the AI SDK.
//   3. Build this package first: npm run build
import { generateText, stepCountIs } from 'ai';
// import { createHeyoSandboxPool, createHeyoTools } from 'ai-sdk-heyo-computer';
import { createHeyoSandboxPool, createHeyoTools } from '../src/index.js';

async function main() {
  await using pool = await createHeyoSandboxPool({
    size: 3,
    apiUrl: process.env.HEYO_API_URL ?? 'http://localhost:3000',
    image: 'ubuntu:24.04',
    ttlSeconds: 1800,
  });

  const task =
    'Write /tmp/solution.py solving FizzBuzz up to 30, run it, and print the output.';

  const { result, index } = await pool.best(
    async (sandbox) => {
      const r = await generateText({
        model: 'openai/gpt-5.5',
        tools: createHeyoTools(sandbox),
        stopWhen: stepCountIs(8),
        prompt: task,
      });
      // Verify the candidate actually produced a runnable file.
      const check = await sandbox.exec({ command: 'python3 /tmp/solution.py' });
      return { text: r.text, exitCode: check.exitCode, output: check.stdout };
    },
    // Score: prefer candidates whose script ran cleanly and printed FizzBuzz.
    (candidate) =>
      (candidate.exitCode === 0 ? 1 : 0) +
      (candidate.output.includes('FizzBuzz') ? 1 : 0),
  );

  console.log(`Winner: sandbox #${index}`);
  console.log(result.output);
  // `await using` disposes the whole pool on scope exit.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
