$ErrorActionPreference = 'Stop'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir = Join-Path (Get-Location) 'host-assessment-reports'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir ("candidate-host-$env:COMPUTERNAME-$stamp.txt")

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('Total Tools POS — Candidate Host Report')
$lines.Add(('Generated: ' + (Get-Date).ToString('o')))
$lines.Add(('Computer: ' + $env:COMPUTERNAME))
$lines.Add(('User: ' + $env:USERNAME))
$lines.Add('')

$assessment = & (Join-Path $PSScriptRoot 'candidate-host-assessment.ps1') 2>&1
$exitCode = $LASTEXITCODE
foreach ($line in $assessment) { $lines.Add([string]$line) }
$lines.Add('')
$lines.Add(('ASSESSMENT_EXIT_CODE: ' + $exitCode))
$lines | Set-Content -Path $outFile -Encoding UTF8

Write-Output ('REPORT_FILE: ' + $outFile)
Get-Content $outFile
exit $exitCode
