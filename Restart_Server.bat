@echo off
echo  Stopping any process on port 8083...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8083"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
start "Snake Server" python server.py
echo  Server restarted.
