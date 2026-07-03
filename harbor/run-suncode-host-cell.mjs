#!/usr/bin/env node

/**
 * SunCode Harbor host cell runner.
 *
 * Runs in the host environment (Windows/macOS), uses pi-ai to call the LLM,
 * and forwards tool executions (bash, read, grep, etc.) to the Docker
 * container via the _ToolExecutorServer HTTP bridge.
 *
 * Environment variables (set by suncode_agent.py):
 *   SUNCODE_INSTRUCTION_FILE   - path to the instruction file
 *   SUNCODE_OUTPUT_DIR         - where to write cell-output.json
 *   SUNCODE_STORAGE_ROOT       - scratch storage directory
 *   SUNCODE_WORKDIR            - working directory inside the container
 *   SUNCODE_HARBOR_TOOL_EXECUTOR_URL  - HTTP bridge URL
 *   SUNCODE_HARBOR_TOOL_EXECUTOR_TOKEN - HTTP bridge bearer token
 *   SUNCODE_MODEL              - model name, e.g. "deepseek/deepseek-v4-flash"
 *   SUNCODE_PROVIDER           - provider name, e.g. "deepseek"
 *   SUNCODE_SYSTEM_PROMPT      - optional system prompt override
 *   DEEPSEEK_API_KEY           - API key for DeepSeek
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { completeSimple } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main() {
  const env = process.env;

  // --- Resolve model ---
  const rawModel = env.SUNCODE_MODEL || env.HARBOR_MODEL || 'deepseek/deepseek-v4-flash';
  const provider = env.SUNCODE_PROVIDER || providerFromModel(rawModel);
  const model = await resolveModel(provider, stripProvider(rawModel, provider));
  if (!model) {
    throw new Error(`Model not found: ${provider}/${stripProvider(rawModel, provider)}`);
  }

  // --- Paths ---
  const outputDir = env.SUNCODE_OUTPUT_DIR || join(process.cwd(), 'agent');
  const storageRoot = env.SUNCODE_STORAGE_ROOT || join(outputDir, 'suncode-storage');
  const workdir = env.SUNCODE_WORKDIR || process.cwd();

  // --- Instruction ---
  const instruction = await readInstruction(env);
  if (!instruction) {
    throw new Error('No instruction provided via SUNCODE_INSTRUCTION or SUNCODE_INSTRUCTION_FILE');
  }

  // --- Build system prompt ---
  const systemPrompt = env.SUNCODE_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

  // --- Tool executor (HTTP bridge to Docker container) ---
  const toolExecutor = buildHttpToolExecutor(env);

  // --- Safely create output dir ---
  await mkdir(outputDir, { recursive: true });
  await mkdir(storageRoot, { recursive: true });

  // --- Token tracking ---
  const tokenSummary = { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0, cacheMissInput: 0 };
  let status = 'finished';
  let errorClass = undefined;
  let steps = 0;
  const actualToolNames = [];
  const actualToolCallCounts = {};
  const runtimeRefs = {
    sessionId: randomId(),
    runId: randomId(),
  };

  try {
    // --- Run the agent loop ---
    const loopResult = await runAgentLoop({
      model,
      instruction,
      systemPrompt,
      toolExecutor,
      workdir,
      tokenSummary,
      maxTurns: 50,
      actualToolNames,
      actualToolCallCounts,
      env,
    });
    steps = loopResult.turns;
  } catch (err) {
    status = 'failed';
    errorClass = err.constructor?.name || 'Error';
    console.error(`[SunCodeCell] Fatal error: ${err.message}`);
  }

  // --- Write cell output ---
  const output = {
    status,
    errorClass,
    steps,
    promptHash: simpleHash(systemPrompt + instruction),
    tokenSummary,
    toolSummary: {
      providerVisibleToolCount: 5,
      actualToolCalls: Object.values(actualToolCallCounts).reduce((a, b) => a + b, 0),
      actualToolNames,
      actualToolCallCounts,
    },
    runtimeRefs,
    runtimeEventsPath: join(outputDir, 'runtime-events.jsonl'),
  };

  const outputPath = join(outputDir, 'cell-output.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(`[SunCodeCell] Output written to ${outputPath}`);
  console.log(JSON.stringify({
    status: output.status,
    errorClass: output.errorClass,
    outputPath,
    runtimeEventsPath: output.runtimeEventsPath,
  }));
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are SunCode (running inside Harbor benchmark), an expert coding assistant.
Your task is to understand the instruction and complete it by executing commands
in the task environment via the available tools.

## Available Tools
- bash: Execute shell commands in the task container
- read: Read file contents
- grep: Search file contents
- glob: Find files by pattern
- ls: List directory contents

## Tool Call Format
When you need to use a tool, emit one or more tool calls exactly in this XML-like format:

<tool_call>
<tool_name>bash</tool_name>
<args>{"command":"sed -n '1,160p' README.md"}</args>
</tool_call>

Use valid JSON inside <args>. After tool results arrive, continue solving the task.

## Rules
1. First, explore the workspace to understand the task.
2. Then, implement the solution step by step.
3. Use bash to run tests and verify your solution.
4. When you believe the task is complete and all tests pass, output a final message
   summarizing what you did.
5. Be concise. Prefer bash to run verification commands.`;

async function runAgentLoop({ model, instruction, systemPrompt, toolExecutor, workdir, tokenSummary, maxTurns, actualToolNames, actualToolCallCounts, env }) {
  const messages = [
    { role: 'user', content: instruction, timestamp: Date.now() },
  ];

  let turns = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;

    // --- Call LLM ---
    const result = await completeSimple(model, {
      systemPrompt,
      messages,
    }, {
      maxTokens: 4096,
    });

    // Track tokens
    if (result.usage) {
      tokenSummary.input += result.usage.input || 0;
      tokenSummary.output += result.usage.output || 0;
      tokenSummary.cachedInput += result.usage.cacheRead || 0;
      tokenSummary.cacheWriteInput += result.usage.cacheWrite || 0;
      tokenSummary.cacheMissInput += Math.max(0, (result.usage.input || 0) - (result.usage.cacheRead || 0) - (result.usage.cacheWrite || 0));
    }

    // --- Extract assistant text & tool calls ---
    const content = assistantText(result);

    // Add assistant response to messages
    messages.push(result);

    // Check for tool calls in content (simple XML-like format)
    const toolCalls = parseToolCalls(content);

    if (toolCalls.length === 0) {
      // No more tool calls - assume task is complete
      console.log(`[SunCodeCell] No more tool calls after turn ${turns}, finishing.`);
      break;
    }

    // Execute tool calls
    for (const tc of toolCalls) {
      const toolName = tc.name;
      actualToolNames.push(toolName);
      actualToolCallCounts[toolName] = (actualToolCallCounts[toolName] || 0) + 1;

      let resultText;
      try {
        resultText = await executeTool(toolExecutor, toolName, tc.args, workdir);
      } catch (err) {
        resultText = `Error: ${err.message}`;
      }

      messages.push({
        role: 'user',
        content: `<tool_result tool="${toolName}">\n${resultText}\n</tool_result>`,
        timestamp: Date.now(),
      });
    }
  }

  return { turns };
}

function assistantText(message) {
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(executor, toolName, args, workdir) {
  switch (toolName) {
    case 'bash': {
      const result = await executor.exec({
        command: args.command,
        cwd: args.cwd || workdir,
        timeoutMs: args.timeout || 60000,
      });
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) {
        if (output) output += '\n--- stderr ---\n';
        output += result.stderr;
      }
      output += `\nExit code: ${result.exitCode}`;
      return output;
    }
    case 'read': {
      const result = await executor.exec({
        command: `cat ${quote(args.file_path)}`,
        cwd: workdir,
        timeoutMs: 10000,
      });
      if (result.exitCode !== 0) return `Error: ${result.stderr || result.stdout}`;
      const lines = result.stdout.split('\n');
      const offset = args.offset || 1;
      return lines.map((line, i) => `${offset + i}\t${line}`).join('\n');
    }
    case 'grep': {
      const pattern = args.pattern || args.pattern;
      const path = args.path || '.';
      const flags = args.ignoreCase ? '-i' : '';
      const result = await executor.exec({
        command: `grep ${flags} -r ${quote(pattern)} ${quote(path)} 2>&1 || true`,
        cwd: workdir,
        timeoutMs: 30000,
      });
      return result.stdout || '(no matches)';
    }
    case 'glob': {
      const result = await executor.exec({
        command: `find ${quote(args.path || '.')} -name ${quote(args.pattern)} 2>&1 | head -50 || true`,
        cwd: workdir,
        timeoutMs: 10000,
      });
      return result.stdout || '(no files)';
    }
    case 'ls': {
      const target = args.path || '.';
      const result = await executor.exec({
        command: `ls -la ${quote(target)} 2>&1`,
        cwd: workdir,
        timeoutMs: 10000,
      });
      return result.stdout || result.stderr || '';
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ---------------------------------------------------------------------------
// Simple XML-like tool call parser
// ---------------------------------------------------------------------------

function parseToolCalls(content) {
  const calls = [];
  const regex = /<tool_call>\s*<tool_name>(.*?)<\/tool_name>\s*<args>(.*?)<\/args>\s*<\/tool_call>/gs;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const name = match[1].trim();
    let args = {};
    try {
      args = JSON.parse(match[2].trim());
    } catch {
      args = { raw: match[2].trim() };
    }
    calls.push({ name, args });
  }
  return calls;
}

// ---------------------------------------------------------------------------
// HTTP tool executor (talks to _ToolExecutorServer in suncode_agent.py)
// ---------------------------------------------------------------------------

function buildHttpToolExecutor(env) {
  const baseUrl = requiredEnv(env, 'SUNCODE_HARBOR_TOOL_EXECUTOR_URL');
  const token = requiredEnv(env, 'SUNCODE_HARBOR_TOOL_EXECUTOR_TOKEN');
  return {
    exec: async (input) => {
      const response = await fetch(new URL('/exec', baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      const body = await response.text();
      if (!response.ok) {
        return { exitCode: 1, stdout: '', stderr: body };
      }
      const parsed = JSON.parse(body);
      return {
        exitCode: Number.isInteger(parsed.exitCode) ? parsed.exitCode : 1,
        stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
        stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveModel(provider, modelId) {
  try {
    return getModel(provider, modelId);
  } catch {
    console.warn(`[SunCodeCell] Model ${provider}/${modelId} not found in pi-ai registry`);
    return null;
  }
}

async function readInstruction(env) {
  if (env.SUNCODE_INSTRUCTION) return env.SUNCODE_INSTRUCTION;
  if (env.SUNCODE_INSTRUCTION_FILE) {
    try {
      return await readFile(env.SUNCODE_INSTRUCTION_FILE, 'utf8');
    } catch {
      throw new Error(`Cannot read instruction file: ${env.SUNCODE_INSTRUCTION_FILE}`);
    }
  }
  return null;
}

function providerFromModel(rawModel) {
  const separator = rawModel.indexOf('/');
  return separator >= 0 ? rawModel.slice(0, separator) : 'deepseek';
}

function stripProvider(rawModel, provider) {
  const prefix = `${provider}/`;
  return rawModel.startsWith(prefix) ? rawModel.slice(prefix.length) : rawModel;
}

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function quote(s) {
  // Simple shell quoting for Linux containers
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `host_cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function simpleHash(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[SunCodeCell] Fatal: ${message}`);
    process.exitCode = 1;
  });
}
