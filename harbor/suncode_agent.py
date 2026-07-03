"""Harbor adapter for running SunCode against terminal-bench tasks."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, FinalMetrics, Step, Trajectory
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json


_HOST_NODE_ENV_ALLOWLIST = {
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "COMSPEC",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
}


def _host_node_process_env(cell_env: dict[str, str]) -> dict[str, str]:
    env = {key: value for key in _HOST_NODE_ENV_ALLOWLIST if (value := os.environ.get(key))}
    env.update(cell_env)
    return env


class SunCodeAgent(BaseInstalledAgent):
    """Run SunCode on the host while executing tools inside Harbor's container."""

    SUPPORTS_ATIF = True

    _RUN_LOG_FILENAME = "suncode-run.log"
    _CELL_OUTPUT_FILENAME = "cell-output.json"

    CLI_FLAGS = [
        CliFlag("system_prompt", cli="", type="str", default="", env_fallback="SUNCODE_SYSTEM_PROMPT"),
        CliFlag("suncode_repo", cli="", type="str", default="", env_fallback="SUNCODE_REPO_ROOT"),
        CliFlag("provider", cli="", type="str", default="", env_fallback="SUNCODE_PROVIDER"),
    ]

    @staticmethod
    def name() -> str:
        return "suncode"

    def get_version_command(self) -> str | None:
        return "bun --version"

    async def install(self, environment: BaseEnvironment) -> None:
        run_host_cell = self._run_host_cell_path()
        if not Path(run_host_cell).exists():
            raise RuntimeError(f"SunCode host cell runner not found: {run_host_cell}")
        await self.exec_as_agent(environment, command="pwd")

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        agent_dir = EnvironmentPaths.agent_dir
        await self.exec_as_agent(environment, command=f"mkdir -p {agent_dir.as_posix()}")

        local_instruction_path = self.logs_dir / "instruction.txt"
        local_instruction_path.write_text(instruction, encoding="utf-8")

        container_cwd = await self._container_cwd(environment)
        async with _ToolExecutorServer(self, environment) as executor:
            env = self._host_cell_env(local_instruction_path, container_cwd, executor)
            run_log_path = self.logs_dir / self._RUN_LOG_FILENAME
            process = await asyncio.create_subprocess_exec(
                *self._host_runner_command(),
                cwd=self._repo_root(),
                env=_host_node_process_env(env),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=self._cell_timeout_sec())
            except asyncio.TimeoutError:
                process.kill()
                stdout, stderr = await process.communicate()
                run_log_path.write_bytes(stdout + stderr)
                raise RuntimeError(f"SunCode host cell exceeded {self._cell_timeout_sec()}s")
            run_log_path.write_bytes(stdout + stderr)
            if process.returncode != 0:
                message = (stderr or stdout).decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"SunCode host cell exited {process.returncode}: {message}")

        output = self._read_cell_output(required=True)
        self._apply_cell_output(context, output)

    def populate_context_post_run(self, context: AgentContext) -> None:
        self._apply_cell_output(context)

    def _repo_root(self) -> str:
        return self._resolved_flags.get("suncode_repo") or self._get_env("SUNCODE_REPO_ROOT") or os.getcwd()

    def _run_host_cell_path(self) -> str:
        return str(Path(self._repo_root()) / "scripts" / "run-suncode-harbor-loop.ts")

    def _host_runner_command(self) -> list[str]:
        runner = self._get_env("SUNCODE_HOST_RUNNER") or shutil.which("bun")
        if not runner:
            raise RuntimeError("bun executable not found on PATH")
        if runner.lower().endswith((".cmd", ".bat")):
            return [os.environ.get("COMSPEC") or "cmd.exe", "/c", runner, self._run_host_cell_path()]
        return [runner, self._run_host_cell_path()]

    def _cell_timeout_sec(self) -> int:
        raw = self._get_env("SUNCODE_CELL_TIMEOUT_SEC")
        if not raw:
            return 3600
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return 3600
        return value if value > 0 else 3600

    async def _container_cwd(self, environment: BaseEnvironment) -> str:
        result = await self.exec_as_agent(environment, command="pwd")
        cwd = _exec_stdout(result).strip()
        return cwd or "."

    def _host_cell_env(
        self,
        local_instruction_path: Path,
        container_cwd: str,
        executor: "_ToolExecutorServer",
    ) -> dict[str, str]:
        model = self.model_name or self._get_env("SUNCODE_MODEL") or "deepseek-v4-flash"
        system_prompt = self._resolved_flags.get("system_prompt", "") or self._get_env("SUNCODE_SYSTEM_PROMPT") or ""
        provider = self._resolved_flags.get("provider", "") or self._get_env("SUNCODE_PROVIDER") or "deepseek"
        env = {
            "SUNCODE_INSTRUCTION_FILE": str(local_instruction_path),
            "SUNCODE_OUTPUT_DIR": str(self.logs_dir),
            "SUNCODE_STORAGE_ROOT": str(self.logs_dir / "suncode-storage"),
            "SUNCODE_WORKDIR": container_cwd,
            "SUNCODE_HARBOR_TOOL_EXECUTOR_URL": executor.url,
            "SUNCODE_HARBOR_TOOL_EXECUTOR_TOKEN": executor.token,
            "SUNCODE_MODEL": model,
            "SUNCODE_PROVIDER": provider,
            "SUNCODE_SYSTEM_PROMPT": system_prompt,
        }
        for key in (
            "DEEPSEEK_API_KEY",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "OPENAI_BASE_URL",
            "DEEPSEEK_BASE_URL",
            "ANTHROPIC_BASE_URL",
            "GOOGLE_BASE_URL",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
            "SUNCODE_MAX_TURNS",
            "SUNCODE_CELL_TIMEOUT_SEC",
        ):
            value = self._get_env(key)
            if value:
                env[key] = value
        return env

    def _read_cell_output(self, *, required: bool) -> dict[str, Any] | None:
        output_path = self.logs_dir / self._CELL_OUTPUT_FILENAME
        if not output_path.exists():
            if required:
                raise RuntimeError(f"SunCode cell did not write {self._CELL_OUTPUT_FILENAME}")
            return None
        try:
            output = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            if required:
                raise RuntimeError(f"SunCode cell output is not valid JSON: {output_path}") from exc
            return None
        if not isinstance(output, dict):
            if required:
                raise RuntimeError(f"SunCode cell output must be a JSON object: {output_path}")
            return None
        return output

    def _apply_cell_output(self, context: AgentContext, output: dict[str, Any] | None = None) -> None:
        output = output or self._read_cell_output(required=False)
        if output is None:
            return

        token_summary = output.get("tokenSummary")
        if isinstance(token_summary, dict):
            context.n_input_tokens = int(token_summary.get("input") or 0)
            context.n_output_tokens = int(token_summary.get("output") or 0)
            context.n_cache_tokens = int(token_summary.get("cachedInput") or 0)
            context.cost_usd = float(token_summary.get("costUsd") or 0)

        context.metadata = {
            **(context.metadata or {}),
            "suncode_status": output.get("status"),
            "suncode_error_class": output.get("errorClass"),
            "suncode_prompt_hash": output.get("promptHash"),
            "suncode_cell_output": str(self.logs_dir / self._CELL_OUTPUT_FILENAME),
            "suncode_runtime_events": output.get("runtimeEventsPath"),
        }
        self._write_trajectory(output)

    def _write_trajectory(self, output: dict[str, Any]) -> None:
        token_summary = output.get("tokenSummary")
        final_metrics = FinalMetrics(
            total_prompt_tokens=_optional_int(token_summary, "input"),
            total_completion_tokens=_optional_int(token_summary, "output"),
            total_cost_usd=_optional_float(token_summary, "costUsd"),
            total_steps=output.get("steps") if isinstance(output.get("steps"), int) else None,
            extra={
                "suncode_status": output.get("status"),
                "suncode_error_class": output.get("errorClass"),
                "runtime_events_path": output.get("runtimeEventsPath"),
            },
        )
        trajectory = Trajectory(
            session_id=(output.get("runtimeRefs") or {}).get("sessionId"),
            agent=Agent(name="suncode", version=self.version() or "unknown", model_name=self.model_name),
            steps=[
                Step(step_id=1, source="user", message="Harbor task instruction"),
                Step(step_id=2, source="agent", message=f"SunCode cell {output.get('status', 'finished')}"),
            ],
            final_metrics=final_metrics,
        )
        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            trajectory_path.write_text(format_trajectory_json(trajectory.to_json_dict()), encoding="utf-8")
        except OSError:
            return


