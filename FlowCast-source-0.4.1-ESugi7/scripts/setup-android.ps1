$ErrorActionPreference = 'Stop'
$toolsRoot = Join-Path $PSScriptRoot '..\.toolchain'
[IO.Directory]::CreateDirectory($toolsRoot) | Out-Null
function FetchZip($Url, $Name, $Destination) {
 $archive = Join-Path $toolsRoot $Name
 if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $archive -TimeoutSec 900 }
 if (!(Test-Path -LiteralPath $Destination)) { Expand-Archive -LiteralPath $archive -DestinationPath $Destination }
}
$assets = Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
FetchZip $assets[0].binary.package.link 'jdk17.zip' (Join-Path $toolsRoot 'jdk')
$env:JAVA_HOME = (Get-ChildItem (Join-Path $toolsRoot 'jdk') -Directory | Select-Object -First 1).FullName
FetchZip 'https://services.gradle.org/distributions/gradle-8.13-bin.zip' 'gradle.zip' (Join-Path $toolsRoot 'gradle')
[xml]$repository = (Invoke-WebRequest -UseBasicParsing 'https://dl.google.com/android/repository/repository2-1.xml').Content
$package = $repository.SelectNodes('//*[local-name()="remotePackage"]') | Where-Object { $_.path -eq 'cmdline-tools;latest' }
$archive = $package.archives.archive | Where-Object { $_.'host-os' -eq 'windows' }
FetchZip ('https://dl.google.com/android/repository/' + $archive.complete.url) 'android-cli.zip' (Join-Path $toolsRoot 'android-cli')
$env:ANDROID_HOME = Join-Path $toolsRoot 'android-sdk'
$sdkManager = Join-Path $toolsRoot 'android-cli\cmdline-tools\bin\sdkmanager.bat'
Write-Output ('JAVA_HOME=' + $env:JAVA_HOME)
Write-Output ('Android tooling ready at ' + $sdkManager)
(1..100 | ForEach-Object { 'y' }) | & $sdkManager --sdk_root=$env:ANDROID_HOME --licenses
if ($LASTEXITCODE -ne 0) { throw 'Android SDK license acceptance required' }
& $sdkManager --sdk_root=$env:ANDROID_HOME 'platforms;android-36' 'build-tools;36.0.0' 'platform-tools'
if ($LASTEXITCODE -ne 0) { throw 'Android SDK installation failed' }
