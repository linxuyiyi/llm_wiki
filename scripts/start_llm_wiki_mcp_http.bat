@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not defined LLM_WIKI_MCP_HOST set "LLM_WIKI_MCP_HOST=127.0.0.1"
if not defined LLM_WIKI_MCP_PORT set "LLM_WIKI_MCP_PORT=19898"
if not defined LLM_WIKI_MCP_PATH set "LLM_WIKI_MCP_PATH=/mcp"

set "MCP_ENTRY=%~dp0mcp-server\dist\src\index.js"
if not exist "%MCP_ENTRY%" set "MCP_ENTRY=%~dp0..\mcp-server\dist\src\index.js"

if not exist "%MCP_ENTRY%" (
  echo [ERROR] LLM Wiki MCP server entry not found.
  echo         Expected: mcp-server\dist\src\index.js
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe was not found in PATH. Install Node.js 20 or newer.
  exit /b 1
)

echo ============================================================
echo   LLM Wiki HTTP MCP
echo ============================================================
echo.
echo MCP entry : %MCP_ENTRY%
echo Listen    : %LLM_WIKI_MCP_HOST%:%LLM_WIKI_MCP_PORT%
echo MCP path  : %LLM_WIKI_MCP_PATH%
echo Health    : http://127.0.0.1:%LLM_WIKI_MCP_PORT%/health
echo Local MCP : http://127.0.0.1:%LLM_WIKI_MCP_PORT%%LLM_WIKI_MCP_PATH%

if /I "%LLM_WIKI_MCP_HOST%"=="0.0.0.0" (
  echo.
  echo [INFO] LAN binding enabled. Detecting IPv4 addresses...
  powershell -NoProfile -Command "$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue ^| Where-Object { -not $_.IPAddress.StartsWith('127.') -and $_.AddressState -eq 'Preferred' } ^| Select-Object -ExpandProperty IPAddress -Unique; if ($ips) { $ips ^| ForEach-Object { Write-Host ('LAN MCP   : http://' + $_ + ':%LLM_WIKI_MCP_PORT%%LLM_WIKI_MCP_PATH%') } } else { Write-Host '[WARN] No usable LAN IPv4 address detected.' }"
  if not defined LLM_WIKI_MCP_AUTH_TOKEN (
    echo [WARN] LLM_WIKI_MCP_AUTH_TOKEN is not set. LAN clients can reach MCP without transport-level authentication.
  )
)

echo.
echo Press Ctrl+C to stop.
echo.
node "%MCP_ENTRY%" --transport http --host "%LLM_WIKI_MCP_HOST%" --port "%LLM_WIKI_MCP_PORT%" --path "%LLM_WIKI_MCP_PATH%"
