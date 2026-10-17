<#
.SYNOPSIS
  Builds the CodeJudge sandbox images and writes sandbox/images/images.lock.json.

.DESCRIPTION
  Every base image in sandbox/images/*.Dockerfile is pinned by digest. The built
  images are local (no registry), so the runner pins them by image ID: this
  script records each image's ID (sha256:...) in images.lock.json, and the runner
  creates containers from those IDs, never from mutable tags.

  Only images tagged codejudge/* are created; nothing else in Docker is touched.
#>
param(
  [string]$Tag = 'dev'
)
$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$context = Join-Path $root 'runner'
$imgDir  = Join-Path $root 'sandbox/images' # '/' works on Windows and on Linux pwsh (CI)
$lock    = Join-Path $imgDir 'images.lock.json'

$images = [ordered]@{
  'cpp-compile'  = 'cpp-compile.Dockerfile'
  'cpp-run'      = 'cpp-run.Dockerfile'
  'python'       = 'python.Dockerfile'
  'java-compile' = 'java-compile.Dockerfile'
  'java-run'     = 'java-run.Dockerfile'
  'node'         = 'node.Dockerfile'
  'go-compile'   = 'go-compile.Dockerfile'
}

$result = [ordered]@{}
foreach ($name in $images.Keys) {
  $dockerfile = Join-Path $imgDir $images[$name]
  $ref = "codejudge/judge-${name}:$Tag"
  Write-Host "==> building $ref"
  # BuildKit writes progress to stderr; in Windows PowerShell 5.1 that becomes an
  # error record, which 'Stop' would turn fatal. Judge success by exit code only.
  $ErrorActionPreference = 'Continue'
  & docker build --file $dockerfile --tag $ref --label judge.managed=true $context
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { throw "docker build failed for $ref (exit $code)" }
  $id = (& docker image inspect --format '{{.Id}}' $ref).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $id.StartsWith('sha256:')) { throw "could not read image ID for $ref" }
  $result[$name] = $id
  Write-Host "    $ref -> $id"
}

$json = $result | ConvertTo-Json
[IO.File]::WriteAllText($lock, $json + "`n")
Write-Host "wrote $lock"
