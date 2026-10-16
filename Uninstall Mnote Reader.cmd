@echo off
rem Removes the .mnote / .mnotebook file types and the Start menu shortcut. Notes are not touched.
title Mnote Reader removal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mnote.ps1" uninstall
echo.
pause