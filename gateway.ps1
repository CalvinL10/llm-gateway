param(
    [ValidateSet('start', 'status', 'stop', 'recover')]
    [string]$Action = 'start',
    [string]$HomePath = (Join-Path $PSScriptRoot '.local\dsh-agent-subscription-home')
)

# Daily operations only: do not install providers, copy credentials, authorize
# workspaces, launch a browser, or submit/replay model tasks here.
$ErrorActionPreference = 'Stop'
$lifecycle = Join-Path $PSScriptRoot 'integrations\dsh-agent-gateway\ops\lifecycle.mjs'
$scratch = Join-Path $PSScriptRoot '.local\plugin-portability-check'
if (!(Test-Path -LiteralPath (Join-Path $HomePath '.gateway-lifecycle\service.json'))) {
    throw 'This Home is not initialized. Follow docs/local-use.md; no configuration was changed.'
}
$null = Get-Command node -ErrorAction Stop
$null = New-Item -ItemType Directory -Path $scratch -Force
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
    # Child processes inherit F-drive scratch on this installation. Never change
    # machine/user environment settings or use the caller current directory.
    $env:TEMP = $scratch
    $env:TMP = $scratch
    if ($Action -eq 'start') {
        $rawStatus = & node $lifecycle status --home $HomePath
        if ($LASTEXITCODE -ne 0) { throw 'Lifecycle status failed; no start was attempted.' }
        $state = ($rawStatus -join "`n") | ConvertFrom-Json
        if ($state.status -eq 'running') {
            $rawStatus
        } elseif ($state.status -in @('stopped', 'degraded')) {
            # Lifecycle rechecks PID/port/lease under its lock; live or unknown
            # ownership is refused, never stopped by the start command.
            & node $lifecycle start --home $HomePath
            if ($LASTEXITCODE -ne 0) { throw 'Lifecycle start failed; inspect status before recovery.' }
        } else {
            throw 'Unknown lifecycle status; no start or recovery was attempted.'
        }
    } else {
        & node $lifecycle $Action --home $HomePath
        if ($LASTEXITCODE -ne 0) { throw "Lifecycle $Action failed; no fallback or replay was attempted." }
    }
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
}
