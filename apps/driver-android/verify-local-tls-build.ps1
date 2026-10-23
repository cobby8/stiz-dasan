param([string]$AndroidSdk = $env:ANDROID_HOME)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
if (-not $AndroidSdk) { throw 'ANDROID_HOME or -AndroidSdk is required' }
$aapt = Join-Path $AndroidSdk 'build-tools/36.0.0/aapt2.exe'
if (-not (Test-Path -LiteralPath $aapt)) { throw 'Android SDK Build Tools 36.0.0 is required for verification' }
$debugApk = Join-Path $projectDirectory 'app/build/outputs/apk/debug/app-debug.apk'
$releaseApk = Join-Path $projectDirectory 'app/build/outputs/apk/release/app-release-unsigned.apk'
$checks = 0
function Assert-Build([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
    $script:checks++
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$debug = [System.IO.Compression.ZipFile]::OpenRead($debugApk)
$release = [System.IO.Compression.ZipFile]::OpenRead($releaseApk)
try {
    $debugNames = @($debug.Entries | ForEach-Object FullName)
    $releaseNames = @($release.Entries | ForEach-Object FullName)
    Assert-Build ($debugNames -contains 'res/raw/driver_test_ca.cer') 'Debug public CA is missing'
    Assert-Build ($debugNames -contains 'res/xml/local_test_network_security.xml') 'Debug local trust config is missing'
    Assert-Build (-not ($releaseNames -contains 'res/raw/driver_test_ca.cer')) 'Release contains the debug CA'
    Assert-Build (-not ($releaseNames -contains 'res/xml/local_test_network_security.xml')) 'Release contains debug trust config'
    Assert-Build (-not ($debugNames -match '\.(key|p12|pfx|keystore|jks)$')) 'Unexpected private credential file in debug APK'
    Assert-Build (-not ($releaseNames -match '\.(key|p12|pfx|keystore|jks)$')) 'Unexpected private credential file in release APK'
} finally { $debug.Dispose(); $release.Dispose() }
$debugManifest = (& $aapt dump xmltree $debugApk --file AndroidManifest.xml) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect debug manifest' }
$releaseManifest = (& $aapt dump xmltree $releaseApk --file AndroidManifest.xml) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect release manifest' }
Assert-Build ($debugManifest -match 'kr\.stiz\.driver\.devicetest') 'Debug test package is not isolated'
Assert-Build ($releaseManifest -match 'package="kr\.stiz\.driver"') 'Release package changed'
Assert-Build (-not ($releaseManifest -match 'networkSecurityConfig')) 'Release declares custom network trust'
Assert-Build ($debugManifest -match 'networkSecurityConfig') 'Debug custom trust is not declared'
$releaseConfig = Get-Content -LiteralPath (Join-Path $projectDirectory 'app/build/generated/source/buildConfig/release/kr/stiz/driver/BuildConfig.java') -Raw
Assert-Build ($releaseConfig -match 'STIZ_ORIGIN = "https://www\.stiz-dasan\.kr"') 'Release origin is not production'
$debugConfig = Get-Content -LiteralPath (Join-Path $projectDirectory 'app/build/generated/source/buildConfig/debug/kr/stiz/driver/BuildConfig.java') -Raw
Assert-Build ($debugConfig -match 'STIZ_ORIGIN = "https://localhost(?::8443)?"') 'Debug local origin is not an allowed exact port'
[xml]$trust = Get-Content -LiteralPath (Join-Path $projectDirectory 'app/build/generated/localTlsDebug/res/xml/local_test_network_security.xml') -Raw
$customAnchors = @($trust.SelectNodes('//certificates[@src="@raw/driver_test_ca"]'))
Assert-Build ($customAnchors.Count -eq 1 -and $customAnchors[0].ParentNode.ParentNode.Name -eq 'domain-config' -and $customAnchors[0].ParentNode.ParentNode.SelectSingleNode('domain').InnerText -eq 'localhost') 'CA trust is not restricted to localhost'
Assert-Build ($trust.SelectNodes('//*[@cleartextTrafficPermitted="true"]').Count -eq 0) 'Cleartext traffic became permitted'
Write-Output "PASS $checks local-TLS debug/release isolation checks"
