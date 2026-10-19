param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$script = Join-Path $PSScriptRoot "mock-pi.mjs"
& node $script @Args
exit $LASTEXITCODE
