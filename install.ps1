# Installs Token-Coach in Claude Code for good (every session, the desktop
# app, the terminal and VS Code). Running it again updates it.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  # The desktop app ships Claude Code but does not put it on the PATH.
  $claude = Get-ChildItem "$env:LOCALAPPDATA\Claude-Data" -Recurse -Filter claude.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\claude-code\\' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $claude) {
  Write-Host 'Claude Code was not found. Please install the Claude desktop app or Claude Code first.'
  exit 1
}

$known = & $claude plugin marketplace list 2>$null | Out-String
if ($known -match 'novaprior') {
  & $claude plugin marketplace update novaprior
} else {
  & $claude plugin marketplace add $here
}
$installed = & $claude plugin list 2>$null | Out-String
if ($installed -match 'token-coach@novaprior') {
  & $claude plugin update token-coach@novaprior
} else {
  & $claude plugin install token-coach@novaprior
}

Write-Host ''
Write-Host 'Done. Open a new session in Claude; /token-coach opens the panel.'
