#!/usr/bin/env node
// Serve tiny images for manual tests: node tests/img-server.mjs [port]
// Fixture HTML uses http://127.0.0.1:__PORT__/img/...; set WXMP_MOCK_PORT to the same port.
import http from "node:http";

const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d4944415478da63f8cfc0f01f0005000201e2214bcf0000000049454e44ae426082", "hex");
const port = Number(process.argv[2] || 0);
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/img/")) {
    res.writeHead(200, { "content-type": req.url.includes(".jpg") ? "image/jpeg" : "image/png" });
    res.end(png);
  } else {
    res.writeHead(404);
    res.end();
  }
});
srv.listen(port, "127.0.0.1", () => console.log(`image server on 127.0.0.1:${srv.address().port}`));
