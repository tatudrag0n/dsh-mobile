// A stand-in host that answers every request with 401, so the phone app can be
// checked against an expired session without touching the real one.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3080);

createServer((request, response) => {
	if (request.url === "/mobile") {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<!doctype html><meta charset=utf-8><title>pairing</title><h1>pairing page</h1>");
		return;
	}
	response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
	response.end("401 unauthorized");
}).listen(port, "192.168.0.166", () => {
	console.log(`fake host on 192.168.0.166:${port}`);
});
