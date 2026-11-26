@echo off
rem wxmp launcher for Windows: search / track / download WeChat Official Account articles (read-only).
rem Node writes Unicode to the console directly, so the code page is left alone (and the message below is ASCII).
where node >nul 2>nul || (echo wxmp needs Node.js 22.13 or newer, but node was not found. 1>&2 & echo Install it with: winget install OpenJS.NodeJS.LTS  - or download the LTS installer from https://nodejs.org - then open a new terminal. See README.md. 1>&2 & exit /b 1)
node --no-warnings "%~dp0scripts\wxmp.mjs" %*
