param(
  [string]$User = "agent-bridge",
  [string]$WorkRoot = "D:\agent-work",
  [string]$StateRoot = "D:\agent-state",
  [string]$Config = "D:\agent-bridge\config\runner.json",
  [string]$NodePath = "",
  [int]$Port = 8788,
  [string]$AllowFrom = "",
  [string]$TaskName = "agent-bridge-runner",
  [switch]$RegisterTask,
  [switch]$SkipUser,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "bin\agent-bridge.mjs"

function Invoke-Step {
  param([string]$Description, [scriptblock]$Action)
  Write-Host "==> $Description"
  if ($DryRun) {
    Write-Host "    (dry-run) skipped"
    return
  }
  & $Action
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell (Run as Administrator)."
  }
}

if (-not $DryRun) { Assert-Admin }

if (-not $NodePath) {
  $NodePath = (Get-Command node -ErrorAction Stop).Source
}
if (-not $DryRun -and -not (Test-Path $NodePath)) { throw "node not found: $NodePath" }
if (-not $DryRun -and -not (Test-Path $Config)) { throw "runner config not found: $Config" }

Write-Host "user       : $User"
Write-Host "workRoot   : $WorkRoot"
Write-Host "stateRoot  : $StateRoot"
Write-Host "config     : $Config"
Write-Host "node       : $NodePath"
Write-Host "port       : $Port"
Write-Host "allowFrom  : $(if ($AllowFrom) { $AllowFrom } else { '(not set)' })"
Write-Host ""

$passwordPlain = $null

if (-not $SkipUser) {
  Invoke-Step "Create local user '$User' (non-admin)" {
    $existing = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Host "    user already exists, leaving password unchanged"
    } else {
      $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
      $passwordPlain = -join (1..32 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
      $secure = ConvertTo-SecureString $passwordPlain -AsPlainText -Force
      New-LocalUser -Name $User -Password $secure -PasswordNeverExpires `
        -AccountNeverExpires -Description "agent-bridge runner (no admin)" | Out-Null
      $usersGroup = Get-LocalGroup -SID "S-1-5-32-545"
      Add-LocalGroupMember -Group $usersGroup -Member $User
      Write-Host "    created. One-time password: $passwordPlain"
      Write-Host "    Store it in a password manager; register the task with -RegisterTask."
    }
  }
} else {
  Write-Host "==> Skipping user creation (-SkipUser)"
}

Invoke-Step "Create work/state directories" {
  New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
}

Invoke-Step "Lock down ACLs (remove inheritance, grant user + admins + SYSTEM)" {
  foreach ($path in @($WorkRoot, $StateRoot)) {
    Write-Host "    $path"
    & icacls $path /inheritance:r | Out-Null
    & icacls $path /grant:r "$($User):(OI)(CI)F" | Out-Null
    & icacls $path /grant:r "*S-1-5-32-544:(OI)(CI)F" | Out-Null
    & icacls $path /grant:r "*S-1-5-18:(OI)(CI)F" | Out-Null
  }
}

Invoke-Step "Enable NTFS long paths" {
  Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name LongPathsEnabled -Value 1 -Type DWord
}

if ($AllowFrom) {
  Invoke-Step "Firewall: allow TCP $Port only from $AllowFrom" {
    $ruleName = "agent-bridge runner ($Port)"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
      -LocalPort $Port -RemoteAddress $AllowFrom -Action Allow -Profile Private,Domain | Out-Null
  }
} else {
  Write-Host "==> Firewall: skipped (set -AllowFrom <A 的 IP> to create a scoped rule)"
}

if ($RegisterTask) {
  if (-not $passwordPlain) {
    Write-Host "==> Task registration needs the account password; re-run without -SkipUser or create the task manually:"
    Write-Host "    schtasks /Create /TN $TaskName /SC ONSTART /RU $User /RP * /TR `"`"$NodePath`" `"$script`" runner --config `"$Config`"`""
  } else {
    Invoke-Step "Register scheduled task '$TaskName' at startup as '$User'" {
      $action = New-ScheduledTaskAction -Execute $NodePath `
        -Argument "`"$script`" runner --config `"$Config`"" `
        -WorkingDirectory (Split-Path -Parent $script)
      $trigger = New-ScheduledTaskTrigger -AtStartup
      $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Password -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Password $passwordPlain -Force | Out-Null
    }
  }
} else {
  Write-Host "==> Scheduled task: skipped (use -RegisterTask after checking the runner manually)"
}

Write-Host ""
Write-Host "Done."
Write-Host "Manual start (switch to the runner account first):"
Write-Host "  runas /user:$User cmd"
Write-Host "  then run:"
Write-Host "  `"$NodePath`" `"$script`" runner --config `"$Config`""
Write-Host "Health check from A:"
Write-Host "  curl http://<B-ip>:$Port/health"
