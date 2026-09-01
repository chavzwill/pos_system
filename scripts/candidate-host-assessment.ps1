$ErrorActionPreference = 'SilentlyContinue'

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Add-Fail([string]$msg) { $failures.Add($msg) }
function Add-Warn([string]$msg) { $warnings.Add($msg) }

$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpuCount = [int]$env:NUMBER_OF_PROCESSORS
$ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
$systemDrive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))
$freeGb = if ($systemDrive) { [math]::Round($systemDrive.Free / 1GB, 1) } else { 0 }

Write-Output 'Total Tools POS — Candidate Host Assessment (Windows)'
Write-Output ('Computer: ' + $env:COMPUTERNAME)
Write-Output ('OS: ' + $os.Caption + ' ' + $os.Version)
Write-Output ('CPU logical processors: ' + $cpuCount)
Write-Output ('RAM GB: ' + $ramGb)
Write-Output ('System drive free GB: ' + $freeGb)

if ($cpuCount -lt 2) { Add-Fail 'Fewer than 2 logical CPUs.' }
if ($ramGb -lt 3.5) { Add-Fail 'Less than approximately 4 GB RAM.' }
if ($freeGb -lt 20) { Add-Fail 'Less than 20 GB free disk on the system drive.' }
elseif ($freeGb -lt 40) { Add-Warn 'Only 20–39 GB free disk; evidence uploads may require more headroom.' }

$docker = Get-Command docker
if (-not $docker) {
  Add-Warn 'Docker is not installed. The machine may still be repurposed by installing Linux or Docker Desktop, but Windows itself is not the certified production runtime.'
} else {
  $dockerVersion = docker version --format '{{.Server.Version}}' 2>$null
  if (-not $dockerVersion) { Add-Warn 'Docker command exists but the daemon is not running/accessible.' }
  else { Write-Output ('Docker server: ' + $dockerVersion) }
}

$composeOk = $false
if ($docker) {
  docker compose version *> $null
  if ($LASTEXITCODE -eq 0) { $composeOk = $true }
}
if (-not $composeOk) { Add-Warn 'Docker Compose v2 is not currently available.' }

$ethernet = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface -eq $true -and $_.PhysicalMediaType -match '802\.3|Ethernet' }
$wifi = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'Wi-Fi|Wireless|802\.11' }
if ($ethernet) { Write-Output 'Network: active wired adapter detected.' }
elseif ($wifi) { Add-Warn 'Only active wireless networking detected; wired networking is preferred for the POS host.' }
else { Add-Warn 'No active physical network adapter confidently identified.' }

try {
  $r = Invoke-WebRequest -Uri 'https://github.com' -Method Head -TimeoutSec 10 -UseBasicParsing
  if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { Write-Output 'Outbound HTTPS: reachable.' }
} catch { Add-Warn 'Outbound HTTPS connectivity check failed.' }

$uptime = (Get-Date) - $os.LastBootUpTime
Write-Output ('Uptime hours: ' + [math]::Round($uptime.TotalHours,1))

Write-Output ''
if ($failures.Count -gt 0) {
  Write-Output 'DECISION: FAIL'
  foreach ($f in $failures) { Write-Output ('FAIL: ' + $f) }
  foreach ($w in $warnings) { Write-Output ('WARN: ' + $w) }
  Write-Output 'Do not use this machine as the production POS host in its current state.'
  exit 2
}

if ($warnings.Count -gt 0) {
  Write-Output 'DECISION: CONDITIONAL'
  foreach ($w in $warnings) { Write-Output ('WARN: ' + $w) }
  Write-Output 'Hardware appears potentially usable, but production should still be migrated to the certified Linux runtime and all warnings resolved before cutover.'
  exit 0
}

Write-Output 'DECISION: CONDITIONAL'
Write-Output 'Hardware appears suitable for repurposing, but Windows is not the certified production runtime. Install/boot a supported Linux host environment and then run the Linux RC7 readiness gate.'
exit 0
