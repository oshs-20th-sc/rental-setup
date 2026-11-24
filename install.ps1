$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$node = Get-Command node.exe -ErrorAction Stop
$version = & $node.Source -p "process.versions.node"
if ([version]$version -lt [version]'24.22.3' -or ([version]$version).Major -ne 24) { throw 'Install compatible Node.js 24.x (>=24.22.3), then retry.' }
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
if (Test-Path -LiteralPath 'package-lock.json') { & $npm ci } else { & $npm install }
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
& $npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
$private = Join-Path $env:LOCALAPPDATA 'OhsungRental-private'
if (-not (Test-Path -LiteralPath $private)) { & "$PSScriptRoot\bin\private-acl.ps1" -Target $private -Initialize } else { & "$PSScriptRoot\bin\private-acl.ps1" -Target $private }
Write-Host 'Installation complete. Run npm.cmd run login, then .\rental-setup.cmd setup-status.'
