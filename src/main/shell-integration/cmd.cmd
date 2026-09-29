@echo off
rem TerminalS startup for cmd.exe: runs the user startup script, if any.
rem Prompt markers are set through the PROMPT variable by the app.
if defined TERMINALS_PRESCRIPT if exist "%TERMINALS_PRESCRIPT%" call "%TERMINALS_PRESCRIPT%"
set TERMINALS_PRESCRIPT=
