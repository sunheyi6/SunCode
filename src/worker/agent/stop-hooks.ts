/**
 * Stop Hooks — extensible post-turn checks that run before the agent loop
 * finalizes a turn. Modeled after Codex's stop hooks mechanism.
 *
 * Hooks run in priority order (lowest number first). The first hook that
 * returns `shouldStop: true` or `shouldBlock: true` wins — later hooks
 * are not executed for that turn.
 *
 * Also provides adapters for the unified Hook system (see ../hooks/hook-system.ts).
 */

import type { StopHook, StopHookContext, StopHookRegistry, StopHookResult } from '@shared/types';
import {
  adaptStopHookAsHook,
  createHookRegistry,
  type DefaultHookRegistry,
  hookRegistryAsStopRegistry,
} from '../hooks/hook-system';

export { createHookRegistry, DefaultHookRegistry } from '../hooks/hook-system';

// ===== Built-in Stop Hooks =====

/**
 * Safety check hook: detects dangerous patterns in the assistant's output
 * or tool calls (e.g., `rm -rf /`, `.env` file exposure, etc.).
 */
export class SafetyStopHook implements StopHook {
  name = 'safety';
  priority = 20;

  async check(ctx: StopHookContext): Promise<StopHookResult> {
    const allText =
      ctx.assistantText + ctx.toolCalls.map((tc) => `${tc.name} ${tc.arguments}`).join(' ');

    // Check for dangerous shell commands
    const dangerousPatterns = [
      { pattern: /rm\s+-rf\s+\//, message: '检测到危险的删除命令 `rm -rf /`' },
      { pattern: /sudo\s+rm\s+-rf/, message: '检测到危险的 sudo rm 命令' },
      { pattern: />\s*\/dev\/sd[a-z]/, message: '检测到直接写入磁盘设备的操作' },
      { pattern: /chmod\s+777\s+\//, message: '检测到危险的权限修改' },
      { pattern: /git\s+push\s+--force.*main/, message: '检测到强制推送到 main 分支' },
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(allText)) {
        return {
          shouldBlock: false,
          shouldStop: true,
          reason: `安全检查: ${message}`,
          continuationPrompt: undefined,
        };
      }
    }

    return { shouldBlock: false, shouldStop: false };
  }
}

// ===== Stop Hook Registry (legacy, backward compatible) =====

/**
 * Default implementation of the StopHookRegistry.
 * Hooks are run in ascending priority order. The first hook that returns
 * `shouldStop: true` or `shouldBlock: true` short-circuits the remaining hooks.
 */
export class DefaultStopHookRegistry implements StopHookRegistry {
  private hooks: StopHook[] = [];

  register(hook: StopHook): void {
    this.hooks.push(hook);
    // Keep sorted by priority
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  async runAll(ctx: StopHookContext): Promise<StopHookResult> {
    for (const hook of this.hooks) {
      try {
        const result = await hook.check(ctx);
        if (result.shouldStop || result.shouldBlock) {
          console.log(
            `[StopHook] "${hook.name}" (priority=${hook.priority}) → ` +
              `${result.shouldStop ? 'stop' : 'block'}: ${result.reason || 'no reason'}`,
          );
          return result;
        }
      } catch (error) {
        console.warn(`[StopHook] "${hook.name}" threw an error:`, error);
        // Continue to next hook on error
      }
    }
    return { shouldBlock: false, shouldStop: false };
  }
}

/**
 * Create a stop hook registry with the standard built-in hooks.
 * These run on every turn unless the caller provides a custom registry.
 */
export function createDefaultStopHookRegistry(): StopHookRegistry {
  const registry = new DefaultStopHookRegistry();
  registry.register(new SafetyStopHook());
  return registry;
}

// ===== Unified Hook Registry Factory =====

/**
 * Create a unified hook registry with the built-in SafetyStopHook
 * adapted to the new HookInterface. Provides the full lifecycle hook
 * capabilities (pre_tool_use, post_tool_use, permission_request, etc.)
 * while maintaining backward compatibility with the legacy stop hook.
 */
export function createUnifiedHookRegistry(): {
  registry: DefaultHookRegistry;
  stopRegistry: StopHookRegistry;
} {
  const registry = createHookRegistry();
  // Register the safety hook as a unified hook
  registry.register(adaptStopHookAsHook(new SafetyStopHook()));

  // Wrap for backward-compatible StopHookRegistry interface
  const stopRegistry = hookRegistryAsStopRegistry(registry);

  return { registry, stopRegistry };
}
