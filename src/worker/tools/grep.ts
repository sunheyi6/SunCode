import { spawn } from 'node:child_process';
import { resolve, isAbsolute, normalize } from 'node:path';
import { BaseTool, p, obj } from './types';

export function createGrepTool(workingDir: string) {
  return new (class GrepTool extends BaseTool {
    readonly name = 'grep';
    readonly description =
      'Searches for a regular expression pattern in file contents. Uses ripgrep syntax (not grep). Supports full regex, file type filtering, context lines, and more. Prefer this over running `grep` or `rg` via bash.\n\nFor multiline patterns, set multiline: true. For case-insensitive search, set ignoreCase: true.';
    readonly parameters = obj(
      {
        pattern: p('string', 'The regular expression pattern to search for'),
        path: p('string', 'File or directory to search in (default: working directory)'),
        glob: p('string', 'Glob pattern to filter files (e.g. "*.ts", "*.{js,ts}")'),
        type: p(
          'string',
          'File type to search (e.g. "js", "py", "rust", "ts"). More efficient than glob.',
        ),
        multiline: p('boolean', 'Enable multiline mode (default: false)'),
        ignoreCase: p('boolean', 'Case insensitive search (default: false)'),
        context: p('integer', 'Number of lines to show before and after each match'),
        head_limit: p('integer', 'Limit output to first N lines (default: 100)'),
      },
      ['pattern'],
    );

    async execute(params: Record<string, unknown>): Promise<ReturnType<BaseTool['execute']>> {
      const pattern = params.pattern as string;
      const searchPath = (params.path as string) || workingDir;
      const glob = params.glob as string | undefined;
      const fileType = params.type as string | undefined;
      const multiline = Boolean(params.multiline);
      const ignoreCase = Boolean(params.ignoreCase);
      const context = (params.context as number) || 0;
      const headLimit = (params.head_limit as number) || 100;

      if (!pattern) return this.failure('pattern is required');

      const absPath = isAbsolute(searchPath) ? searchPath : resolve(workingDir, searchPath);
      const normalized = normalize(absPath);

      // Build ripgrep arguments
      const args: string[] = ['--no-heading', '--line-number', '--color', 'never'];

      if (multiline) {
        args.push('--multiline', '--multiline-dotall');
      }

      if (ignoreCase) {
        args.push('--ignore-case');
      }

      if (context > 0) {
        args.push('-C', String(context));
      }

      if (glob) {
        args.push('--glob', glob);
      }

      if (fileType) {
        args.push('--type', fileType);
      }

      args.push('--', pattern, '.');

      return new Promise((resolveResult) => {
        const child = spawn('rg', args, {
          cwd: normalized,
          env: process.env,
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', (code) => {
          if (code === 0 && stdout) {
            const lines = stdout.split('\n');
            const trimmed = lines.slice(0, headLimit).join('\n');
            const suffix =
              lines.length > headLimit ? `\n... and ${lines.length - headLimit} more matches` : '';
            resolveResult(
              this.success(`Found ${lines.length - 1} matches:\n\n${trimmed}${suffix}`),
            );
          } else if (code === 1) {
            resolveResult(this.success('No matches found.'));
          } else {
            // rg not found or error - fall back to node-based search
            resolveResult(
              this.failure(
                `ripgrep (rg) not available. Please install ripgrep or use bash to run grep. Error: ${stderr || 'unknown'}`,
              ),
            );
          }
        });

        child.on('error', () => {
          resolveResult(
            this.failure(
              'ripgrep (rg) is not installed. Install it from https://github.com/BurntSushi/ripgrep',
            ),
          );
        });
      });
    }
  })();
}
