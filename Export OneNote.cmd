@echo off
rem Exports every notebook that is open in the OneNote desktop app to Documents\OneNote Export.
rem First open OneNote, sign in, and open your notebooks (File > Open).
title Export OneNote notebooks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mnote.ps1" export %*
echo.
pause