param(
    [ValidateSet('setup', 'up', 'status', 'check', 'backup', 'public')]
    [string]$Action = 'status',
    [switch]$Interoperability
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location $root
try {
    $compose = @('compose', '--env-file', '.deployment/deploy.env', '-f', 'compose.deploy.yaml')
    if ($Interoperability) { $compose += @('-f', 'compose.fhir.deploy.yaml', '--profile', 'interoperability') }
    switch ($Action) {
        'setup' { & node scripts/deployment/setup.mjs }
        'up' { & docker @compose up -d --build --wait --wait-timeout 300 }
        'status' { & docker @compose ps -a }
        'check' { & node scripts/deployment/check.mjs }
        'public' {
            if (!(Test-Path '.deployment/secrets/tunnel_token')) {
                throw 'Save the dedicated CHS tunnel token in .deployment/secrets/tunnel_token first.'
            }
            & node scripts/deployment/check.mjs
            if ($LASTEXITCODE -ne 0) { throw 'Local deployment checks failed.' }
            & docker @compose -f compose.tunnel.yaml --profile public up -d cloudflared
        }
        'backup' {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $destination = Join-Path $root ".deployment/backups/$stamp"
            New-Item -ItemType Directory -Path $destination -Force | Out-Null
            $databases = @(
                @{Service='postgres'; User='chs'; Database='chs'},
                @{Service='identity-db'; User='keycloak'; Database='keycloak'}
            )
            if ($Interoperability) { $databases += @{Service='fhir-db'; User='fhir'; Database='hapi_fhir'} }
            foreach ($database in $databases) {
                $service = $database.Service
                & docker @compose exec -T $service pg_dump -U $database.User -d $database.Database -Fc -f /tmp/chs-backup.dump
                if ($LASTEXITCODE -ne 0) { throw "Backup failed: $service" }
                & docker @compose cp "${service}:/tmp/chs-backup.dump" "$destination/$service.dump"
                if ($LASTEXITCODE -ne 0) { throw "Backup copy failed: $service" }
            }
            Write-Host "Database and identity backups saved to $destination"
            Write-Host 'Preserve .deployment settings and secrets separately in encrypted storage.'
        }
    }
    if ($LASTEXITCODE -ne 0) { throw "CHS $Action failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
