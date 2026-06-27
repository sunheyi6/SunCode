#!/bin/bash
# Restart Vite dev server — kill any process on port 5173, then start fresh
pid=$(netstat -ano | awk '/:5173.*LISTENING/{print $5}')
[ -n "$pid" ] && powershell -Command "Stop-Process -Id $pid -Force" 2>/dev/null
sleep 1
npm run dev
