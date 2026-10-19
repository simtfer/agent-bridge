param(
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $root "bin\jobrun.exe" }

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
  throw "csc.exe not found. Install .NET Framework 4.x or build jobrun.cs with your own toolchain."
}

$source = Join-Path $root "native\jobrun.cs"
if (-not (Test-Path $source)) { throw "missing source: $source" }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
& $csc /nologo /target:exe /platform:anycpu /optimize+ "/out:$OutFile" $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Output "built $OutFile"
