// Minimal static file server for local development and e2e tests.
//   node tools/serve.mjs [port]
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const port = Number(process.argv[2] || process.env.PORT || 8642)

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".md": "text/plain; charset=utf-8",
}

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname)
    if (path.endsWith("/")) path += "index.html"
    const file = normalize(join(root, path))
    if (!file.startsWith(root)) throw Object.assign(new Error("forbidden"), { code: "EACCES" })
    const data = await readFile(file)
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    res.end(data)
  } catch (e) {
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" })
    res.end(e.code === "ENOENT" ? "not found" : "error")
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`TimeTravelJS dev server → http://127.0.0.1:${port}/`)
})
