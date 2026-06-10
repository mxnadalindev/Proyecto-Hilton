@echo off
cd /d "%~dp0"
start /min "" node server.js
timeout /t 3 /nobreak >nul
start "" "http://localhost:5000"
