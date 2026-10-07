# Omnisearch MCP

Expose [Omnisearch](https://github.com/scambier/obsidian-omnisearch) as an MCP search tool through the built-in MCP server provided by [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

The plugin lets an MCP-compatible agent search the current Obsidian vault using Omnisearch ranking, matching, and excerpts. It can also return indexed content from supported attachments, such as PDFs, when an appropriate text-extraction plugin is installed and configured.

## Features

- Adds an `omnisearch_search` tool to the Local REST API MCP endpoint
- Searches the current Obsidian vault through Omnisearch
- Returns ranked search results
- Returns vault-relative file paths
- Returns matched words and match positions
- Returns contextual excerpts
- Can include indexed PDF and document content when text extraction is available
- Uses the authentication and HTTPS configuration already provided by Local REST API
- Requires no additional standalone MCP server

## Architecture

```text
MCP-compatible agent
        |
        | MCP over HTTPS
        v
Obsidian Local REST API
        |
        | Extension API
        v
Omnisearch MCP
        |
        | omnisearch.api.search(query)
        v
Obsidian Omnisearch index
```

The plugin does not implement its own search engine. It calls the public Omnisearch API inside Obsidian:

```js
await app.plugins.plugins["omnisearch"].api.search(query)
```

## Requirements

Install and enable the following Obsidian Community Plugins:

1. **Omnisearch**
2. **Local REST API**, version 5.3.0 or newer
3. **Text Extractor**, optional, for indexing supported PDFs, Office documents, and other attachments

Additional requirements for building from source:

- Node.js 22 or a compatible version required by the Local REST API sample extension toolchain
- npm
- Git, if cloning the project

## MCP Tool

### Tool name

```text
omnisearch_search
```

### Purpose

Search the current Obsidian vault using Omnisearch and return ranked paths, matches, scores, and excerpts.

### Input

```json
{
  "query": "copyright hyperlink"
}
```

### Example output

```json
{
  "query": "123",
  "count": 2,
  "results": [
    {
      "score": 4.13,
      "vault": "Research",
      "path": "Notes/test1.md",
      "basename": "test1",
      "foundWords": ["123"],
      "matches": [
        {
          "match": "123",
          "offset": 26
        }
      ],
      "excerpt": "123<br>456"
    }
  ]
}
```

The exact result fields are determined by the installed Omnisearch version.

## Install a Prebuilt Release

A prebuilt installation does not require Node.js or npm on the destination computer.

### 1. Prepare the plugin folder

The release folder should contain:

```text
omnisearch-mcp/
├── main.js
├── manifest.json
└── styles.css
```

`styles.css` may be empty, but it can remain in the package.

### 2. Copy the folder into the target vault

Copy `omnisearch-mcp` into:

```text
YOUR-VAULT/.obsidian/plugins/
```

The final structure must be:

```text
YOUR-VAULT/
└── .obsidian/
    └── plugins/
        └── omnisearch-mcp/
            ├── main.js
            ├── manifest.json
            └── styles.css
```

Do not create an extra nested directory such as:

```text
.obsidian/plugins/omnisearch-mcp/omnisearch-mcp/main.js
```

### 3. Install the dependencies in Obsidian

On the destination computer, install and enable:

- Omnisearch
- Local REST API
- Text Extractor, if attachment indexing is needed

### 4. Reload Obsidian

Restart Obsidian or press:

```text
Ctrl+R
```

Then go to:

```text
Settings > Community plugins
```

Enable **Omnisearch MCP**.

## Build from Source

### 1. Place the source project in the vault

The project directory should be:

```text
YOUR-VAULT/.obsidian/plugins/omnisearch-mcp/
```

### 2. Install dependencies

In PowerShell:

```powershell
cd "YOUR-VAULT-PATH\.obsidian\plugins\omnisearch-mcp"
npm.cmd install
```

Using `npm.cmd` avoids the common PowerShell error in which execution policy blocks `npm.ps1`.

### 3. Build the plugin

```powershell
npm.cmd run build
```

Confirm that the build produced `main.js`:

```powershell
Get-ChildItem .\main.js, .\manifest.json
```

Confirm that the compiled file contains the MCP tool name:

```powershell
Select-String -Path .\main.js -Pattern "omnisearch_search"
```

### 4. Reload and enable the plugin

Restart Obsidian or press `Ctrl+R`, then enable **Omnisearch MCP** under Community plugins.

## Manifest

The plugin directory name and manifest ID must match:

```json
{
  "id": "omnisearch-mcp",
  "name": "Omnisearch MCP",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "description": "Exposes Omnisearch as an MCP tool through Local REST API.",
  "author": "Your Name",
  "isDesktopOnly": true
}
```

Directory name:

```text
omnisearch-mcp
```

Manifest ID:

```text
omnisearch-mcp
```

## Local MCP Connection

Local REST API normally exposes its MCP server at:

```text
https://127.0.0.1:27124/mcp/
```

Authentication is handled by Local REST API, not by Omnisearch MCP. The MCP client must supply the Local REST API bearer token at connection time:

```http
Authorization: Bearer <LOCAL_REST_API_KEY>
```

`<LOCAL_REST_API_KEY>` is a placeholder. Never replace it with a real key in this README, source code, `manifest.json`, `main.js`, screenshots, Git commits, or release archives.

Each computer has its own Local REST API configuration and API key. Configure the key only in the MCP client, connector, secret store, environment variable, or tunnel configuration used on that computer.

Omnisearch MCP does not request, read, log, store, transmit, or embed the Local REST API key. Local REST API authenticates the request before invoking the `omnisearch_search` tool.

After installing or updating this plugin, disconnect and reconnect the MCP client so it retrieves the updated tool list.

## Remote Agent Connection

A cloud-based agent cannot normally connect directly to `127.0.0.1`. To connect a remote agent, expose the Local REST API MCP endpoint through a secure HTTPS tunnel or another protected reverse proxy.

The resulting route should forward to:

```text
https://127.0.0.1:27124/mcp/
```

Retain bearer-token authentication. Store the token only in your MCP client's protected connection or secret configuration. Never place it in source control, plugin files, build scripts, screenshots, logs, documentation, or tunnel URLs.

## Verify the Installation

Open Obsidian Developer Tools with:

```text
Ctrl+Shift+I
```

In the Console, verify that all required plugins are enabled:

```js
({
  omnisearch: app.plugins.enabledPlugins.has("omnisearch"),
  localRestApi: app.plugins.enabledPlugins.has("obsidian-local-rest-api"),
  omnisearchMcp: app.plugins.enabledPlugins.has("omnisearch-mcp")
})
```

Expected result:

```js
{
  omnisearch: true,
  localRestApi: true,
  omnisearchMcp: true
}
```

Verify that the plugin instance exists:

```js
app.plugins.plugins["omnisearch-mcp"]
```

It should return a plugin object rather than `undefined`.

## Test Omnisearch Directly

Before troubleshooting MCP, confirm that Omnisearch itself returns results:

```js
await app.plugins.plugins["omnisearch"].api.search("known text")
```

Replace `known text` with a distinctive word that definitely appears in an indexed note.

Do not call the internal search engine with a string:

```js
app.plugins.plugins["omnisearch"].searchEngine.search("known text")
```

That internal method expects Omnisearch's parsed query object and may produce:

```text
TypeError: t.isEmpty is not a function
```

Always use the public API:

```js
app.plugins.plugins["omnisearch"].api.search("known text")
```

## Test Through an MCP Client

After reconnecting the MCP client, verify that the tool list includes:

```text
omnisearch_search
```

Invoke it with:

```json
{
  "query": "known text"
}
```

A natural-language agent request can be:

```text
Use omnisearch_search to search my Obsidian vault for "known text".
```

## Troubleshooting

### The plugin does not appear in Community plugins

Check that these files are directly inside the plugin directory:

```text
.obsidian/plugins/omnisearch-mcp/main.js
.obsidian/plugins/omnisearch-mcp/manifest.json
```

Also verify that the folder name matches the `id` in `manifest.json`.

### The plugin appears but cannot be enabled

Open the Developer Console and look for:

```text
Failed to load plugin omnisearch-mcp
```

Rebuild the plugin:

```powershell
npm.cmd run build
```

Then reload Obsidian.

### `npm.ps1` is blocked by PowerShell

Use the Windows command wrapper:

```powershell
npm.cmd install
npm.cmd run build
```

This avoids changing the PowerShell execution policy.

### Omnisearch returns an empty array

An empty array means the call worked but no indexed result matched the query.

Try a distinctive word from a known note:

```js
await app.plugins.plugins["omnisearch"].api.search("distinctive-word")
```

Refresh the Omnisearch index if necessary:

```js
await app.plugins.plugins["omnisearch"].api.refreshIndex()
```

Wait for indexing to finish, then search again.

### The MCP client cannot see `omnisearch_search`

1. Confirm that Omnisearch, Local REST API, and Omnisearch MCP are enabled.
2. Confirm that `main.js` contains `omnisearch_search`.
3. Reload Obsidian.
4. Disconnect and reconnect the MCP client.
5. Verify that the client is connected to the correct computer and vault.
6. Verify that the Local REST API version supports MCP extension tools.

### Markdown works but PDFs do not appear

Install and enable Text Extractor or another integration supported by Omnisearch. Wait for extraction and indexing to finish, then refresh the Omnisearch index.

### The public MCP URL works on one computer but not another

The HTTPS tunnel runs on a specific computer. Installing the plugin on a second computer does not transfer or redirect the original tunnel.

Configure a tunnel or reverse proxy on the second computer and forward it to that computer's Local REST API MCP endpoint.

## Updating the Plugin

On the development computer:

```powershell
npm.cmd run build
```

Copy the updated files to the destination computer:

```text
main.js
manifest.json
styles.css
```

Replace the old files, reload Obsidian, and reconnect the MCP client.

Increment the version in `manifest.json` for each distributed release.

## API Key and Secret Handling

Omnisearch MCP does **not** need an API key in its source code or settings. Authentication belongs to Local REST API and the connecting MCP client.

Never put a real API key in any distributed plugin file, including:

```text
README.md
main.js
manifest.json
styles.css
src/*.ts
package.json
package-lock.json
.env files included in a release
```

Use placeholders in documentation:

```text
<LOCAL_REST_API_KEY>
```

If local development requires an environment file, keep it outside the release archive and add it to `.gitignore`:

```gitignore
.env
.env.*
!.env.example
*.key
*.pem
*.pfx
*.p12
secrets.json
```

Before publishing a release, scan the project for likely secrets in PowerShell:

```powershell
Get-ChildItem -Recurse -File |
  Where-Object { $_.FullName -notmatch "node_modules|\.git" } |
  Select-String -Pattern "Bearer\s+[A-Za-z0-9._~-]+|api[_-]?key|secret|token" -CaseSensitive:$false
```

Review every match. Expected matches may include placeholder names and documentation, but no real credential should appear.

You can also confirm that the built plugin contains no bearer token:

```powershell
Select-String -Path .\main.js -Pattern "Bearer\s+|api[_-]?key|secret|token" -CaseSensitive:$false
```

The plugin's intended data flow is:

```text
MCP client stores the key
        |
        | Authorization header
        v
Local REST API authenticates the request
        |
        | invokes an already-authorized MCP tool
        v
Omnisearch MCP calls Omnisearch locally
```

The plugin must never log request headers or authentication data.

## Security

- Keep the Local REST API key only in the MCP client's protected connection or secret store.
- Do not commit keys, tokens, certificates, or tunnel credentials to Git.
- Do not embed credentials in `main.js`, `manifest.json`, source files, documentation, or release archives.
- Do not place a bearer token in a URL or query string.
- Do not expose the MCP endpoint publicly without authentication.
- Prefer a secured HTTPS tunnel or authenticated reverse proxy.
- Rotate the Local REST API key immediately if it is exposed.
- Remember that an authorized MCP client can search information indexed from the vault, including extracted attachment content.
- Review search excerpts before sending them to external AI services if the vault contains confidential material.

## Privacy

Search runs inside Obsidian against the local Omnisearch index. However, returned paths, excerpts, and metadata are sent to whichever MCP client invokes the tool. The privacy behavior therefore depends on the connected MCP client and agent platform.

## Development Notes

The plugin uses the Local REST API extension API to register the MCP tool. Its core operation is equivalent to:

```ts
const omnisearch = plugins["omnisearch"];
const results = await omnisearch.api.search(query);
```

The MCP tool is read-only and idempotent. It does not create, edit, rename, or delete vault files.

## License

Add the license selected for your distribution, for example MIT:

```text
MIT License
```

If this project contains code copied or adapted from another repository, retain the notices and attribution required by that project's license.

## Acknowledgements

- Obsidian
- Omnisearch
- Obsidian Local REST API
- Obsidian Local REST API Sample API Extension
- Text Extractor
