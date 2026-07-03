import type { StepStatus, TaskPlan, TaskStep } from '@shared/types';

/**
 * Parse a structured task plan from the model's visible text output.
 *
 * Recognizes two marker formats:
 *   📋 执行计划：            — initial plan (all steps pending)
 *   📋 进度更新：            — progress update (some steps done)
 *
 * Step format (lenient):
 *   - [ ] Step 1: description
 *   - [x] Step 2: description — result
 *
 * Returns null when no plan marker is found (query task, or model didn't plan).
 */
export function parseTaskPlan(content: string, isStreaming: boolean): TaskPlan | null {
  // Quick rejection — only check content that has a plan marker
  if (!content.includes('📋')) return null;

  const markerIdx = findLastPlanMarker(content);

  if (markerIdx < 0) return null;

  // Extract the text from the marker to the next double-newline or end
  const afterMarker = content.slice(markerIdx);
  const blockEnd = afterMarker.indexOf('\n\n');
  const planBlock = blockEnd >= 0 ? afterMarker.slice(0, blockEnd) : afterMarker;

  // Parse step lines with a lenient regex that accepts various formats:
  //   - [ ] Step 1: description     (preferred)
  //   - [ ] 1. description           (number without "Step")
  //   - [ ] 第一步：description       (Chinese numbering)
  //   - [ ] description              (no number at all — auto-numbered)
  const strictRegex = /^\s*[-*+]\s+\[([ xX])\]\s+Step\s+(\d+):\s*(.+)$/gm;
  const looseRegex = /^\s*[-*+]\s+\[([ xX])\]\s*(.+)$/gm;

  const steps: TaskStep[] = [];

  // Try strict format first (Step N:)
  let match: RegExpExecArray | null;
  match = strictRegex.exec(planBlock);
  while (match !== null) {
    const status: StepStatus = match[1]?.trim().toLowerCase() === 'x' ? 'done' : 'pending';
    const stepNum = parseInt(match[2] ?? '', 10);
    const { description, result } = splitResult(match[3]?.trim());
    steps.push({ id: `step_${stepNum}`, index: stepNum, description, status, result });
    match = strictRegex.exec(planBlock);
  }

  // If strict didn't match, try loose format (any checkbox line)
  if (steps.length === 0) {
    let autoIndex = 0;
    match = looseRegex.exec(planBlock);
    while (match !== null) {
      const status: StepStatus = match[1]?.trim().toLowerCase() === 'x' ? 'done' : 'pending';
      const raw = match[2]?.trim() ?? '';
      autoIndex++;

      // Try to extract a step number from various formats
      const numMatch = raw.match(/^(?:Step\s*)?(\d+)[.、:：]\s*/);
      let index: number;
      let descStart: number;
      if (numMatch) {
        index = parseInt(numMatch[1] ?? '', 10);
        descStart = numMatch[0]?.length ?? 0;
      } else {
        // Check for Chinese numbering
        const cnMatch = raw.match(/^第([一二三四五六七八九十]+)步[：:]\s*/);
        if (cnMatch) {
          index = cnToNumber(cnMatch[1] ?? '');
          descStart = cnMatch[0]?.length ?? 0;
        } else {
          index = autoIndex;
          descStart = 0;
        }
      }

      const { description, result } = splitResult(raw.slice(descStart));
      steps.push({ id: `step_${index}`, index, description, status, result });
    }
  }

  if (steps.length === 0) return null;

  // When streaming with a plan committed, mark the first pending step as "in_progress".
  // Only do this when content has at least one step marked done — otherwise the plan
  // is still being written and we shouldn't jump the gun.
  if (isStreaming) {
    const hasDone = steps.some((s) => s.status === 'done');
    if (hasDone) {
      const firstPending = steps.find((s) => s.status === 'pending');
      if (firstPending) {
        firstPending.status = 'in_progress';
      }
    }
  }

  return { taskType: 'execution', steps };
}

/**
 * Remove the plan block from content so it doesn't render twice
 * (once in the TaskPlanCard, once in the markdown text).
 */
export function stripPlanFromContent(content: string): string {
  // Remove from 📋 marker through all consecutive checklist lines
  // (lenient: any line starting with - [ ] or - [x] after the marker)
  return content
    .replace(/📋\s*(?:执行计划|进度更新)[：:]\s*[\s\S]*?(?=\n\n(?![-*+]\s*\[[ xX]\]\s)|$)/g, '')
    .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
    .trim();
}

function findLastPlanMarker(content: string): number {
  const markerRegex = /📋\s*(?:执行计划|进度更新)[：:]/g;
  let markerIdx = -1;
  let match: RegExpExecArray | null = markerRegex.exec(content);
  while (match !== null) {
    markerIdx = match.index;
    match = markerRegex.exec(content);
  }
  return markerIdx;
}

/** Convert Chinese numerals (一二三...) to integer. */
function cnToNumber(cn: string): number {
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  // Handle "十" and "十一" etc
  if (cn === '十') return 10;
  if (cn.startsWith('十')) return 10 + (map[cn[1]!] ?? 0);
  if (cn.endsWith('十')) return (map[cn[0]!] ?? 0) * 10;
  return map[cn] ?? 1;
}

/**
 * Split a step description into the main description and an optional result suffix.
 *
 * Recognizes patterns like:
 *   "分析文件结构 — 找到3个需要修改的文件"
 *   "修改完成：已更新 A.ts 和 B.ts"
 */
function splitResult(raw: string): { description: string; result?: string } {
  // Try " — " separator first (mdash with spaces)
  const emdashIdx = raw.indexOf(' — ');
  if (emdashIdx > 0) {
    return {
      description: raw.slice(0, emdashIdx).trim(),
      result: raw.slice(emdashIdx + 3).trim(),
    };
  }

  // Try "：" (Chinese colon) — only if there's substantial text on both sides
  const colonIdx = raw.indexOf('：');
  if (colonIdx > 4 && colonIdx < raw.length - 3) {
    return {
      description: raw.slice(0, colonIdx).trim(),
      result: raw.slice(colonIdx + 1).trim(),
    };
  }

  // Try "..." suffix (streaming in-progress indicator)
  if (raw.endsWith('...')) {
    return {
      description: raw.slice(0, -3).trim(),
    };
  }

  return { description: raw };
}
