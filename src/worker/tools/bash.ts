import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { BaseTool, p, obj } from './types';

export function createBashTool(workingDir: string) {
  return new (class BashTool extends BaseTool {
    readonly name = 'bash';
    readonly description =
      'Executes a bash command and returns its stdout and stderr. The working directory is the project root. Commands have a default timeout of 60 seconds. Use this tool to run tests, build commands, git operations, and other shell tasks.\n\nIMPORTANT: Each invocation runs in a fresh shell. Use && to chain commands.\n\nSecurity: Commands that are obviously destructive (rm -rf /, etc.) will be blocked.';
    readonly parameters = obj(
      {
        command: p('string', 'The bash command to execute'),
        timeout: p('integer', 'Optional timeout in milliseconds (max 300000, default 60000)'),
        description: p(
          'string',
          'A short description of what this command does (5-10 words preferred)',
        ),
      },
      ['command'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const command = params.command as string;
      const timeout = Math.min((params.timeout as number) || 60000, 300000);

      if (!command) return this.failure('command is required');

      // Basic security check
      const dangerousPatterns = [
        /rm\s+-rf\s+\//,
        /mkfs\./,
        /dd\s+if=/,
        />\s*\/dev\/sd/,
        /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, // fork bomb
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return this.failure(`Command blocked for security reasons: dangerous pattern detected`);
        }
      }

      return new Promise((resolveResult) => {
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
        const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

        // Resolve working directory
        const cwd = resolve(workingDir);

        const child = spawn(shell, shellArgs, {
          cwd,
          env: process.env,
          timeout,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
          // Limit output size
          if (stdout.length > 100_000) {
            child.kill();
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 100_000) {
            child.kill();
          }
        });

        child.on('close', (code, signal) => {
          // Truncate output if too long
          const truncateLimit = 50_000;
          const truncatedStdout =
            stdout.length > truncateLimit
              ? `${stdout.slice(0, truncateLimit)}\n... (output truncated)`
              : stdout;
          const truncatedStderr =
            stderr.length > truncateLimit
              ? `${stderr.slice(0, truncateLimit)}\n... (stderr truncated)`
              : stderr;

          const parts: string[] = [];
          parts.push(`Command: ${command}`);
          parts.push(`Exit code: ${code !== null ? code : 'null'}`);
          if (signal) parts.push(`Signal: ${signal}`);

          if (truncatedStdout) {
            parts.push(`\nSTDOUT:\n${truncatedStdout}`);
          }
          if (truncatedStderr) {
            parts.push(`\nSTDERR:\n${truncatedStderr}`);
          }
          if (!truncatedStdout && !truncatedStderr) {
            parts.push('\n(no output)');
          }

          resolveResult(this.success(parts.join('\n')));
        });

        child.on('error', (error) => {
          resolveResult(this.failure(`Command execution failed: ${error.message}`));
        });
      });
    }
  })();
}
