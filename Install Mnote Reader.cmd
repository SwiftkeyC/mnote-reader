@echo off
rem Mnote Reader setup for this Windows account (no administrator rights needed):
rem .mnote and .mnotebook files open in the reader, and "Mnote Reader" is added to the Start menu.
rem It opens Documents\OneNote Export, and keeps the browser chosen before (Edge if none).
title Mnote Reader setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mnote.ps1" install %*
echo.
pause