param([string]$ApiUrl = 'http://10.0.2.2:8080/v1')
$ErrorActionPreference = 'Stop'
$project = Join-Path (Split-Path $PSScriptRoot -Parent) 'android'
$wrapper = Join-Path $project 'gradlew.bat'
if (-not (Test-Path $wrapper)) { throw 'The Gradle wrapper is missing. Generate it with Gradle 8.11.1.' }
& $wrapper -p $project "-PSAHAL_API_URL=$ApiUrl" :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
if ($LASTEXITCODE -ne 0) { throw 'Android verification failed.' }
Write-Output (Join-Path $project 'app\build\outputs\apk\debug\app-debug.apk')
