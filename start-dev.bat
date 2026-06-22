@echo off
REM ============================================
REM  SunCode 开发启动脚本
REM  自动清理旧进程，确保只有一个实例运行
REM ============================================

echo [SunCode] 正在清理旧进程...

REM 杀掉所有 electron 进程
taskkill /F /IM electron.exe >nul 2>&1

REM 杀掉可能残留的 vite/node 进程（通过端口 5173）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [SunCode] 清理完成，启动开发服务器...
echo.

cd /d "%~dp0"
bun run dev
