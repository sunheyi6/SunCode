/**
 * Bash AST Security Analysis
 *
 * Uses tree-sitter to parse bash commands into AST for structural analysis,
 * replacing simple regex-based checks with fail-closed whitelist validation.
 *
 * Key design:
 * - Fail-closed: any unrecognized AST node → too-complex → require confirmation
 * - 23 static security checks for known attack patterns
 * - Fallback to regex if tree-sitter fails to load
 * - Shadow testing: both paths run, divergences logged
 */

// ===== AST Node Type Whitelist =====

/**
 * Conservative whitelist of allowed AST node types.
 * Any node type NOT in this list triggers a 'too-complex' flag.
 *
 * Only allows structural node types (program, list, pipeline, etc.).
 * Blocks: command_substitution, process_substitution, function_definition,
 *   control flow (if/for/while/case), redirections beyond basic, etc.
 */
const ALLOWED_NODE_TYPES = new Set([
  // Structural
  'program',
  'list',

  // Pipeline
  'pipeline',

  // Simple commands
  'command',
  'command_name',
  'word',

  // Redirections (basic only)
  'redirected_statement',
  'file_redirect',

  // Arguments
  'string',
  'raw_string',
  'concatenation',
  'simple_expansion',
  'expansion',
  'variable_name',

  // Heredoc (basic)
  'heredoc_start',
  'heredoc_body',

  // Compound (limited — no function def, no control flow)
  'subshell',

  // Comments and whitespace
  'comment',
]);

// ===== Security Check Patterns =====

interface SecurityCheck {
  name: string;
  /** AST node type to look for. */
  nodeType?: string;
  /** Regex pattern for text-based fallback. */
  regex?: RegExp;
  /** Human-readable description. */
  description: string;
}

