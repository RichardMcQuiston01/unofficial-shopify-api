<#
.SYNOPSIS
  Gets a 24-hour Admin API token with Shopify's client credentials grant and
  runs the library's read-only live check.

.DESCRIPTION
  For Dev Dashboard apps installed on a store in your own organization.
  Sets SHOPIFY_SHOP, SHOPIFY_API_VERSION and SHOPIFY_ADMIN_TOKEN for this
  PowerShell session, and saves the token to .shopify-token in the project
  root (git-ignored) so the live checks can find it from any terminal. Use
  -NoSaveToken to skip the file. The token is never printed.

.EXAMPLE
  .\get-shopify-token.ps1 -Shop your-dev-store -ClientId abc123
  (you are prompted for the client secret)
#>
param(
  [Parameter(Mandatory = $true)][string]$Shop,
  [Parameter(Mandatory = $true)][string]$ClientId,
  [string]$ApiVersion = "2026-10",
  [switch]$SkipLiveCheck,
  [switch]$NoSaveToken
)

$ErrorActionPreference = "Stop"

# Accept "example" or "example.myshopify.com".
[string]$shopHost = $Shop.Trim().ToLower() -replace "^https://", "" -replace "/.*$", ""
if (-not $shopHost.Contains(".")) { $shopHost = "$shopHost.myshopify.com" }
if ($shopHost -notmatch "^[a-z0-9][a-z0-9-]*\.myshopify\.com$") {
  throw "Invalid shop '$Shop': use a name like 'example' or 'example.myshopify.com' (not a custom domain)."
}

# Read the secret without echoing it, and keep it out of the command line history.
[System.Security.SecureString]$secureSecret = Read-Host -Prompt "Client secret" -AsSecureString
[string]$clientSecret = [System.Net.NetworkCredential]::new("", $secureSecret).Password
if ([string]::IsNullOrWhiteSpace($clientSecret)) {
  throw "The client secret was empty. Copy it from Dev Dashboard > your app > Settings."
}

[string]$uri = "https://$shopHost/admin/oauth/access_token"
try {
  $response = Invoke-RestMethod -Method Post -Uri $uri -Body @{
    client_id     = $ClientId
    client_secret = $clientSecret
    grant_type    = "client_credentials"
  }
}
catch {
  [string]$status = ""
  if ($_.Exception.Response) { $status = " (HTTP $([int]$_.Exception.Response.StatusCode))" }
  throw "Shopify refused the token request to $uri$status. Check that the app is installed on this store, the client ID and secret are right, and scopes are released on the app version. Details: $($_.Exception.Message)"
}
finally {
  $clientSecret = $null
}

if ([string]::IsNullOrWhiteSpace($response.access_token)) {
  throw "Shopify answered, but the response had no access_token."
}

$env:SHOPIFY_SHOP = $shopHost
$env:SHOPIFY_API_VERSION = $ApiVersion
$env:SHOPIFY_ADMIN_TOKEN = $response.access_token

Write-Host "Token received for $shopHost. Expires in $($response.expires_in) seconds."
Write-Host "Granted scopes: $($response.scope)"
if ($response.scope -notmatch "read_products|write_products") {
  Write-Warning "neither read_products nor write_products was granted; the pagination and bulk checks will fail. Release it on the app version and request again."
}

if (-not $NoSaveToken) {
  [string]$tokenPath = Join-Path (Split-Path -Parent $PSScriptRoot) ".shopify-token"
  Set-Content -Path $tokenPath -Value $response.access_token -NoNewline -Encoding ascii
  Write-Host "Saved the token to $tokenPath (git-ignored; expires in 24 hours)."
}

if (-not $SkipLiveCheck) {
  npm run live-check
  exit $LASTEXITCODE
}
