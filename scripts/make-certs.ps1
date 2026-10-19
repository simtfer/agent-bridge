param(
  [string]$OutDir = "certs",
  [string]$RunnerHost = "127.0.0.1",
  [string]$GatewayHost = "127.0.0.1",
  [int]$Days = 825
)

$ErrorActionPreference = "Stop"

function Write-Pem {
  param([string]$Path, [string]$Label, [byte[]]$Bytes)
  $base64 = [Convert]::ToBase64String($Bytes, [Base64FormattingOptions]::InsertLineBreaks)
  $text = "-----BEGIN $Label-----`n$base64`n-----END $Label-----`n"
  [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}

function Add-HostSan {
  param($Builder, [string]$HostName)
  $address = $null
  if ([Net.IPAddress]::TryParse($HostName, [ref]$address)) {
    $Builder.AddIpAddress($address)
  } else {
    $Builder.AddDnsName($HostName)
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

# --- CA -------------------------------------------------------------------
$caRsa = [Security.Cryptography.RSA]::Create(3072)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=agent-bridge-ca",
  $caRsa,
  [Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
    [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,
    $true
  )
)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false)
)

$notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)
$notAfter = [DateTimeOffset]::UtcNow.AddDays($Days)
$ca = $caRequest.CreateSelfSigned($notBefore, $notAfter)

Write-Pem -Path (Join-Path $OutDir "ca.crt") -Label "CERTIFICATE" -Bytes $ca.Export(
  [Security.Cryptography.X509Certificates.X509ContentType]::Cert
)
$caKeyPath = Join-Path $OutDir "ca.key"
[IO.File]::WriteAllText($caKeyPath, $caRsa.ExportPkcs8PrivateKeyPem(), [Text.UTF8Encoding]::new($false))

function New-Leaf {
  param([string]$Name, [string]$CommonName, [string[]]$Hosts)
  $rsa = [Security.Cryptography.RSA]::Create(2048)
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=$CommonName",
    $rsa,
    [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $request.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
  )
  $request.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
      [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
      $true
    )
  )
  $oids = [Security.Cryptography.OidCollection]::new()
  [void]$oids.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1")) # serverAuth
  $request.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
  )
  $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  foreach ($hostName in $Hosts) {
    if ($hostName) { Add-HostSan -Builder $san -HostName $hostName }
  }
  $request.CertificateExtensions.Add($san.Build())

  $serial = [byte[]]::new(16)
  [Security.Cryptography.RandomNumberGenerator]::Fill($serial)
  $leaf = $request.Create($ca, $notBefore, $notAfter, $serial)

  Write-Pem -Path (Join-Path $OutDir "$Name.crt") -Label "CERTIFICATE" -Bytes $leaf.Export(
    [Security.Cryptography.X509Certificates.X509ContentType]::Cert
  )
  [IO.File]::WriteAllText(
    (Join-Path $OutDir "$Name.key"),
    $rsa.ExportPkcs8PrivateKeyPem(),
    [Text.UTF8Encoding]::new($false)
  )
}

New-Leaf -Name "runner" -CommonName "agent-bridge-runner" -Hosts @($RunnerHost, "localhost")
New-Leaf -Name "gateway" -CommonName "agent-bridge-gateway" -Hosts @($GatewayHost, "localhost", "127.0.0.1")

# Key files are secrets; restrict to the current user.
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($file in @("ca.key", "runner.key", "gateway.key")) {
  $path = Join-Path $OutDir $file
  & icacls $path /inheritance:r | Out-Null
  & icacls $path /grant:r "*$($currentSid):(R,W)" | Out-Null
}

Write-Output "certificates written to $OutDir"
Write-Output "  ca.crt / ca.key"
Write-Output "  runner.crt / runner.key   (SAN: $RunnerHost, localhost)"
Write-Output "  gateway.crt / gateway.key (SAN: $GatewayHost, localhost, 127.0.0.1)"
Write-Output ""
Write-Output "Copy ca.crt to A and B. Do not copy *.key except to the machine that serves it."
