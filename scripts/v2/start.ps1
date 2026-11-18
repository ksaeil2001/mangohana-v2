param([ValidateSet('start','prepare','resources','test','build')][string]$Action='start',[string]$ConfigPath)
$ErrorActionPreference='Stop'
if ($ConfigPath -and $Action -ne 'start') { throw 'ConfigPath는 start 작업에서만 사용할 수 있습니다.' }
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeExecutable=$nodeCommand.Source }
else {
  $runtimePackage=Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $runtimePackage) { throw 'Node 24.x 또는 Codex Primary Runtime이 필요합니다.' }
  $nodeExecutable=Join-Path $runtimePackage.InstallLocation 'dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) { throw 'Node 실행 파일을 찾지 못했습니다.' }
$env:PATH=[IO.Path]::GetDirectoryName($nodeExecutable)+';'+$env:PATH
$outputRoot='E:\Dev\Outputs\MangohanaV2-20261111'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Push-Location -LiteralPath $repoRoot
try {
  switch ($Action) {
    'start' {
      if ($ConfigPath) { & $nodeExecutable 'scripts/v2/start.mjs' '--config' $ConfigPath }
      else { & $nodeExecutable 'scripts/v2/start.mjs' }
    }
    'prepare' { & $nodeExecutable 'scripts/v2/prepare.mjs' }
    'resources' { & $nodeExecutable 'scripts/v2/resources.mjs' }
    'build' { & $nodeExecutable 'scripts/v2/build-sites.mjs' }
    'test' {
      & $nodeExecutable 'scripts/v2/test.mjs'
    }
  }
  $executionCode=$LASTEXITCODE
}
finally { Pop-Location }
exit $executionCode
