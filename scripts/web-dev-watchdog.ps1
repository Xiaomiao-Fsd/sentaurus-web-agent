param(
  [ValidateSet("status", "ensure", "start", "stop")]
  [string]$Mode = "status",
  [string]$HostAddress = "10.6.22.1",
  [int]$FrontendPort = 5174,
  [int]$BackendPort = 5175,
  [int]$StartupTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot "data\logs"
$currentFile = Join-Path $logDir "web-dev-current.txt"

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

function Test-HttpOk($uri, $headers = $null, $method = "GET", $body = $null, $timeoutSec = 8) {
  try {
    $args = @{
      UseBasicParsing = $true
      Uri = $uri
      Method = $method
      TimeoutSec = $timeoutSec
    }
    if ($headers) {
      $args.Headers = $headers
    }
    if ($null -ne $body) {
      $args.Body = $body
      $args.ContentType = "application/json"
    }

    $response = Invoke-WebRequest @args
    return @{
      ok = $true
      status = $response.StatusCode
      content = $response.Content
    }
  } catch {
    return @{
      ok = $false
      error = $_.Exception.Message
    }
  }
}

function Get-WebDevProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      if (-not $_.CommandLine) {
        return $false
      }

      $commandLine = $_.CommandLine
      return (
        $commandLine -match "concurrently .*@sentaurus-agent/server.*@sentaurus-agent/web" -or
        $commandLine -match "npm run dev -w @sentaurus-agent/(server|web)" -or
        $commandLine -match "vite --host .+ --port $FrontendPort" -or
        $commandLine -match "node\s+dist/index\.js"
      )
    } |
    Sort-Object ProcessId
}

function Get-PortListenerProcessIds {
  Get-NetTCPConnection -LocalPort @($FrontendPort, $BackendPort) -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -and $_.OwningProcess -ne 0 } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

function Test-BackendHealth($uri) {
  $result = Test-HttpOk $uri
  if (-not $result.ok) {
    return $result
  }

  $content = [string]$result.content
  if (-not $content.TrimStart().StartsWith("{")) {
    $result["ok"] = $false
    $result["error"] = "non-JSON response from backend health"
  }
  return $result
}

function Test-PortListening($port) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return $null -ne $connections
}

function Get-WebDevStatus {
  $frontendUrl = "http://${HostAddress}:${FrontendPort}"
  $backendUrl = "http://${HostAddress}:${BackendPort}"
  $frontend = Test-HttpOk $frontendUrl
  $backend = Test-BackendHealth "$backendUrl/api/health"
  $token = Read-AuthToken
  $agent = $null

  if ($token) {
    $agent = Test-HttpOk "$backendUrl/api/vm/agent/status" @{ Authorization = "Bearer $token" } "GET" $null 90
  }

  return @{
    frontendUrl = $frontendUrl
    backendUrl = $backendUrl
    frontend = $frontend
    backend = $backend
    agent = $agent
    frontendListening = Test-PortListening $FrontendPort
    backendListening = Test-PortListening $BackendPort
    processes = @(Get-WebDevProcesses)
  }
}

function Write-WebDevStatus($status) {
  Write-Section "HTTP"
  Write-Host "Frontend: $($status.frontendUrl) -> $(if ($status.frontend.ok) { "OK $($status.frontend.status)" } else { "FAIL $($status.frontend.error)" })"
  Write-Host "Backend:  $($status.backendUrl)/api/health -> $(if ($status.backend.ok) { "OK $($status.backend.status)" } else { "FAIL $($status.backend.error)" })"

  Write-Section "Ports"
  Write-Host "Frontend port ${FrontendPort}: $(if ($status.frontendListening) { "listening" } else { "not listening" })"
  Write-Host "Backend port ${BackendPort}:  $(if ($status.backendListening) { "listening" } else { "not listening" })"

  Write-Section "VM agent"
  if ($null -eq $status.agent) {
    Write-Host "Skipped: AUTH_TOKEN not found in .env"
  } elseif (-not $status.agent.ok) {
    Write-Host "FAIL $($status.agent.error)"
  } else {
    try {
      $payload = $status.agent.content | ConvertFrom-Json
      Write-Host "connected:     $($payload.connected)"
      Write-Host "workerRunning: $($payload.workerRunning)"
      Write-Host "workerPid:     $($payload.workerPid)"
      Write-Host "llmConfigured: $($payload.llmConfigured)"
    } catch {
      Write-Host $status.agent.content
    }
  }

  Write-Section "Processes"
  if ($status.processes.Count -eq 0) {
    Write-Host "No Sentaurus web dev process tree found."
  } else {
    $status.processes | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-Table -AutoSize
  }
}

