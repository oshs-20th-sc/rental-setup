@echo off
node "%~dp0bin\rental-setup.cjs" %*
exit /b %errorlevel%
