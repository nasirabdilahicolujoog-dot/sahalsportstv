$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'backend\.env'
if (-not (Test-Path $envFile)) { throw 'backend\.env is missing.' }

$pg = 'C:\Program Files\PostgreSQL\18\bin'
$data = Join-Path $root '.devpg'
if (-not (Test-Path $data)) { throw 'The development database cluster is missing.' }

& "$pg\pg_ctl.exe" status -D $data *> $null
if ($LASTEXITCODE -ne 0) {
    & "$pg\pg_ctl.exe" -D $data -l (Join-Path $data 'postgres.log') -o '-h 127.0.0.1 -p 5433 -c unix_socket_directories=' -w -t 30 start
    if ($LASTEXITCODE -ne 0) { throw 'The development database could not be started.' }
}

Set-Location (Join-Path $root 'backend')
npm start
