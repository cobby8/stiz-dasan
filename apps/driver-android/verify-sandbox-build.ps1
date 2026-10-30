param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$ExpectedOrigin = 'https://localhost:8453'
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
if (-not $AndroidSdk) { throw 'ANDROID_HOME or -AndroidSdk is required' }
$aapt = Join-Path $AndroidSdk 'build-tools/36.0.0/aapt2.exe'
if (-not (Test-Path -LiteralPath $aapt)) { throw 'Android SDK Build Tools 36.0.0 is required' }
$debugApk = Join-Path $projectDirectory 'app/build/outputs/apk/debug/app-debug.apk'
$releaseApk = Join-Path $projectDirectory 'app/build/outputs/apk/release/app-release-unsigned.apk'
$checks = 0
function Assert-Sandbox([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
    $script:checks++
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$debug = [System.IO.Compression.ZipFile]::OpenRead($debugApk)
$release = [System.IO.Compression.ZipFile]::OpenRead($releaseApk)
try {
    $debugNames = @($debug.Entries | ForEach-Object FullName)
    $releaseNames = @($release.Entries | ForEach-Object FullName)
    Assert-Sandbox ($debugNames -contains 'res/raw/driver_test_ca.cer') 'Sandbox public CA missing'
    Assert-Sandbox ($debugNames -contains 'res/xml/local_test_network_security.xml') 'Sandbox TLS config missing'
    Assert-Sandbox (-not ($releaseNames -contains 'res/raw/driver_test_ca.cer')) 'Release contains sandbox CA'
    Assert-Sandbox (-not ($releaseNames -contains 'res/xml/local_test_network_security.xml')) 'Release contains sandbox TLS config'
    Assert-Sandbox (-not ($debugNames -match '\.(key|p8|p12|pfx|keystore|jks)$')) 'Unexpected private credential in sandbox APK'
    Assert-Sandbox (-not ($releaseNames -match '\.(key|p8|p12|pfx|keystore|jks)$')) 'Unexpected private credential in release APK'
} finally { $debug.Dispose(); $release.Dispose() }
$debugManifest = (& $aapt dump xmltree $debugApk --file AndroidManifest.xml) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect sandbox manifest' }
$releaseManifest = (& $aapt dump xmltree $releaseApk --file AndroidManifest.xml) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect release manifest' }
Assert-Sandbox ($debugManifest -match 'package="kr\.stiz\.driver\.sandbox"') 'Sandbox package not isolated'
Assert-Sandbox ($debugManifest -match 'networkSecurityConfig') 'Sandbox custom trust missing'
Assert-Sandbox ($releaseManifest -match 'package="kr\.stiz\.driver"') 'Release package changed'
Assert-Sandbox (-not ($releaseManifest -match 'networkSecurityConfig')) 'Release has custom trust'
$debugConfig = Get-Content -LiteralPath (Join-Path $projectDirectory 'app/build/generated/source/buildConfig/debug/kr/stiz/driver/BuildConfig.java') -Raw
$releaseConfig = Get-Content -LiteralPath (Join-Path $projectDirectory 'app/build/generated/source/buildConfig/release/kr/stiz/driver/BuildConfig.java') -Raw
Assert-Sandbox ($debugConfig -match ('STIZ_ORIGIN = "' + [regex]::Escape($ExpectedOrigin) + '"')) 'Sandbox origin differs from selected server'
Assert-Sandbox ($debugConfig -match 'STIZ_SANDBOX = true') 'Sandbox flag not true'
Assert-Sandbox ($debugConfig -match 'STIZ_NATIVE_AUTH = false') 'Sandbox provider auth enabled'
Assert-Sandbox ($debugConfig -match 'STIZ_UNIFIED_APP = true') 'Sandbox unified mode missing'
Assert-Sandbox ($releaseConfig -match 'STIZ_ORIGIN = "https://www\.stiz-dasan\.kr"') 'Release origin changed'
Assert-Sandbox ($releaseConfig -match 'STIZ_SANDBOX = false') 'Release sandbox enabled'
Assert-Sandbox ($releaseConfig -match 'STIZ_NATIVE_AUTH = false') 'Release development auth enabled'
[xml]$trust = Get-Content -LiteralPath (Join-Path $projectDirectory 'app/build/generated/localTlsDebug/res/xml/local_test_network_security.xml') -Raw
$anchors = @($trust.SelectNodes('//certificates'))
Assert-Sandbox ($anchors.Count -eq 2) 'Unexpected sandbox trust anchor structure'
Assert-Sandbox ($trust.SelectNodes('//certificates[@src="system" or @src="user"]').Count -eq 0) 'Sandbox trusts system/user CAs'
Assert-Sandbox (@($anchors | Where-Object { $_.src -ne '@raw/driver_test_ca' }).Count -eq 0) 'Sandbox trusts a non-sandbox CA'
Assert-Sandbox ($trust.SelectNodes('//domain').Count -eq 1) 'Unexpected sandbox trust domains'
$expectedHost = ([uri]$ExpectedOrigin).Host
Assert-Sandbox ($trust.SelectSingleNode('//domain').InnerText -eq $expectedHost) 'Sandbox domain differs from exact selected origin'
Assert-Sandbox ($trust.SelectSingleNode('//domain').includeSubdomains -eq 'false') 'Sandbox trusts subdomains'
Assert-Sandbox ($trust.SelectNodes('//*[@cleartextTrafficPermitted="true"]').Count -eq 0) 'Sandbox allows cleartext'
Write-Output "PASS $checks sandbox debug/release artifact isolation checks; no install, network, private key access"
