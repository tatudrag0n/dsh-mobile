/** Read a small public request with an absolute deadline and a concurrency cap. */
let active = 0;
export function readBody(request, { maxBytes = 1024, timeoutMs = 5000, maxActive = 32 } = {}) {
	const fail = (status, message) => Object.assign(new Error(message), { status });
	if (active >= maxActive) return Promise.reject(fail(503, "busy"));
	const declared = Number(request.headers?.["content-length"] ?? 0);
	if (!Number.isSafeInteger(declared) || declared < 0) return Promise.reject(fail(400, "invalid-length"));
	if (declared > maxBytes) return Promise.reject(fail(413, "body-too-large"));
	active += 1;
	return new Promise((resolve, reject) => {
		const chunks = [];
		let bytes = 0;
		const finish = (error) => {
			clearTimeout(timer);
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			request.off("aborted", onAbort);
			active -= 1;
			if (error) {
				// An aborted IncomingMessage may emit ECONNRESET after 'aborted'.
				request.once("error", () => {});
				request.pause(); reject(error);
			}
			else resolve(Buffer.concat(chunks).toString("utf8"));
		};
		const onData = (chunk) => {
			const buffer = Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > maxBytes) finish(fail(413, "body-too-large"));
			else chunks.push(buffer);
		};
		const onEnd = () => finish();
		const onError = () => finish(fail(400, "body-error"));
		const onAbort = () => finish(fail(400, "body-aborted"));
		const timer = setTimeout(() => finish(fail(408, "body-timeout")), timeoutMs);
		request.on("data", onData).once("end", onEnd).once("error", onError).once("aborted", onAbort);
	});
}
