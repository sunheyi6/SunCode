import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeHarborSettingsPatch,
  encodeHarborSettingsPatch,
  validateHarborSettingsPatch,
} from '../../scripts/terminal-bench-settings';

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

  it('runs a downloaded task directly from a local Harbor path', () => {
    const taskPath = join(process.cwd(), 'test', 'fixtures', 'terminal-bench-task');
    const result = spawnSync(
      'bun',
      [
        'run',
        'scripts/run-terminal-bench.ts',
        '--dry-run',
        '--path',
        taskPath,
        '--provider',
        'custom-ollama',
        '--model',
        'custom-ollama/glm5.2',
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
    expect(result.stderr).toContain(`--path ${taskPath}`);
    expect(result.stderr).not.toContain('--dataset terminal-bench/terminal-bench-2');
  });

  it('validates and round-trips feature settings without allowing runtime identity overrides', () => {
    const encoded = encodeHarborSettingsPatch({
      autoCompact: true,
      semanticCompactMode: 'replace',
      semanticCompactThreshold: 0.6,
    });

    expect(decodeHarborSettingsPatch(encoded)).toMatchObject({
      autoCompact: true,
      semanticCompactMode: 'replace',
      semanticCompactThreshold: 0.6,
    });
    expect(() => validateHarborSettingsPatch({ activeProvider: 'other' })).toThrow(
      'cannot override protected setting',
    );
    expect(() => validateHarborSettingsPatch({ unknownFeature: true })).toThrow(
      'Unknown SunCode setting',
    );
  });

  it('plans paired SunCode arms with the same exact task and different settings', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'suncode-terminal-bench-ab-'));
    try {
      const result = spawnSync(
        'bun',
        [
          'run',
          'scripts/run-terminal-bench-ab.ts',
          '--dry-run',
          '--run-id',
          'semantic-compact-test',
          '--out-dir',
          outDir,
          '--task',
          'sqlite-with-gcov',
          '--',
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
      expect(result.stderr).toContain('baseline-r0-sqlite-with-gcov settings={"semanticCompactMode":"off"}');
      expect(result.stderr).toContain('candidate-r0-sqlite-with-gcov settings={"semanticCompactMode":"replace"}');
      expect(result.stderr.match(/--agent-env SUNCODE_SETTINGS_PATCH_B64=\*\*\*/g)).toHaveLength(2);

      const manifest = JSON.parse(
        await readFile(join(outDir, 'semantic-compact-test', 'ab-manifest.json'), 'utf8'),
      ) as { tasks: string[]; arms: Array<{ settings: Record<string, unknown> }> };
      expect(manifest.tasks).toEqual(['sqlite-with-gcov']);
      expect(manifest.arms[0]?.settings).toEqual({ semanticCompactMode: 'off' });
      expect(manifest.arms[1]?.settings).toEqual({ semanticCompactMode: 'replace' });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