function Start-WebDev {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outLog = Join-Path $logDir "web-dev-$stamp.out.log"
  $errLog = Join-Path $logDir "web-dev-$stamp.err.log"
  $apiBase = "http://${HostAddress}:${BackendPort}"
  $command = "Set-Location -LiteralPath '$projectRoot'; `$env:VITE_API_BASE='$apiBase'; npm run dev"

  $process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    $command
  ) -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

  Set-Content -LiteralPath $currentFile -Value @(
    "pid=$($process.Id)",
    "started=$(Get-Date -Format o)",
    "out=$outLog",
    "err=$errLog"
  )

  Write-Host "Started Sentaurus web dev process."
  Write-Host "PID: $($process.Id)"
  Write-Host "stdout: $outLog"
  Write-Host "stderr: $errLog"
}

function Stop-WebDev {
  $processes = @(Get-WebDevProcesses)
  $processIds = @($processes | ForEach-Object { $_.ProcessId })
  $processIds += @(Get-PortListenerProcessIds)
  $ids = $processIds | Sort-Object -Unique
  if ($ids.Count -eq 0) {
    Write-Host "No Sentaurus web dev processes found."
    return
  }

  foreach ($id in $ids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Stopped Sentaurus web dev processes: $($ids -join ', ')"
}

function Wait-WebDevReady {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  do {
    $status = Get-WebDevStatus
    if ($status.frontend.ok -and $status.backend.ok) {
      return $true
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  return $false
}

function Ensure-VmWorker {
  $token = Read-AuthToken
  if (-not $token) {
    Write-Host "AUTH_TOKEN not found; skipping VM worker ensure."
    return
  }

  $backendUrl = "http://${HostAddress}:${BackendPort}"
  $status = Test-HttpOk "$backendUrl/api/vm/agent/status" @{ Authorization = "Bearer $token" }
  if ($status.ok) {
    try {
      $payload = $status.content | ConvertFrom-Json
      if ($payload.connected -and $payload.workerRunning) {
        Write-Host "VM agent worker is already running."
        return
      }
    } catch {
      # Fall through to connect.
    }
  }

  Write-Host "Starting VM agent worker through backend..."
  $connect = Test-HttpOk "$backendUrl/api/vm/agent/connect" @{ Authorization = "Bearer $token" } "POST" "{}" 90
  if (-not $connect.ok) {
    Write-Host "VM agent connect failed: $($connect.error)"
    return
  }

  try {
    $payload = $connect.content | ConvertFrom-Json
    Write-Host "VM agent connect ok: workerRunning=$($payload.status.workerRunning), workerPid=$($payload.status.workerPid)"
  } catch {
    Write-Host $connect.content
  }
}

$status = Get-WebDevStatus

switch ($Mode) {
  "status" {
    Write-WebDevStatus $status
  }
  "start" {
    Start-WebDev
    if (Wait-WebDevReady) {
      Ensure-VmWorker
    } else {
      Write-Host "Web dev did not become ready within ${StartupTimeoutSeconds}s."
    }
    Write-WebDevStatus (Get-WebDevStatus)
  }
  "ensure" {
    if ($status.frontend.ok -and $status.backend.ok) {
      Write-Host "Web dev is already reachable."
    } else {
      Write-Host "Web dev is not healthy; starting it."
      Start-WebDev
      if (-not (Wait-WebDevReady)) {
        Write-Host "Web dev did not become ready within ${StartupTimeoutSeconds}s."
      }
    }
    Ensure-VmWorker
    Write-WebDevStatus (Get-WebDevStatus)
  }
  "stop" {
    Stop-WebDev
    Write-WebDevStatus (Get-WebDevStatus)
  }
}
