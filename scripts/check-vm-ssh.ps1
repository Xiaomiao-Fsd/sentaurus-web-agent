$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sshDir = Join-Path $env:USERPROFILE ".ssh"
$publicKeyPath = Join-Path $sshDir "sentaurus_vm_ed25519.pub"
$privateKeyPath = Join-Path $sshDir "sentaurus_vm_ed25519"
$sshTarget = "sentaurus-centos7"
$backendUrl = "http://[::1]:5175"

function Write-Section($title) {
  Write-Host ""
  Write-Host "== $title =="
}

function Read-AuthToken {
  $envPath = Join-Path $projectRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    return $null
  }

  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^AUTH_TOKEN=" } | Select-Object -First 1
  if (-not $line) {
    return $null
  }

  return $line -replace "^AUTH_TOKEN=", ""
}

function Test-TcpPort($hostName, $port, $timeoutMs = 3000) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($hostName, $port)
    if (-not $task.Wait($timeoutMs)) {
      return $false
    }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Read-TextFile($path) {
  if (-not (Test-Path -LiteralPath $path)) {
    return ""
  }

  $text = Get-Content -LiteralPath $path -Raw
  if ($null -eq $text) {
    return ""
  }

  return $text.Trim()
}

Write-Section "Host SSH files"
Write-Host "Private key: $privateKeyPath"
Write-Host "Public key:  $publicKeyPath"
Write-Host "Private key exists: $(Test-Path -LiteralPath $privateKeyPath)"
Write-Host "Public key exists:  $(Test-Path -LiteralPath $publicKeyPath)"

if (Test-Path -LiteralPath $publicKeyPath) {
  $publicKey = (Get-Content -LiteralPath $publicKeyPath -Raw).Trim()
  Write-Host "Public key value:"
  Write-Host $publicKey
} else {
  $publicKey = $null
}

Write-Section "SSH alias"
$sshConfig = ssh -G $sshTarget
$sshConfig | Select-String -Pattern "^(user|hostname|port|identityfile|identitiesonly|connecttimeout) "
$vmHost = (($sshConfig | Select-String -Pattern "^hostname ").Line -replace "^hostname\s+", "").Trim()
if (-not $vmHost) {
  $vmHost = $sshTarget
}
Write-Host "Resolved VM host: $vmHost"

Write-Section "VM port"
Write-Host "22/tcp reachable: $(Test-TcpPort $vmHost 22)"

Write-Section "Backend health"
$token = Read-AuthToken
try {
  Invoke-RestMethod -Uri "$backendUrl/api/health" | ConvertTo-Json -Depth 5
} catch {
  Write-Host "Backend health failed: $($_.Exception.Message)"
}

if ($token) {
  Write-Section "Backend VM status"
  try {
    Invoke-RestMethod -Uri "$backendUrl/api/vm/status" -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 8
  } catch {
    Write-Host "VM status failed: $($_.Exception.Message)"
  }
} else {
  Write-Host "AUTH_TOKEN was not found in .env; skipping authenticated backend checks."
}

Write-Section "Batch SSH"
$batchSshOk = $false
$sshOut = Join-Path $env:TEMP "sentaurus-vm-ssh-check.out"
$sshErr = Join-Path $env:TEMP "sentaurus-vm-ssh-check.err"
Remove-Item -LiteralPath $sshOut, $sshErr -ErrorAction SilentlyContinue

$sshProcess = Start-Process -FilePath "ssh" -ArgumentList @(
  "-o", "BatchMode=yes",
  "-o", "PreferredAuthentications=publickey",
  "-o", "PasswordAuthentication=no",
  "-o", "KbdInteractiveAuthentication=no",
  "-o", "GSSAPIAuthentication=no",
  "-o", "NumberOfPasswordPrompts=0",
  "-o", "ConnectTimeout=8",
  "-o", "ConnectionAttempts=1",
  $sshTarget,
  "hostname; whoami; hostname -I"
) -PassThru -RedirectStandardOutput $sshOut -RedirectStandardError $sshErr

if (-not $sshProcess.WaitForExit(10000)) {
  Stop-Process -Id $sshProcess.Id -Force -ErrorAction SilentlyContinue
  Write-Host "Batch SSH timed out after 10s and was stopped."
} else {
  $sshProcess.Refresh()
  Write-Host "Batch SSH exit code: $($sshProcess.ExitCode)"
}

$stdoutText = Read-TextFile $sshOut
if ($stdoutText) {
  $batchSshOk = $stdoutText -match "TCAD2022"
  Write-Host "stdout:"
  Write-Host $stdoutText
}

$stderrText = Read-TextFile $sshErr
if ($stderrText) {
  Write-Host "stderr:"
  Write-Host $stderrText
}

$sshProcess.Refresh()
if (-not $sshProcess.HasExited) {
  Stop-Process -Id $sshProcess.Id -Force -ErrorAction SilentlyContinue
}

if ($publicKey -and -not $batchSshOk) {
  Write-Section "Command to run inside the CentOS VM"
  Write-Host "Log in to the VM console as TCAD2022, then run:"
  Write-Host ""
  Write-Host "mkdir -p ~/.ssh"
  Write-Host "chmod 700 ~/.ssh"
  Write-Host "grep -qxF '$publicKey' ~/.ssh/authorized_keys 2>/dev/null || echo '$publicKey' >> ~/.ssh/authorized_keys"
  Write-Host "chmod 600 ~/.ssh/authorized_keys"
  Write-Host "restorecon -Rv ~/.ssh 2>/dev/null || true"
}
