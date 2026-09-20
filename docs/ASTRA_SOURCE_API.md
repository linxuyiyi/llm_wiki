# Astra Source API

LLM Wiki 0.6.11 extension for synchronizing Astra Digital Library sources into the active LLM Wiki project.

## Runtime configuration

Enable the HTTP API in **Settings → API + MCP** and configure a token. For LAN access, enable LAN access in settings or set:

```powershell
$env:LLM_WIKI_BIND_HOST="0.0.0.0"
$env:LLM_WIKI_API_TOKEN="<token>"
```

Astra source writes are always token-protected, even when unauthenticated read access is enabled.

## Managed directory

Astra can only mutate files below:

```text
raw/sources/astra/**
```

The first version requires the target project to be the currently active LLM Wiki project.

## Create or update a source

```http
PUT /api/v1/projects/{projectId}/sources/file
Authorization: Bearer <token>
Content-Type: application/json
```

Text body:

```json
{
  "path": "自动化工程/AW调用规范.md",
  "content": "# AW调用规范\n..."
}
```

Binary files use Base64:

```json
{
  "path": "规范/测试规范.pdf",
  "contentBase64": "JVBERi0x..."
}
```

Maximum decoded file size: 100 MB.

## Delete a source

```http
DELETE /api/v1/projects/{projectId}/sources/file?path=自动化工程%2FAW调用规范.md
Authorization: Bearer <token>
```

## Behavior

Each successful write or delete explicitly triggers the existing LLM Wiki source rescan. The original file-watch, ingest queue, and delete-cleanup lifecycle remain responsible for processing knowledge changes.

The API rejects path traversal, absolute paths, hidden path segments, symlink escapes, invalid Windows filename characters, and reserved Windows names such as `NUL`, `CON`, `COM1`, and `LPT1`.