class _ToolExecutorServer:
    def __init__(self, agent: SunCodeAgent, environment: BaseEnvironment) -> None:
        self._agent = agent
        self._environment = environment
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.token = secrets.token_urlsafe(32)
        self.url = ""

    async def __aenter__(self) -> "_ToolExecutorServer":
        self._loop = asyncio.get_running_loop()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib callback name.
                outer._handle_post(self)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib callback name.
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        host, port = self._server.server_address
        self.url = f"http://{host}:{port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _handle_post(self, handler: BaseHTTPRequestHandler) -> None:
        if handler.path != "/exec":
            _write_http(handler, 404, {"error": "not found"})
            return
        if handler.headers.get("authorization") != f"Bearer {self.token}":
            _write_http(handler, 401, {"error": "unauthorized"})
            return
        try:
            length = int(handler.headers.get("content-length") or "0")
            payload = json.loads(handler.rfile.read(length).decode("utf-8"))
            command = payload.get("command")
            if not isinstance(command, str) or not command:
                raise ValueError("command is required")
            cwd = payload.get("cwd")
            timeout_ms = payload.get("timeoutMs")
            timeout_sec = _timeout_sec(timeout_ms)
            assert self._loop is not None
            future = asyncio.run_coroutine_threadsafe(
                self._agent.exec_as_agent(
                    self._environment,
                    command=command,
                    cwd=cwd if isinstance(cwd, str) and cwd else None,
                    timeout_sec=timeout_sec,
                ),
                self._loop,
            )
            result = future.result(timeout=(timeout_sec or self._agent._cell_timeout_sec()) + 30)
            _write_http(handler, 200, {
                "exitCode": _exec_exit_code(result),
                "stdout": _exec_stdout(result),
                "stderr": _exec_stderr(result),
            })
        except Exception as exc:  # noqa: BLE001 - RPC boundary returns tool failure text.
            _write_http(handler, 500, {
                "exitCode": 1,
                "stdout": "",
                "stderr": "",
                "error": f"{type(exc).__name__}: {exc}",
            })


def _write_http(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _timeout_sec(value: Any) -> int | None:
    if isinstance(value, (int, float)) and value > 0:
        return max(1, int((value + 999) // 1000))
    return None


def _exec_stdout(result: Any) -> str:
    value = getattr(result, "stdout", "")
    return value if isinstance(value, str) else ""


def _exec_stderr(result: Any) -> str:
    value = getattr(result, "stderr", "")
    return value if isinstance(value, str) else ""


def _exec_exit_code(result: Any) -> int:
    for name in ("exit_code", "exitCode", "returncode"):
        value = getattr(result, name, None)
        if isinstance(value, int):
            return value
    return 0


def _optional_int(value: Any, key: str) -> int | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None


def _optional_float(value: Any, key: str) -> float | None:
    if not isinstance(value, dict):
        return None
    raw = value.get(key)
    return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None
