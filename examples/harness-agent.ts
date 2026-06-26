// A coding-agent "harness" backed by a durable Heyo sandbox.
//
// Heyo's flagship use case is running coding agents in disposable/durable VMs.
// This wires the AI SDK's Experimental_Agent (a tool-loop agent) to a heyo
// sandbox via createHeyoTools, with a persistent slug so the same workspace is
// reused across runs.
//
// Prerequisites:
//   1. heyvm installed (CLI transport) and, for cloud, logged in (`heyvm login`).
//   2. A model API key configured for the AI SDK.
//   3. Build this package first: npm run build
import { Experimental_Agent as Agent, stepCountIs } from 'ai';
// import { getOrCreateHeyoSandbox, createHeyoTools } from 'ai-sdk-heyo-computer';
import { getOrCreateHeyoSandbox, createHeyoTools } from '../src/index.js';

async function main() {
  // Durable workspace: same slug ⇒ same sandbox across processes/machines.
  const sandbox = await getOrCreateHeyoSandbox({
    transport: 'cli',
    slug: 'coding-agent-demo',
    image: 'ubuntu:24.04',
    // Optionally pre-install a coding-agent CLI inside the VM:
    // agent: 'claude',
    // For a cloud workspace instead of local, add: cloud: true, region: 'US'.
    workingDirectory: '/workspace',
    noTtl: true,
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