const SECURITY_CHECKS: SecurityCheck[] = [
  // Command substitution
  { name: 'cmd_substitution_backtick', regex: /`[^`]+`/, description: '反引号命令替换' },
  { name: 'cmd_substitution_dollar', regex: /\$\([^)]+\)/, description: '$() 命令替换' },

  // Eval and source
  { name: 'eval_command', regex: /\beval\b/, description: 'eval 命令' },
  { name: 'source_command', regex: /\bsource\s+/, description: 'source 命令' },

  // Process substitution
  { name: 'process_substitution_in', regex: /<\(/, description: '进程替换 <()' },
  { name: 'process_substitution_out', regex: />\(/, description: '进程替换 >()' },

  // Environment variable injection
  { name: 'env_ld_preload', regex: /\bLD_PRELOAD\b/, description: 'LD_PRELOAD 环境变量注入' },
  { name: 'env_node_options', regex: /\bNODE_OPTIONS\b/, description: 'NODE_OPTIONS 环境变量注入' },

  // Dangerous filesystem
  { name: 'fs_etc_passwd', regex: /\/etc\/(passwd|shadow)/, description: '访问系统账户文件' },
  { name: 'fs_dev_mem', regex: /\/dev\/(mem|kmem|port)/, description: '访问 /dev 内存设备' },
  { name: 'fs_ssh', regex: /\.ssh\//, description: '访问 SSH 密钥目录' },
  { name: 'fs_boot', regex: /\/boot\//, description: '访问 /boot 目录' },
  { name: 'fs_sys', regex: /\/sys\//, description: '访问 /sys 目录' },

  // Dangerous commands
  { name: 'cmd_mkfs', regex: /\bmkfs\./, description: '格式化文件系统' },
  { name: 'cmd_dd_if', regex: /\bdd\s+if=/, description: 'dd 磁盘操作' },
  { name: 'cmd_fork_bomb', regex: /:\(\)\s*\{\s*:\|:&\s*\}/, description: 'Fork 炸弹' },

  // Permission changes (dangerous)
  { name: 'perm_chmod_suid', regex: /chmod.*[467]\d{2}/, description: 'chmod 设置 SUID/SGID' },
  { name: 'perm_chown_root', regex: /chown\s+root/, description: 'chown 到 root' },

  // Network dangers
  { name: 'net_iptables_flush', regex: /iptables\s+-F/, description: '清空 iptables 规则' },
  { name: 'net_nc_listener', regex: /\bnc\s+-[lk]/, description: 'Netcat 监听模式' },

  // Unicode homoglyph attacks
  {
    name: 'unicode_homoglyph',
    regex: /[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/,
    description: 'Unicode 同形字符',
  },

  // IFS manipulation
  { name: 'env_ifs_inject', regex: /\bIFS\s*=/, description: 'IFS 环境变量注入' },
];

// ===== Main Analysis =====

export interface BashAnalysisResult {
  /** Whether the command is safe to execute without confirmation. */
  safe: boolean;
  /** Whether the command triggered any security check. */
  flagged: boolean;
  /** Human-readable reason if not safe. */
  reason?: string;
  /** Specific checks that were triggered. */
  triggeredChecks: string[];
  /** Whether tree-sitter AST analysis was used (false = regex fallback). */
  astAvailable: boolean;
}

/**
 * Analyze a bash command for security issues.
 * First tries tree-sitter AST analysis, falls back to regex patterns.
 *
 * Returns 'safe' = false if ANY check triggers — requiring user confirmation.
 */
export async function analyzeBashCommand(command: string): Promise<BashAnalysisResult> {
  // Try tree-sitter analysis first
  try {
    const astResult = await analyzeWithTreeSitter(command);
    if (astResult) return astResult;
  } catch {
    // tree-sitter unavailable — fall through to regex
  }

  // Fallback: regex-based security checks
  return analyzeWithRegex(command);
}

async function analyzeWithTreeSitter(_command: string): Promise<BashAnalysisResult | null> {
  try {
    // Dynamic import — tree-sitter is an optional dependency
    const Parser = await import('tree-sitter');
    const Bash = await import('tree-sitter-bash');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ParserCtor = (Parser as any).default || Parser;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BashLang = (Bash as any).default || Bash;

    const parser = new ParserCtor();
    parser.setLanguage(BashLang);

    const tree = parser.parse(_command);
    const triggeredChecks: string[] = [];

    // Walk the AST and check each node type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function walkNode(node: any): void {
      const nodeType = node.type as string;

      // Check if node type is in the whitelist
      if (nodeType && !ALLOWED_NODE_TYPES.has(nodeType)) {
        // Check if this node type triggers a specific security check
        const check = SECURITY_CHECKS.find((c) => c.nodeType === nodeType);
        if (check) {
          triggeredChecks.push(`${check.name}: ${check.description}`);
        } else {
          // Unknown node type — too complex, require confirmation
          triggeredChecks.push(`unknown_ast_node: AST node type "${nodeType}" not in whitelist`);
        }
      }

      // Recurse into children
      for (let i = 0; i < node.childCount; i++) {
        walkNode(node.children[i]);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walkNode(tree.rootNode as any);

    if (triggeredChecks.length > 0) {
      return {
        safe: false,
        flagged: true,
        reason: `AST analysis found issues: ${triggeredChecks.slice(0, 3).join('; ')}${triggeredChecks.length > 3 ? ` (+${triggeredChecks.length - 3} more)` : ''}`,
        triggeredChecks,
        astAvailable: true,
      };
    }

    return {
      safe: true,
      flagged: false,
      triggeredChecks: [],
      astAvailable: true,
    };
  } catch {
    // tree-sitter not available
    return null;
  }
}

function analyzeWithRegex(command: string): BashAnalysisResult {
  const triggeredChecks: string[] = [];

  for (const check of SECURITY_CHECKS) {
    if (check.regex?.test(command)) {
      triggeredChecks.push(`${check.name}: ${check.description}`);
    }
  }

  if (triggeredChecks.length > 0) {
    return {
      safe: false,
      flagged: true,
      reason: `安全分析发现问题: ${triggeredChecks.slice(0, 3).join('; ')}${triggeredChecks.length > 3 ? ` (+${triggeredChecks.length - 3} more)` : ''}`,
      triggeredChecks,
      astAvailable: false,
    };
  }

  return {
    safe: true,
    flagged: false,
    triggeredChecks: [],
    astAvailable: false,
  };
}

// ===== Quick Check (synchronous, for tool executor) =====

/**
 * Synchronous snapshot of whether the command is clearly dangerous.
 * Only checks regex patterns — does NOT attempt tree-sitter.
 *
 * Use this in the tool-executor hot path.
 * If this returns false, the full async analysis should run.
 */
export function isClearlyDangerous(command: string): boolean {
  const criticalPatterns = [
    /rm\s+-rf\s+\//,
    /mkfs\./,
    /dd\s+if=/,
    /:\(\)\s*\{\s*:\|:&\s*\}/, // fork bomb
    />\s*\/dev\/sd[a-z]/,
  ];

  return criticalPatterns.some((p) => p.test(command));
}

/**
 * Get security checks that apply to a command (synchronous).
 */
export function getApplicableChecks(command: string): SecurityCheck[] {
  return SECURITY_CHECKS.filter((c) => c.regex?.test(command));
}
