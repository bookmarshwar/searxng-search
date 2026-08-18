param(
    [Parameter(Mandatory = $true)][string]$u,
    [ValidateSet('markdown', 'text', 'html')][string]$f = 'markdown',
    [int]$t = 30
)

$ErrorActionPreference = 'Stop'

# node outputs UTF-8; PowerShell 5.1 decodes native output via the console code page.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$jsPath = Join-Path $scriptDir 'fetch.js'

if (-not (Test-Path -LiteralPath $jsPath)) {
    Write-Error "fetch.js not found next to fetch.ps1: $jsPath"
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'node not found in PATH; install Node.js to use searxng-search'
    exit 1
}

try {
    & $node.Source $jsPath --url $u --format $f --timeout $t
} catch {
    Write-Error "searxng-fetch failed: $_"
    exit 1
}
exit $LASTEXITCODE