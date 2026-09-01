# scripts/deploy-supabase.ps1
#
# One command to push migrations and deploy the edge functions:
#
#   .\scripts\deploy-supabase.ps1
#   .\scripts\deploy-supabase.ps1 -Functions zoho-lead-sync   # just one
#   .\scripts\deploy-supabase.ps1 -DryRun                     # show, don't run
#
# One-time setup first:
#   npx supabase login
#   npx supabase link --project-ref auyfucbskylougsmmrks
#
# Secrets are deliberately NOT set here - they would end up in git. Use:
#   npx supabase secrets set NAME="value"
#
# ASCII only, on purpose: Windows PowerShell 5.1 reads a .ps1 without a BOM as
# ANSI, and non-ASCII characters break the parse.

# -DbUrl applies migrations over a plain Postgres connection, skipping the
# Management API. Use it when the account has database credentials but is not a
# member of the project's organization ("does not have the necessary privileges").
# Edge functions cannot be deployed this way - `functions deploy` has no --db-url
# and always goes through the Management API - so -DbUrl implies -SkipFunctions.

[CmdletBinding()]
param(
    [string[]] $Functions = @(),
    [string]   $DbUrl,
    [switch]   $DryRun,
    [switch]   $SkipMigrations,
    [switch]   $SkipFunctions
)

$ErrorActionPreference = 'Stop'
$ProjectRef = 'auyfucbskylougsmmrks'
$RepoRoot   = Split-Path -Parent $PSScriptRoot

function Invoke-Step {
    param([string] $Label, [string[]] $CliArgs)

    Write-Host ""
    Write-Host "-> $Label" -ForegroundColor Cyan
    Write-Host "   npx supabase $($CliArgs -join ' ')" -ForegroundColor DarkGray
    if ($DryRun) {
        Write-Host "   (dry run - skipped)" -ForegroundColor Yellow
        return
    }

    & npx --yes supabase@latest @CliArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed (exit $LASTEXITCODE)"
    }
}

Push-Location $RepoRoot
try {
    if (-not (Test-Path 'supabase/config.toml')) {
        throw 'supabase/config.toml not found - run this from the repo, not a subfolder.'
    }

    # ---- Direct-database mode ----------------------------------------------
    if ($DbUrl) {
        Write-Host ''
        Write-Host 'Direct database mode - migrations only, functions skipped.' -ForegroundColor Yellow

        # The CLI requires the password inside the URL to be percent-encoded, and
        # Supabase generates passwords containing & + / @ - all of which change the
        # meaning of a URL if passed raw. Encode it here so callers can paste the
        # password verbatim.
        if ($DbUrl -match '^(?<pre>postgres(?:ql)?://[^:/@]+:)(?<pw>.*)(?<post>@[^@]+)$') {
            $encoded = [uri]::EscapeDataString($Matches.pw)
            if ($encoded -ne $Matches.pw) {
                Write-Host '  (password percent-encoded for the connection string)' -ForegroundColor DarkGray
                $DbUrl = "$($Matches.pre)$encoded$($Matches.post)"
            }
        }

        Invoke-Step 'Push migrations (direct)' @('db', 'push', '--db-url', $DbUrl)

        Write-Host ''
        Write-Host 'Migrations applied.' -ForegroundColor Green
        Write-Host '  Edge functions still need an account with access to the project:' -ForegroundColor Yellow
        Write-Host '    npx supabase login   (as the account that owns the project)' -ForegroundColor DarkGray
        Write-Host ('    npx supabase functions deploy zoho-lead-sync --project-ref {0}' -f $ProjectRef) -ForegroundColor DarkGray
        return
    }

    # ---- Migrations --------------------------------------------------------
    if (-not $SkipMigrations) {
        # The five pre-CLI migrations were applied by hand in the SQL Editor, so
        # the remote has no history for them. Re-running create_invoices_table
        # would fail on "relation already exists" - it has no IF NOT EXISTS.
        # Marking them applied records the history without executing the SQL.
        Write-Host ""
        Write-Host "-> Migration status" -ForegroundColor Cyan
        $list = & npx --yes supabase@latest migration list 2>&1 | Out-String
        Write-Host $list

        $localOnly = [regex]::Matches($list, '(?m)^\s*(\d{14})\s*\|\s*\|') |
                     ForEach-Object { $_.Groups[1].Value } |
                     Where-Object { $_ -lt '20260901120000' }

        if ($localOnly.Count -gt 0) {
            Write-Host "   ! Untracked on remote: $($localOnly -join ', ')" -ForegroundColor Yellow
            Write-Host "     Marking them applied so db push does not re-run them." -ForegroundColor Yellow
            Invoke-Step 'Repair migration history' (@('migration', 'repair', '--status', 'applied') + $localOnly)
        }

        Invoke-Step 'Push migrations' @('db', 'push')
    }

    # ---- Edge functions ----------------------------------------------------
    if (-not $SkipFunctions) {
        if ($Functions.Count -eq 0) {
            $Functions = Get-ChildItem 'supabase/functions' -Directory |
                         Where-Object { Test-Path (Join-Path $_.FullName 'index.ts') } |
                         Select-Object -ExpandProperty Name
        }
        foreach ($fn in $Functions) {
            Invoke-Step "Deploy $fn" @('functions', 'deploy', $fn, '--project-ref', $ProjectRef)
        }
    }

    Write-Host ""
    Write-Host 'Done.' -ForegroundColor Green
    Write-Host '  Verify the Zoho scope with:' -ForegroundColor DarkGray
    Write-Host ('  curl.exe -H "x-check-scope: true" https://{0}.supabase.co/functions/v1/zoho-lead-sync' -f $ProjectRef) -ForegroundColor DarkGray
}
finally {
    Pop-Location
}
