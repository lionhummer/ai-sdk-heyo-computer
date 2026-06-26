// Prerequisites:
//   1. A running heyvm API server:  heyvm --api --port 3000
//   2. A model API key configured for the AI SDK.
//   3. Build this package first:     npm run build
import { generateText, stepCountIs } from 'ai';
// In your own project, import from the package name instead:
//   import { createHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';
import { createHeyoSandbox, createHeyoTools } from '../src/index.js';

async function main() {
  await using sandbox = await createHeyoSandbox({
    apiUrl: process.env.HEYO_API_URL ?? 'http://localhost:3000',
    image: 'ubuntu:24.04',
    ttlSeconds: 3600,
  });

  // Batteries-included ToolSet: runCommand, readTextFile, writeTextFile,
  // listFiles (+ exposePort when the transport supports it).
  const tools = createHeyoTools(sandbox, { commandTimeoutMs: 60_000 });

  const result = await generateText({
    model: 'openai/gpt-5.5',
    tools,
    stopWhen: stepCountIs(10),
    prompt:
      'Create a file /tmp/app.py that prints the 50th prime number, run it, ' +
      'and tell me the output.',
  });

  console.log(result.text);
  // `await using` deletes the sandbox automatically on scope exit.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
