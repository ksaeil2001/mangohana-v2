param([Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference='Stop'
$results=@()
function Invoke-Check([string]$program,[string[]]$arguments) {
    $output=@(& $program @arguments 2>&1 | ForEach-Object { $_.ToString() })
    [ordered]@{executable=$program;args=$arguments;exitCode=$LASTEXITCODE;output=$output}
}
$results+=Invoke-Check $Node @('--check','scripts/v2/warm-job.mjs')
$results+=Invoke-Check $Node @('--check','scripts/v2/typesetting-only-worker.cjs')
$results+=Invoke-Check $Node @('packages/ai-engine/node_modules/typescript/bin/tsc','--noEmit','-p','packages/ai-engine/tsconfig.json')
$results+=Invoke-Check 'git' @('diff','--check','--','scripts/v2/warm-job.mjs','scripts/v2/warm-job.ps1','scripts/v2/typesetting-only-worker.cjs','packages/ai-engine/package.json','packages/ai-engine/package-lock.json')
$tokens=$null
$problems=$null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/v2/warm-job.ps1'),[ref]$tokens,[ref]$problems)
$pass=@($results | Where-Object {$_.exitCode -ne 0}).Count -eq 0 -and $problems.Count -eq 0
[ordered]@{pass=$pass;checks=$results;powershellParseErrors=@($problems | ForEach-Object Message)} | ConvertTo-Json -Depth 5
if(-not $pass) {exit 1}
