import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('terminal-bench runner', () => {
  const customEndpointsJson =
    '[{"id":"custom-ollama","name":"Ollama","baseUrl":"http://127.0.0.1:11434/v1","apiKey":"ollama","apiFormat":"openai-completions","models":[{"id":"glm5.2"}]}]';

  it('allows custom providers in dry-run harbor args', () => {
    const result = spawnSync(
      'bun',
      [
        'run',
        'scripts/run-terminal-bench.ts',
        '--dry-run',
        '--provider',
        'custom-ollama',
        '--model',
        'custom-ollama/glm5.2',
        '--dataset',
        'terminal-bench-sample@2.0',
        '--no-proxy',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_COLOR: '1',
          SUNCODE_CUSTOM_ENDPOINTS: customEndpointsJson,
        },
        shell: process.platform === 'win32',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('--model custom-ollama/glm5.2');
    expect(result.stderr).toContain('--agent-env SUNCODE_PROVIDER=custom-ollama');
    expect(result.stderr).toContain('--agent-env SUNCODE_MODEL=glm5.2');
    expect(result.stderr).toContain('--agent-env SUNCODE_CUSTOM_ENDPOINTS_B64=***');
    expect(result.stderr).not.toContain('--agent-env SUNCODE_CUSTOM_ENDPOINTS=');
  });

  it('passes custom endpoints when provided as base64', () => {
    const result = spawnSync(
      'bun',
      [
        'run',
        'scripts/run-terminal-bench.ts',
        '--dry-run',
        '--provider',
        'custom-ollama',
        '--model',
        'custom-ollama/glm5.2',
        '--dataset',
        'terminal-bench-sample@2.0',
        '--no-proxy',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_COLOR: '1',
          SUNCODE_CUSTOM_ENDPOINTS_B64: Buffer.from(customEndpointsJson, 'utf8').toString('base64'),
        },
        shell: process.platform === 'win32',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('--agent-env SUNCODE_CUSTOM_ENDPOINTS_B64=***');
  });
});
