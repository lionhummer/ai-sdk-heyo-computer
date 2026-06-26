// A coding-agent "harness" backed by a durable Heyo sandbox.
//
// Heyo's flagship use case is running coding agents in disposable/durable VMs.
// This wires the AI SDK's Experimental_Agent (a tool-loop agent) to a Heyo
// sandbox via createHeyoTools, reusing the same workspace across runs by name.
//
// Prerequisites:
//   1. A Heyo API key:  export HEYO_API_KEY=heyo_...
//   2. A model API key configured for the AI SDK.
//   3. Build this package first:  npm run build
import { Experimental_Agent as Agent, stepCountIs } from 'ai';
// import { getOrCreateHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';
import { getOrCreateHeyoSandbox, createHeyoTools } from '../src/index.js';

async function main() {
  // Durable workspace: same name ⇒ same sandbox reused across processes.
  const sandbox = await getOrCreateHeyoSandbox({
    name: 'coding-agent-demo',
    image: 'ubuntu:24.04',
    workingDirectory: '/workspace',
    ttlSeconds: 0, // unlimited (if your plan allows)
  });

  const agent = new Agent({
    model: 'openai/gpt-5.5',
    instructions:
      'You are a senior engineer working inside a Linux sandbox. Use the tools ' +
      'to inspect, write, and run code. Always verify your work by executing it.',
    tools: createHeyoTools(sandbox),
    stopWhen: stepCountIs(25),
  });

  const result = await agent.generate({
    prompt:
      'In /workspace, scaffold a tiny Node.js CLI that reverses its argument, ' +
      'add a package.json, run it with the input "heyo", and show the output.',
  });

  console.log(result.text);

  // Durable sandbox is intentionally NOT deleted here so you can reconnect to it.
  // Call `await sandbox.delete()` when you are truly done.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
