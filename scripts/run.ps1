param(
    [Parameter(Mandatory = $true)][string]$q,
    [int]$n = 8,
    [int]$p = 1
)

$ErrorActionPreference = 'Stop'

# node outputs UTF-8 JSON; PowerShell 5.1 decodes native output via the console code page.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$jsPath = Join-Path $scriptDir 'search.js'

if (-not (Test-Path -LiteralPath $jsPath)) {
    Write-Error "search.js not found next to run.ps1: $jsPath"
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'node not found in PATH; install Node.js to use searxng-search'
    exit 1
}

try {
    & $node.Source $jsPath --query $q --count $n --page $p
} catch {
    Write-Error "searxng-search failed: $_"
    exit 1
}
exit $LASTEXITCODE
