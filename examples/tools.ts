// Prerequisites:
//   1. A Heyo API key:  export HEYO_API_KEY=heyo_...
//   2. A model API key configured for the AI SDK.
//   3. Build this package first:  npm run build
import { generateText, stepCountIs } from 'ai';
// In your own project, import from the package name instead:
//   import { createHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';
import { createHeyoSandbox, createHeyoTools } from '../src/index.js';

async function main() {
  await using sandbox = await createHeyoSandbox({
    image: 'ubuntu:24.04',
    ttlSeconds: 3600,
  });

  // Anthropic-style ToolSet: bash, str_replace_based_edit_tool, exposePort.
  const tools = createHeyoTools(sandbox, { commandTimeoutMs: 60_000 });

  const result = await generateText({
    model: 'openai/gpt-5.5',
    tools,
    stopWhen: stepCountIs(10),
    prompt:
      'Create a file /workspace/app.py that prints the 50th prime number, run it, ' +
      'and tell me the output.',
  });

  console.log(result.text);
  // `await using` deletes the sandbox automatically on scope exit.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
