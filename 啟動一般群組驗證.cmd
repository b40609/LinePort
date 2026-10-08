@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0yomi-probe\start.ps1"
if errorlevel 1 pause
