/**
 * Paired Harbor A/B runner for SunCode feature settings.
 *
 * Both arms use the same SunCode checkout, model, task, attempt count, and
 * Harbor environment. Only the validated AppSettings patch may differ.
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  encodeHarborSettingsPatch,
  parseSettingAssignment,
  validateHarborSettingsPatch,
} from './terminal-bench-settings';

interface ArmSpec {
  id: string;
  settings: Record<string, unknown>;
}

interface AbOptions {
  runId: string;
  outDir: string;
  tasks: string[];
  taskFiles: string[];
  reps: number;
  dryRun: boolean;
  armAName: string;
  armBName: string;
  armASettings: string[];
  armBSettings: string[];
  commonArgs: string[];
}

interface AbManifestBody {
  schemaVersion: 'suncode.terminal_bench_ab.v1';
  runId: string;
  sourceFingerprint: string;
  toolchainFingerprint: string;
  tasksFingerprint: string;
  tasks: string[];
  reps: number;
  arms: [ArmSpec, ArmSpec];
  commonArgs: string[];
}

interface AbManifest extends AbManifestBody {
  fingerprint: string;
}

interface FeatureDiagnostics {
  semanticCompactStarted: number;
  semanticCompactCompleted: number;
  semanticCompactApplied: number;
  semanticCompactRejected: number;
}

interface AttemptRecord {
  schemaVersion: 'suncode.terminal_bench_ab.attempt.v1';
  attemptId: string;
  taskId: string;
  rep: number;
  armId: string;
  settings: Record<string, unknown>;
  status: 'completed' | 'infra_failed';
  reward: number | null;
  passed: boolean | null;
  taskChecksum: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number | null;
  featureDiagnostics: FeatureDiagnostics;
  jobResultPath: string;
  error: string | null;
  finishedAt: string;
}

interface ArmSummary {
  expected: number;
  observed: number;
  passed: number;
  passRate: number | null;
  infraFailed: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  semanticCompactStarted: number;
  semanticCompactCompleted: number;
  semanticCompactApplied: number;
  semanticCompactRejected: number;
}

const EMPTY_FEATURE_DIAGNOSTICS: FeatureDiagnostics = {
  semanticCompactStarted: 0,
  semanticCompactCompleted: 0,
  semanticCompactApplied: 0,
  semanticCompactRejected: 0,
};

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function parseArgs(argv: string[]): AbOptions {
  const options: AbOptions = {
    runId: `ab-${Date.now()}`,
    outDir: 'jobs/terminal-bench-ab',
    tasks: [],
    taskFiles: [],
    reps: 1,
    dryRun: false,
    armAName: 'baseline',
    armBName: 'candidate',
    armASettings: [],
    armBSettings: [],
    commonArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options.commonArgs = argv.slice(index + 1);
      break;
    }
    if (arg === '--run-id') {
      options.runId = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--out-dir') {
      options.outDir = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--task') {
      options.tasks.push(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--task-file') {
      options.taskFiles.push(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--reps') {
      options.reps = positiveInteger(takeValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--arm-a-name') {
      options.armAName = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--arm-b-name') {
      options.armBName = takeValue(argv, index, arg);
      index += 1;
    } else if (arg === '--arm-a-setting') {
      options.armASettings.push(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--arm-b-setting') {
      options.armBSettings.push(takeValue(argv, index, arg));
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown A/B option: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  validateRunId(options.runId);
  validateCommonArgs(options.commonArgs);
  const tasks = await resolveTasks(options.tasks, options.taskFiles);
  const arms = buildArms(options);
  assertUniqueAttemptIds(tasks, options.reps, arms);
  const runRoot = resolve(options.outDir, options.runId);
  const harborJobsDir = join(runRoot, 'harbor');
  const resultsPath = join(runRoot, 'ab-results.jsonl');
  await mkdir(runRoot, { recursive: true });
  await mkdir(harborJobsDir, { recursive: true });

  const body: AbManifestBody = {
    schemaVersion: 'suncode.terminal_bench_ab.v1',
    runId: options.runId,
    sourceFingerprint: await buildSourceFingerprint(),
    toolchainFingerprint: buildToolchainFingerprint(),
    tasksFingerprint: sha256(canonicalJson(tasks)),
    tasks,
    reps: options.reps,
    arms,
    commonArgs: options.commonArgs,
  };
  const manifest: AbManifest = { ...body, fingerprint: sha256(canonicalJson(body)) };
  await ensureManifest(join(runRoot, 'ab-manifest.json'), manifest);
  if (!options.dryRun) ensureDockerEngine();

  const attempts = await readLatestAttempts(resultsPath);
  let infraFailures = 0;
  for (let rep = 0; rep < options.reps; rep += 1) {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const taskId = tasks[taskIndex]!;
      const orderedArms = (rep + taskIndex) % 2 === 0 ? arms : [arms[1], arms[0]] as [ArmSpec, ArmSpec];
      for (const arm of orderedArms) {
        const currentSourceFingerprint = await buildSourceFingerprint();
        if (currentSourceFingerprint !== manifest.sourceFingerprint) {
          throw new Error('Source changed during the A/B run. Restore it or start a new --run-id.');
        }
        const attemptId = buildAttemptId(arm.id, taskId, rep);
        const existing = attempts.get(attemptId);
        if (!options.dryRun && existing?.status === 'completed') {
          console.error(`[terminal-bench-ab] resume: skip ${attemptId}`);
          continue;
        }
        const record = await runAttempt({
          attemptId,
          arm,
          taskId,
          rep,
          commonArgs: options.commonArgs,
          harborJobsDir,
          dryRun: options.dryRun,
        });
        if (options.dryRun) continue;
        await appendFile(resultsPath, `${JSON.stringify(record)}\n`, 'utf8');
        attempts.set(attemptId, record);
        await writeReports(runRoot, manifest, attempts);
        if (record.status === 'infra_failed') infraFailures += 1;
      }
    }
  }

  if (options.dryRun) {
    console.error(`[terminal-bench-ab] dry-run planned ${tasks.length * options.reps * 2} attempts`);
    return;
  }
  await writeReports(runRoot, manifest, attempts);
  console.error(`[terminal-bench-ab] report: ${join(runRoot, 'ab-report.md')}`);
  if (infraFailures > 0) process.exitCode = 1;
}

function buildArms(options: AbOptions): [ArmSpec, ArmSpec] {
  const useSemanticCompactExample = options.armASettings.length === 0 && options.armBSettings.length === 0;
  const armASettings = useSemanticCompactExample
    ? ['semanticCompactMode=off']
    : options.armASettings;
  const armBSettings = useSemanticCompactExample
    ? ['semanticCompactMode=replace']
    : options.armBSettings;
  const arms: [ArmSpec, ArmSpec] = [
    { id: sanitizeId(options.armAName), settings: settingsFromAssignments(armASettings) },
    { id: sanitizeId(options.armBName), settings: settingsFromAssignments(armBSettings) },
  ];
  if (arms[0].id === arms[1].id) throw new Error('A/B arm names must be different');
  if (canonicalJson(arms[0].settings) === canonicalJson(arms[1].settings)) {
    throw new Error('A/B arms must have different settings patches');
  }
  return arms;
}

function settingsFromAssignments(assignments: string[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const [key, value] = parseSettingAssignment(assignment);
    if (key in settings) throw new Error(`Duplicate setting assignment: ${key}`);
    settings[key] = value;
  }
  return validateHarborSettingsPatch(settings) as Record<string, unknown>;
}

async function resolveTasks(explicitTasks: string[], taskFiles: string[]): Promise<string[]> {
  const tasks = [...explicitTasks];
  for (const taskFile of taskFiles) {
    const raw = await readFile(resolve(taskFile), 'utf8');
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error(`Task file must be a JSON string array: ${taskFile}`);
      }
      tasks.push(...parsed);
    } else {
      tasks.push(...raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }
  }
  if (tasks.length === 0) {
    throw new Error('A/B runs require explicit --task or --task-file entries so both arms use the same task set');
  }
  const duplicate = tasks.find((task, index) => tasks.indexOf(task) !== index);
  if (duplicate) throw new Error(`Duplicate A/B task: ${duplicate}`);
  for (const task of tasks) {
    if (/[*?\[\]]/.test(task)) throw new Error(`A/B task names must be exact, not globs: ${task}`);
  }
  return tasks;
}

function validateCommonArgs(args: string[]): void {
  const forbidden = [
    '--agent',
    '--attempts',
    '--concurrency',
    '--jobs-dir',
    '--settings-patch-b64',
    '--require-api-key',
    '--task',
    '--task-limit',
    '--exclude-task',
    '--dry-run',
    '--',
  ];
  for (const arg of args) {
    if (forbidden.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new Error(`A/B runner controls ${arg}; remove it from common Terminal-Bench arguments`);
    }
  }
}

async function runAttempt(input: {
  attemptId: string;
  arm: ArmSpec;
  taskId: string;
  rep: number;
  commonArgs: string[];
  harborJobsDir: string;
  dryRun: boolean;
}): Promise<AttemptRecord> {
  const jobName = sanitizeId(input.attemptId).slice(0, 120);
  const settingsPatchB64 = encodeHarborSettingsPatch(input.arm.settings);
  const runnerArgs = [
    'run',
    resolve('scripts/run-terminal-bench.ts'),
    ...input.commonArgs,
    '--jobs-dir',
    input.harborJobsDir,
    '--attempts',
    '1',
    '--concurrency',
    '1',
    '--task',
    input.taskId,
    '--settings-patch-b64',
    settingsPatchB64,
    '--require-api-key',
    ...(input.dryRun ? ['--dry-run'] : []),
    '--',
    '--job-name',
    jobName,
  ];
  console.error(
    `[terminal-bench-ab] ${input.attemptId} settings=${JSON.stringify(input.arm.settings)}`,
  );
  const exitCode = await spawnAndWait(process.execPath, runnerArgs);
  const jobResultPath = join(input.harborJobsDir, jobName, 'result.json');
  if (input.dryRun) return infraRecord(input, jobResultPath, 'dry-run');
  if (exitCode !== 0) return infraRecord(input, jobResultPath, `Terminal-Bench runner exited ${exitCode}`);
  try {
    const jobRaw = await readFile(jobResultPath, 'utf8');
    const job = JSON.parse(jobRaw) as unknown;
    if (isRecord(job) && Array.isArray(job.trial_results)) {
      return parseHarborAttempt(input, jobResultPath, jobRaw);
    }
    const trialResults = await findHarborTrialResults(join(input.harborJobsDir, jobName));
    if (trialResults.length !== 1) {
      throw new Error(
        `Harbor job must contain exactly one trial result, found ${trialResults.length}: ${jobResultPath}`,
      );
    }
    const trialResult = trialResults[0]!;
    return parseHarborAttempt(input, trialResult.path, trialResult.raw);
  } catch (error) {
    return infraRecord(input, jobResultPath, errorText(error));
  }
}

async function findHarborTrialResults(
  jobDir: string,
): Promise<Array<{ path: string; raw: string }>> {
  const results: Array<{ path: string; raw: string }> = [];
  for (const entry of await readdir(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(jobDir, entry.name, 'result.json');
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed) && typeof parsed.task_name === 'string') results.push({ path, raw });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return results;
}

function parseHarborAttempt(
  input: { attemptId: string; arm: ArmSpec; taskId: string; rep: number },
  jobResultPath: string,
  raw: string,
): AttemptRecord {
  const result = JSON.parse(raw) as unknown;
  if (!isRecord(result)) {
    throw new Error(`Harbor job must contain exactly one trial: ${jobResultPath}`);
  }
  const trial = Array.isArray(result.trial_results) ? result.trial_results[0] : result;
  if (Array.isArray(result.trial_results) && result.trial_results.length !== 1) {
    throw new Error(`Harbor job must contain exactly one trial: ${jobResultPath}`);
  }
  if (!isRecord(trial)) throw new Error(`Harbor trial result is malformed: ${jobResultPath}`);
  if (typeof trial.task_name !== 'string' || !taskNameMatches(trial.task_name, input.taskId)) {
    throw new Error(`Harbor returned task ${String(trial.task_name)}, expected ${input.taskId}`);
  }
  const reward = readReward(trial.verifier_result);
  if (reward === null) {
    const exception = exceptionText(trial.exception_info);
    throw new Error(exception || `Harbor verifier produced no numeric reward for ${input.taskId}`);
  }
  const agentResult = isRecord(trial.agent_result) ? trial.agent_result : {};
  if (typeof trial.task_checksum !== 'string' || !trial.task_checksum) {
    throw new Error(`Harbor result has no task checksum for ${input.taskId}`);
  }
  const metadata = isRecord(agentResult.metadata) ? agentResult.metadata : {};
  const appliedSettings = validateHarborSettingsPatch(metadata.suncode_settings_patch);
  if (canonicalJson(appliedSettings) !== canonicalJson(input.arm.settings)) {
    throw new Error(
      `SunCode applied settings ${JSON.stringify(appliedSettings)}, expected ${JSON.stringify(input.arm.settings)}`,
    );
  }
  const diagnostics = readFeatureDiagnostics(metadata.suncode_feature_diagnostics);
  return {
    schemaVersion: 'suncode.terminal_bench_ab.attempt.v1',
    attemptId: input.attemptId,
    taskId: input.taskId,
    rep: input.rep,
    armId: input.arm.id,
    settings: input.arm.settings,
    status: 'completed',
    reward,
    passed: reward > 0,
    taskChecksum: trial.task_checksum,
    inputTokens: numeric(agentResult.n_input_tokens),
    cachedInputTokens: numeric(agentResult.n_cache_tokens),
    outputTokens: numeric(agentResult.n_output_tokens),
    costUsd: numeric(agentResult.cost_usd),
    durationMs: durationMs(trial.agent_execution),
    featureDiagnostics: diagnostics,
    jobResultPath,
    error: null,
    finishedAt: new Date().toISOString(),
  };
}

function infraRecord(
  input: { attemptId: string; arm: ArmSpec; taskId: string; rep: number },
  jobResultPath: string,
  error: string,
): AttemptRecord {
  return {
    schemaVersion: 'suncode.terminal_bench_ab.attempt.v1',
    attemptId: input.attemptId,
    taskId: input.taskId,
    rep: input.rep,
    armId: input.arm.id,
    settings: input.arm.settings,
    status: 'infra_failed',
    reward: null,
    passed: null,
    taskChecksum: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: null,
    featureDiagnostics: { ...EMPTY_FEATURE_DIAGNOSTICS },
    jobResultPath,
    error,
    finishedAt: new Date().toISOString(),
  };
}

async function readLatestAttempts(path: string): Promise<Map<string, AttemptRecord>> {
  const attempts = new Map<string, AttemptRecord>();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return attempts;
    throw error;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as AttemptRecord;
    if (typeof record.attemptId === 'string') attempts.set(record.attemptId, record);
  }
  return attempts;
}

async function writeReports(
  runRoot: string,
  manifest: AbManifest,
  attempts: Map<string, AttemptRecord>,
): Promise<void> {
  const expectedPerArm = manifest.tasks.length * manifest.reps;
  const records = [...attempts.values()];
  const baseline = summarizeArm(records, manifest.arms[0].id, expectedPerArm);
  const candidate = summarizeArm(records, manifest.arms[1].id, expectedPerArm);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let missing = 0;
  let checksumMismatches = 0;
  const pairRows: Array<Record<string, unknown>> = [];
  for (let rep = 0; rep < manifest.reps; rep += 1) {
    for (const taskId of manifest.tasks) {
      const a = attempts.get(buildAttemptId(manifest.arms[0].id, taskId, rep));
      const b = attempts.get(buildAttemptId(manifest.arms[1].id, taskId, rep));
      let outcome = 'missing';
      if (a?.status === 'completed' && b?.status === 'completed') {
        if (a.taskChecksum && b.taskChecksum && a.taskChecksum !== b.taskChecksum) {
          outcome = 'checksum_mismatch';
          checksumMismatches += 1;
        } else if ((b.reward ?? 0) > (a.reward ?? 0)) {
          outcome = 'candidate_win';
          wins += 1;
        } else if ((b.reward ?? 0) < (a.reward ?? 0)) {
          outcome = 'baseline_win';
          losses += 1;
        } else {
          outcome = 'tie';
          ties += 1;
        }
      } else {
        missing += 1;
      }
      pairRows.push({ taskId, rep, baselineReward: a?.reward ?? null, candidateReward: b?.reward ?? null, outcome });
    }
  }
  const report = {
    schemaVersion: 'suncode.terminal_bench_ab.report.v1',
    runId: manifest.runId,
    manifestFingerprint: manifest.fingerprint,
    baselineArmId: manifest.arms[0].id,
    candidateArmId: manifest.arms[1].id,
    baseline,
    candidate,
    paired: { wins, losses, ties, missing, checksumMismatches, pairs: pairRows },
  };
  await writeFile(join(runRoot, 'ab-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(runRoot, 'ab-report.md'), renderReportMarkdown(report), 'utf8');
}

function summarizeArm(records: AttemptRecord[], armId: string, expected: number): ArmSummary {
  const arm = records.filter((record) => record.armId === armId);
  const observed = arm.filter((record) => record.status === 'completed');
  const passed = observed.filter((record) => record.passed).length;
  return {
    expected,
    observed: observed.length,
    passed,
    passRate: observed.length > 0 ? passed / observed.length : null,
    infraFailed: arm.filter((record) => record.status === 'infra_failed').length,
    inputTokens: sum(arm, (record) => record.inputTokens),
    cachedInputTokens: sum(arm, (record) => record.cachedInputTokens),
    outputTokens: sum(arm, (record) => record.outputTokens),
    costUsd: sum(arm, (record) => record.costUsd),
    semanticCompactStarted: sum(arm, (record) => record.featureDiagnostics.semanticCompactStarted),
    semanticCompactCompleted: sum(arm, (record) => record.featureDiagnostics.semanticCompactCompleted),
    semanticCompactApplied: sum(arm, (record) => record.featureDiagnostics.semanticCompactApplied),
    semanticCompactRejected: sum(arm, (record) => record.featureDiagnostics.semanticCompactRejected),
  };
}

function renderReportMarkdown(report: {
  runId: string;
  baselineArmId: string;
  candidateArmId: string;
  baseline: ArmSummary;
  candidate: ArmSummary;
  paired: { wins: number; losses: number; ties: number; missing: number; checksumMismatches: number };
}): string {
  const armRow = (id: string, summary: ArmSummary) =>
    `| ${id} | ${summary.observed}/${summary.expected} | ${formatRate(summary.passRate)} | ${summary.infraFailed} | ${summary.inputTokens} | ${summary.outputTokens} | ${summary.semanticCompactApplied} |`;
  return [
    `# SunCode Terminal-Bench A/B: ${report.runId}`,
    '',
    '| Arm | Observed | Pass rate | Infra failures | Input tokens | Output tokens | Semantic compact applied |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    armRow(report.baselineArmId, report.baseline),
    armRow(report.candidateArmId, report.candidate),
    '',
    '## Paired outcome',
    '',
    `- Candidate wins: ${report.paired.wins}`,
    `- Baseline wins: ${report.paired.losses}`,
    `- Ties: ${report.paired.ties}`,
    `- Missing pairs: ${report.paired.missing}`,
    `- Task checksum mismatches: ${report.paired.checksumMismatches}`,
    '',
    'This report is descriptive. Use enough tasks and repetitions before making a product decision.',
    '',
  ].join('\n');
}

async function ensureManifest(path: string, manifest: AbManifest): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as AbManifest;
    if (existing.fingerprint !== manifest.fingerprint) {
      throw new Error('A/B run manifest changed. Use a new --run-id or restore the original tasks, arms, source, and common arguments.');
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
}

async function buildSourceFingerprint(): Promise<string> {
  const head = gitOutput(['rev-parse', 'HEAD']);
  const diff = gitOutput(['diff', '--binary', 'HEAD']);
  const untracked = gitOutput(['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256').update(head).update('\0').update(diff);
  for (const path of untracked) {
    hash.update('\0').update(path).update('\0').update(await readFile(resolve(path)));
  }
  return `sha256:${hash.digest('hex')}`;
}

function buildToolchainFingerprint(): string {
  return sha256(canonicalJson({
    bun: toolOutput(process.execPath, ['--version']),
    docker: toolOutput('docker', ['--version']),
    harbor: toolOutput('harbor', ['--version']),
  }));
}

function ensureDockerEngine(): void {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Docker engine is not available: ${result.stderr || result.stdout}`);
  }
}

function toolOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

function gitOutput(args: string[]): string {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trimEnd();
}

function spawnAndWait(command: string, args: string[]): Promise<number> {
  const child = spawn(command, args, { cwd: process.cwd(), stdio: 'inherit' });
  return new Promise((resolveExit) => {
    child.on('close', (code) => resolveExit(code ?? 1));
    child.on('error', () => resolveExit(1));
  });
}

function readReward(value: unknown): number | null {
  if (!isRecord(value) || !isRecord(value.rewards)) return null;
  const reward = value.rewards.reward;
  if (typeof reward === 'number' && Number.isFinite(reward)) return reward;
  for (const key of Object.keys(value.rewards).sort()) {
    const candidate = value.rewards[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function readFeatureDiagnostics(value: unknown): FeatureDiagnostics {
  if (!isRecord(value)) return { ...EMPTY_FEATURE_DIAGNOSTICS };
  return {
    semanticCompactStarted: numeric(value.semanticCompactStarted),
    semanticCompactCompleted: numeric(value.semanticCompactCompleted),
    semanticCompactApplied: numeric(value.semanticCompactApplied),
    semanticCompactRejected: numeric(value.semanticCompactRejected),
  };
}

function durationMs(value: unknown): number | null {
  if (!isRecord(value) || typeof value.started_at !== 'string' || typeof value.finished_at !== 'string') return null;
  const started = Date.parse(value.started_at);
  const finished = Date.parse(value.finished_at);
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null;
}

function exceptionText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const type = typeof value.exception_type === 'string' ? value.exception_type : 'HarborError';
  const message = typeof value.exception_message === 'string' ? value.exception_message : '';
  return message ? `${type}: ${message}` : type;
}

function taskNameMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`/${expected}`);
}

function buildAttemptId(armId: string, taskId: string, rep: number): string {
  return `${sanitizeId(armId)}-r${rep}-${sanitizeId(taskId)}`;
}

function assertUniqueAttemptIds(tasks: string[], reps: number, arms: [ArmSpec, ArmSpec]): void {
  const ids = new Set<string>();
  for (let rep = 0; rep < reps; rep += 1) {
    for (const task of tasks) {
      for (const arm of arms) {
        const id = buildAttemptId(arm.id, task, rep);
        if (ids.has(id)) throw new Error(`A/B task and arm names produce duplicate attempt id: ${id}`);
        ids.add(id);
      }
    }
  }
}

function validateRunId(value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error('--run-id must contain only letters, numbers, dot, underscore, or hyphen');
  }
}

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized) throw new Error(`Identifier cannot be empty after sanitizing: ${value}`);
  return sanitized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sum<T>(values: T[], pick: (value: T) => number): number {
  return values.reduce((total, value) => total + pick(value), 0);
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printUsage(): void {
  console.error(`Usage:
  bun run test:terminal-bench:ab -- [A/B options] -- [common Terminal-Bench options]

Example (semantic compact off vs replace):
  bun run test:terminal-bench:ab -- --run-id semantic-compact --task <exact-task-name> -- --model deepseek/deepseek-v4-flash

A/B options:
  --run-id <id>                 Immutable run/resume id
  --out-dir <dir>               Output root (default: jobs/terminal-bench-ab)
  --task <exact-name>           Exact task name; repeatable
  --task-file <path>            Newline list or JSON string array
  --reps <n>                    Repetitions per task and arm (default: 1)
  --arm-a-name <name>           Baseline label
  --arm-b-name <name>           Candidate label
  --arm-a-setting <key=value>   Baseline AppSettings patch; repeatable
  --arm-b-setting <key=value>   Candidate AppSettings patch; repeatable
  --dry-run                     Validate and print both Harbor commands

When no arm settings are supplied, the ready-made example compares
semanticCompactMode=off against semanticCompactMode=replace.
`);
}

main().catch((error: unknown) => {
  console.error(`[terminal-bench-ab] ${errorText(error)}`);
  process.exit(1);
});
