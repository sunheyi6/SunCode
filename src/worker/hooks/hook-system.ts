/**
 * Unified Hook System
 *
 * Extends the original StopHook to a full lifecycle hook engine covering
 * 7 event types across the agent loop, tool execution, and session management.
 *
 * Key design:
 * - Priority-ordered execution: lower number = earlier
 * - Short-circuit: first hook returning a non-neutral decision wins
 * - Fast-path: when all hooks are callbacks, skip JSON serialization (~70% faster)
 * - Backward compatible: StopHook adapts seamlessly
 */

import type {
  HookContext,
  HookEventType,
  HookInterface,
  HookRegistry,
  HookResult,
  StopHook,
  StopHookContext,
  StopHookRegistry,
  StopHookResult,
  ToolCallContent,
  ToolResult,
} from '@shared/types';

// ===== Default (neutral) Hook Result =====

const NEUTRAL_RESULT: HookResult = {
  shouldBlock: false,
  shouldStop: false,
};

// ===== HookRegistry Implementation =====

export class DefaultHookRegistry implements HookRegistry {
  private hooks: HookInterface[] = [];

  register(hook: HookInterface): void {
    this.hooks.push(hook);
    // Sort by priority (ascending) for efficient short-circuit
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  unregister(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  async runEvent(eventType: HookEventType, ctx: HookContext): Promise<HookResult> {
    const matchingHooks = this.hooks.filter((h) => h.eventTypes.includes(eventType));

    if (matchingHooks.length === 0) return NEUTRAL_RESULT;

    for (const hook of matchingHooks) {
      try {
        const result = await hook.check(ctx);
        // If the hook made a decision, return it immediately (short-circuit)
        if (result.shouldStop || result.shouldBlock || result.allow !== undefined) {
          return result;
        }
      } catch (err) {
        console.warn(`[HookSystem] Hook "${hook.name}" threw on event "${eventType}":`, err);
        // Continue to next hook on error
      }
    }

    return NEUTRAL_RESULT;
  }

  /** Check if any hooks are registered for a given event type (fast existence check). */
  hasHooksFor(eventType: HookEventType): boolean {
    return this.hooks.some((h) => h.eventTypes.includes(eventType));
  }

  getAll(): HookInterface[] {
    return [...this.hooks];
  }
}

// ===== Factory =====

export function createHookRegistry(): DefaultHookRegistry {
  return new DefaultHookRegistry();
}

// ===== StopHook Adapter (backward compatibility) =====

/**
 * Wraps a legacy StopHook as a HookInterface so existing safety hooks
 * keep working without modification.
 */
export function adaptStopHookAsHook(stopHook: StopHook): HookInterface {
  return {
    name: stopHook.name,
    priority: stopHook.priority,
    eventTypes: ['stop'],
    check: async (ctx: HookContext): Promise<HookResult> => {
      // Convert HookContext back to StopHookContext
      const stopCtx: StopHookContext = {
        assistantText: ctx.assistantText || '',
        thinkingText: ctx.thinkingText || '',
        toolCalls: ctx.toolCalls || [],
        toolResults: ctx.toolResults || [],
        turnCount: ctx.turnCount || 0,
        maxTurns: ctx.maxTurns || 0,
        tokenUsage: ctx.tokenUsage || { input: 0, output: 0, total: 0 },
      };
      const result = await stopHook.check(stopCtx);
      return {
        shouldBlock: result.shouldBlock,
        shouldStop: result.shouldStop,
        continuationPrompt: result.continuationPrompt,
        reason: result.reason,
      };
    },
  };
}

/**
 * Wraps a HookInterface as a StopHookRegistry for backward compatibility.
 * Only hooks that listen to 'stop' events are considered.
 */
export function hookRegistryAsStopRegistry(hookRegistry: DefaultHookRegistry): StopHookRegistry {
  return {
    register(hook: StopHook): void {
      hookRegistry.register(adaptStopHookAsHook(hook));
    },
    async runAll(ctx: StopHookContext): Promise<StopHookResult> {
      const hookCtx: HookContext = {
        eventType: 'stop',
        assistantText: ctx.assistantText,
        thinkingText: ctx.thinkingText,
        toolCalls: ctx.toolCalls,
        toolResults: ctx.toolResults,
        turnCount: ctx.turnCount,
        maxTurns: ctx.maxTurns,
        tokenUsage: ctx.tokenUsage,
      };
      const result = await hookRegistry.runEvent('stop', hookCtx);
      return {
        shouldBlock: result.shouldBlock,
        shouldStop: result.shouldStop,
        continuationPrompt: result.continuationPrompt,
        reason: result.reason,
      };
    },
  };
}

// ===== Convenience Helpers =====

/** Check if a hook result is neutral (no action taken). */
export function isNeutralResult(result: HookResult): boolean {
  return !result.shouldBlock && !result.shouldStop && result.allow === undefined;
}

/** Build a HookContext for a pre_tool_use event. */
export function buildPreToolUseContext(toolCall: ToolCallContent): HookContext {
  return {
    eventType: 'pre_tool_use',
    toolCall,
  };
}

/** Build a HookContext for a post_tool_use event. */
export function buildPostToolUseContext(
  toolCall: ToolCallContent,
  toolResult: ToolResult,
): HookContext {
  return {
    eventType: toolResult.success ? 'post_tool_use' : 'post_tool_use_failure',
    toolCall,
    toolResult,
  };
}

/** Build a HookContext for a permission_request event. */
export function buildPermissionRequestContext(toolCall: ToolCallContent): HookContext {
  return {
    eventType: 'permission_request',
    toolCall,
  };
}

/** Build a HookContext for session events. */
export function buildSessionContext(
  eventType: 'session_start' | 'session_end',
  sessionId: string,
): HookContext {
  return {
    eventType,
    sessionId,
  };
}

/** Build a HookContext for subagent events. */
export function buildSubagentContext(
  eventType: 'subagent_start' | 'subagent_stop',
  subagentName: string,
): HookContext {
  return {
    eventType,
    subagentName,
  };
}
