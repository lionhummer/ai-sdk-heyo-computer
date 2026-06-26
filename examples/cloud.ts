// Self-hosted Heyo: the same SDK surface works against a `heyvm --api` server
// running anywhere. Just point `baseUrl` at it.
//
// Prerequisites:
//   1. A heyvm server reachable over HTTP:  heyvm --api --port 3000
//   2. A model API key configured for the AI SDK.
//   3. Build this package first:  npm run build
import { generateText, stepCountIs } from 'ai';
// import { createHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';
import { createHeyoSandbox, createHeyoTools } from '../src/index.js';

async function main() {
  await using sandbox = await createHeyoSandbox({
    // A local/self-hosted daemon needs no API key; a remote one may.
    baseUrl: process.env.HEYO_BASE_URL ?? 'http://localhost:3000',
    apiKey: process.env.HEYO_API_KEY,
    image: 'ubuntu:24.04',
    ttlSeconds: 3600,
  });

  const result = await generateText({
    model: 'openai/gpt-5.5',
    tools: createHeyoTools(sandbox),
    stopWhen: stepCountIs(10),
    prompt: 'Print the kernel version and the current working directory.',
  });

  console.log(result.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
