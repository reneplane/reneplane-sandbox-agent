# Reneplane Local installer for Windows. Served by get.reneplane.com with your one-time token filled in:
#   irm "https://get.reneplane.com/local.ps1?t=<token>" | iex
# Installs into %USERPROFILE%\.reneplane (no admin rights), pairs with your browser, starts at login.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Token = '__RENEPLANE_TOKEN__'
$GetUrl = '__RENEPLANE_GET_URL__'
$Release = '__RENEPLANE_RELEASE_URL__'

function Fail($message) {
  Write-Host ''
  Write-Host "Reneplane Local could not be installed: $message" -ForegroundColor Red
  Write-Host 'Copy a fresh command from the workspace and try again. If it keeps failing, run it again and send us the message above.'
  break
}

Write-Host 'Installing Reneplane Local...'
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'it needs 64-bit Windows.' }
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { Fail 'Windows on Arm is not supported yet.' }

$RpHome = Join-Path $env:USERPROFILE '.reneplane'
$Bin = Join-Path $RpHome 'bin'
$Asset = 'reneplane-local-win32-x64.zip'
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('reneplane-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Temp | Out-Null

try {
  Write-Host '  Downloading...'
  Invoke-WebRequest -UseBasicParsing -Uri "$Release/$Asset" -OutFile (Join-Path $Temp $Asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$Release/SHA256SUMS" -OutFile (Join-Path $Temp 'SHA256SUMS')
  $expected = ((Get-Content (Join-Path $Temp 'SHA256SUMS')) | Where-Object { $_ -match " $([Regex]::Escape($Asset))$" } | Select-Object -First 1) -split '\s+' | Select-Object -First 1
  $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $Temp $Asset)).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { Fail 'the download did not match its checksum.' }

  Write-Host '  Unpacking...'
  $Unpacked = Join-Path $Temp 'release'
  Expand-Archive -Path (Join-Path $Temp $Asset) -DestinationPath $Unpacked -Force
  $Version = (Get-Content (Join-Path $Unpacked 'app\VERSION') -Raw).Trim()

  # An older Reneplane Local may be running from this folder: stop it so its files can be replaced
  $Node = Join-Path $Bin 'node.exe'
  $Launch = Join-Path $Bin 'launch.mjs'
  if ((Test-Path $Node) -and (Test-Path $Launch)) { & $Node $Launch stop *> $null }

  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  Copy-Item -Force (Join-Path $Unpacked 'node.exe') $Node
  Copy-Item -Force (Join-Path $Unpacked 'launch.mjs') $Launch
  $App = Join-Path $Bin "app-$Version"
  if (Test-Path $App) { Remove-Item -Recurse -Force $App }
  Copy-Item -Recurse -Force (Join-Path $Unpacked 'app') $App
  Set-Content -Encoding ascii -Path (Join-Path $Bin 'current.json') -Value ('{"version":"' + $Version + '"}')

  Write-Host "  Pairing with your browser and starting Reneplane Local $Version..."
  & $Node $Launch setup --token $Token --get $GetUrl
  if ($LASTEXITCODE -ne 0) { Fail 'setup did not finish.' }
  Write-Host ''
  Write-Host 'Go back to the workspace tab and click Allow if your browser asks.' -ForegroundColor Green
}
finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
