// Prerequisites:
//   1. A running heyvm API server:  heyvm --api --port 3000
//   2. A model API key (e.g. AI Gateway / OpenAI) configured for the AI SDK.
//   3. Build this package first:     npm run build
import { generateText, tool } from 'ai';
import * as z from 'zod';
// In your own project, import from the package name instead:
//   import { createHeyoSandbox } from 'ai-sdk-heyo-computer';
import { createHeyoSandbox } from '../src/index.js';

async function main() {
  // Assumes `heyvm --api --port 3000` is running locally.
  const sandbox = await createHeyoSandbox({
    apiUrl: process.env.HEYO_API_URL ?? 'http://localhost:3000',
    token: process.env.HEYO_TOKEN,
    image: 'ubuntu:24.04',
    ttlSeconds: 3600,
  });

  try {
    const result = await generateText({
      model: 'openai/gpt-5.5',
      experimental_sandbox: sandbox,
      tools: {
        runCommand: tool({
          description: 'Run a shell command inside the sandbox.',
          inputSchema: z.object({
            command: z.string(),
            workingDirectory: z.string().optional(),
          }),
          execute: async (
            { command, workingDirectory },
            { abortSignal, experimental_sandbox },
          ) => {
            if (!experimental_sandbox) {
              throw new Error('Sandbox is not available');
            }
            return experimental_sandbox.run({
              command,
              workingDirectory,
              abortSignal,
            });
          },
        }),
      },
      prompt:
        'Write a Python script that prints the 100th Fibonacci number, then run it.',
    });

    console.log(result.text);
  } finally {
    await sandbox.delete();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
