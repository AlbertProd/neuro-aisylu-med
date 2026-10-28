$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$aisyluNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $aisyluNode) {
    $aisyluNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $aisyluNode)) { throw 'Установи Node.js 24 или новее' }
& $aisyluNode --env-file-if-exists=.env src/index.js
exit $LASTEXITCODE
