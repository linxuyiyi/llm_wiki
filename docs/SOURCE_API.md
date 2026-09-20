# Source API

LLM Wiki exposes source-file management as a public HTTP and MCP capability. It is not tied to any external product.

## Runtime configuration

Enable **Settings → API + MCP → Enable local HTTP API** and configure an access token.

For LAN access, enable LAN access in Settings or set:

```powershell
$env:LLM_WIKI_BIND_HOST="0.0.0.0"
$env:LLM_WIKI_API_TOKEN="<token>"
```

Source write and delete operations always require a token, even when unauthenticated read access is enabled.

## Managed directory

The Source API is restricted to:

```text
raw/sources/**
```

The target project must currently be the active LLM Wiki project.

## Create or update a source

```http
PUT /api/v1/projects/{projectId}/sources/file
Authorization: Bearer <token>
Content-Type: application/json
```

Text:

```json
{
  "path": "自动化工程/AW调用规范.md",
  "content": "# AW调用规范\n..."
}
```

Binary:

```json
{
  "path": "规范/测试规范.pdf",
  "contentBase64": "JVBERi0x..."
}
```

Maximum decoded file size: 100 MB.

```bash
curl -X PUT \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:19828/api/v1/projects/current/sources/file \
  -d '{"path":"source-demo.md","content":"# Source demo\nSYNC_TEST=version-1"}'
```

## Delete a source

```http
DELETE /api/v1/projects/{projectId}/sources/file?path=自动化工程%2FAW调用规范.md
Authorization: Bearer <token>
```

```bash
curl -X DELETE \
  -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:19828/api/v1/projects/current/sources/file?path=source-demo.md"
```

## MCP

The bundled MCP server exposes the same source capability:

- `llm_wiki_write_source`: create or update a source with `content` or `content_base64`.
- `llm_wiki_delete_source`: delete a source by path.
- `llm_wiki_rescan_sources`: trigger Source Watch rescan explicitly.

Source write/delete MCP tools use the same API token and active-project restriction as the HTTP API.

## Behavior and safety

Each successful write or delete explicitly triggers the existing LLM Wiki source rescan. The existing file-watch, ingest queue, and delete-cleanup lifecycle remain responsible for knowledge processing.

The API rejects path traversal, absolute paths, hidden path segments, symlink escapes, invalid Windows filename characters, and reserved Windows names such as `NUL`, `CON`, `COM1`, and `LPT1`.
