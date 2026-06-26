// Prerequisites:
//   1. heyvm binary installed and a Heyo cloud account.
//   2. A Heyo dashboard API key in HEYO_API_KEY — the CLI transport uses it to
//      `heyvm login --api-key` for you (no manual `heyvm login` needed).
//   3. A model API key configured for the AI SDK.
//   4. Build this package first: npm run build
//
// Cloud sandboxes require the CLI transport (`transport: 'cli'`). The CLI also
// gives you true stdout/stderr separation.
import { generateText, stepCountIs } from 'ai';
// import { createHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';
import { createHeyoSandbox, createHeyoTools } from '../src/index.js';

async function main() {
  await using sandbox = await createHeyoSandbox({
    transport: 'cli',
    apiKey: process.env.HEYO_API_KEY,
    cloud: true,
    region: 'US',
    sizeClass: 'small',
    image: 'ubuntu:24.04',
    ttlSeconds: 3600,
    cloudPorts: [8080],
  });

  console.log('Cloud sandbox ready:', sandbox.id);
  console.log(sandbox.description);

  // Expose a port and get a public URL (CLI transport supports `bind`).
  const endpoint = await sandbox.exposePort(8080);
  console.log('Public URL:', endpoint.url);

  const result = await generateText({
    model: 'openai/gpt-5.5',
    tools: createHeyoTools(sandbox),
    stopWhen: stepCountIs(8),
    prompt:
      'Start a simple HTTP server on port 8080 that returns "hello from heyo", ' +
      'then curl it locally and report the response.',
  });

  console.log(result.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
