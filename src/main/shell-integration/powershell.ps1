# TerminalS shell integration for Windows PowerShell 5.1 and PowerShell 7+.
# Runs the user's startup script, then wraps the prompt so it emits OSC 633
# markers: command finished (D;exitcode), current directory (P;Cwd=...),
# prompt start (A) and input start (B).
if ($global:__TerminalSIntegrated) { return }
$global:__TerminalSIntegrated = $true

# PSReadLine's own inline predictions would collide with TerminalS ghost text.
try {
  Import-Module PSReadLine -ErrorAction Stop
  Set-PSReadLineOption -PredictionSource None -ErrorAction Stop
} catch {}

# User startup script configured in TerminalS (Profiles & Environment).
if ($env:TERMINALS_PRESCRIPT -and (Test-Path -LiteralPath $env:TERMINALS_PRESCRIPT)) {
  try { . $env:TERMINALS_PRESCRIPT } catch { Write-Warning "TerminalS startup script failed: $_" }
}
Remove-Item Env:TERMINALS_PRESCRIPT -ErrorAction SilentlyContinue

$global:__TerminalSOriginalPrompt = $function:prompt

function global:prompt {
  $ok = $?
  $code = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
  $esc = [char]27
  $bel = [char]7
  $cwd = $ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath
  $out = ('{0}]633;D;{1}{2}' -f $esc, $code, $bel)
  $out += ('{0}]633;P;Cwd={1}{2}' -f $esc, $cwd, $bel)
  $out += ('{0}]633;A{1}' -f $esc, $bel)
  $out += & $global:__TerminalSOriginalPrompt
  $out += ('{0}]633;B{1}' -f $esc, $bel)
  return $out
}
