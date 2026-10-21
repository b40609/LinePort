@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0yomi-probe\start.ps1" -Device IOSIPAD
if errorlevel 1 pause
