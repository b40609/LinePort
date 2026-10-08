@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0yomi-probe\start-relay.ps1" -Interactive
if errorlevel 1 pause
