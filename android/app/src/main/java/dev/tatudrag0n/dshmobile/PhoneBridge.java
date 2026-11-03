package dev.tatudrag0n.dshmobile;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The loopback bridge between the Host and the phone's platform APIs.
 *
 * The Host is a Node process; screenshots, gestures, typing and app launching
 * are Android APIs that only this app can call. The two therefore talk over a
 * plain HTTP endpoint bound to 127.0.0.1 on a random port, guarded by a random
 * bearer token that is written to `$DSH_HOME/bridge.json` - a file only this
 * app and the Host (same uid) can read. No part of it is reachable from
 * another app, and nothing leaves the device.
 *
 * Every response is JSON `{ok: true, ...}` or `{ok: false, error}`, so the
 * plugin can turn a platform refusal into a tool error that names the cause.
 */
final class PhoneBridge {

	private static final String TAG = "DshMobile";

	/** The largest request body accepted, in bytes. */
	private static final int MAX_BODY = 64 * 1024;

	/** How long a client may take to send its request. */
	private static final int READ_TIMEOUT_MS = 30000;

	private final Context context;
	private final SecureRandom random = new SecureRandom();
	private ServerSocket server;
	private Thread acceptor;
	private volatile boolean running;
	private int port = -1;
	private String token = "";

	/**
	 * @param context - the app context.
	 */
	PhoneBridge(Context context) {
		this.context = context.getApplicationContext();
	}

	/**
	 * Bind the bridge and start answering.
	 *
	 * @return the bound port.
	 * @throws IOException when no loopback port can be bound.
	 */
	int start() throws IOException {
		server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
		server.setReuseAddress(true);
		port = server.getLocalPort();
		token = newToken();
		running = true;
		acceptor = new Thread(this::acceptLoop, "phone-bridge");
		acceptor.setDaemon(true);
		acceptor.start();
		return port;
	}

	/**
	 * Stop answering and release the port.
	 */
	void stop() {
		running = false;
		try {
			if (server != null) server.close();
		} catch (IOException ignored) {
			// Closing is best effort.
		}
		server = null;
	}

	/**
	 * The bearer token the Host must send.
	 *
	 * @return the token.
	 */
	String token() {
		return token;
	}

	/**
	 * The bound port, or -1 before {@link #start}.
	 *
	 * @return the port.
	 */
	int port() {
		return port;
	}

	/**
	 * Generate a fresh token.
	 *
	 * @return 32 bytes of base64url-safe hex.
	 */
	private String newToken() {
		byte[] bytes = new byte[32];
		random.nextBytes(bytes);
		StringBuilder hex = new StringBuilder();
		for (byte value : bytes) hex.append(String.format(Locale.ROOT, "%02x", value));
		return hex.toString();
	}

	/**
	 * Accept connections until the bridge is stopped.
	 */
	private void acceptLoop() {
		while (running) {
			try {
				Socket socket = server.accept();
				Thread worker = new Thread(() -> handle(socket), "phone-bridge-conn");
				worker.setDaemon(true);
				worker.start();
			} catch (IOException failure) {
				if (running) Log.w(TAG, "bridge accept failed: " + failure.getMessage());
				return;
			}
		}
	}

	/**
	 * Answer one request.
	 *
	 * The request is read as bytes, not through a `Reader`: `content-length`
	 * counts bytes while a `Reader` counts characters, and a body with
	 * non-ASCII text (typing Japanese into a field) makes the two disagree -
	 * the reader then waits for characters that never arrive and the call
	 * times out.
	 *
	 * @param socket - the accepted connection.
	 */
	private void handle(Socket socket) {
		try (Socket connection = socket) {
			connection.setSoTimeout(READ_TIMEOUT_MS);
			try {
				InputStream input = connection.getInputStream();
				String request = readLine(input);
				if (request == null) return;
				String[] parts = request.split(" ");
				if (parts.length < 2) {
					write(connection, 400, error("不正なリクエストです"));
					return;
				}
				String method = parts[0];
				String path = parts[1].split("\\?")[0];

				int length = 0;
				String authorization = null;
				String line;
				while ((line = readLine(input)) != null && !line.isEmpty()) {
					int colon = line.indexOf(':');
					if (colon < 0) continue;
					String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
					String value = line.substring(colon + 1).trim();
					if (name.equals("content-length")) length = Integer.parseInt(value);
					if (name.equals("authorization")) authorization = value;
				}
				byte[] body = readBytes(input, Math.max(0, Math.min(length, MAX_BODY)));

				if (!authorized(authorization)) {
					write(connection, 401, error("ブリッジのトークンが違います"));
					return;
				}
				if (method.equals("GET") && path.equals("/health")) {
					JSONObject payload = new JSONObject();
					payload.put("ok", true);
					write(connection, 200, payload);
					return;
				}
				if (!method.equals("POST")) {
					write(connection, 405, error("POST のみ受け付けます"));
					return;
				}
				JSONObject arguments = body.length == 0
					? new JSONObject()
					: new JSONObject(new String(body, StandardCharsets.UTF_8));
				JSONObject answer = route(path, arguments);
				write(connection, 200, answer);
			} catch (Exception failure) {
				// The answer has to be written while the connection is still
				// open: the plugin turns a bridge error into the tool error the
				// model reads, so a silent close would hide the reason.
				Log.w(TAG, "bridge call failed: " + failure);
				try {
					write(connection, 500, error(String.valueOf(failure.getMessage())));
				} catch (IOException ignored) {
					// The client is already gone.
				}
			}
		} catch (IOException ignored) {
			// Accepting or closing the connection failed; nothing to answer.
		}
	}

	/**
	 * Read one CRLF-terminated line as ISO-8859-1.
	 *
	 * @param input - the connection stream.
	 * @return the line without its terminator, or null at end of stream.
	 * @throws IOException when reading fails.
	 */
	private static String readLine(InputStream input) throws IOException {
		ByteArrayOutputStream buffer = new ByteArrayOutputStream();
		int bite;
		while ((bite = input.read()) >= 0) {
			if (bite == '\n') {
				byte[] bytes = buffer.toByteArray();
				int end = bytes.length;
				if (end > 0 && bytes[end - 1] == '\r') end -= 1;
				return new String(bytes, 0, end, StandardCharsets.ISO_8859_1);
			}
			buffer.write(bite);
			if (buffer.size() > 8192) throw new IOException("ヘッダが長すぎます");
		}
		return buffer.size() == 0 ? null : buffer.toString("ISO-8859-1");
	}

	/**
	 * Read exactly a number of bytes.
	 *
	 * @param input - the connection stream.
	 * @param count - how many bytes the body declares.
	 * @return the bytes actually read.
	 * @throws IOException when reading fails.
	 */
	private static byte[] readBytes(InputStream input, int count) throws IOException {
		byte[] body = new byte[count];
		int offset = 0;
		while (offset < count) {
			int read = input.read(body, offset, count - offset);
			if (read < 0) break;
			offset += read;
		}
		return offset == count ? body : java.util.Arrays.copyOf(body, offset);
	}

	/**
	 * Whether a request carries the bridge token.
	 *
	 * @param authorization - the header value.
	 * @return the answer.
	 */
	private boolean authorized(String authorization) {
		if (authorization == null) return false;
		String expected = "Bearer " + token;
		return MessageDigest.isEqual(
			expected.getBytes(StandardCharsets.UTF_8),
			authorization.getBytes(StandardCharsets.UTF_8));
	}

	/**
	 * Dispatch one endpoint.
	 *
	 * @param path - the endpoint name.
	 * @param arguments - the JSON body.
	 * @return the response payload.
	 * @throws Exception when the platform call fails.
	 */
	private JSONObject route(String path, JSONObject arguments) throws Exception {
		JSONObject answer = new JSONObject();
		answer.put("ok", true);
		switch (path) {
			case "/status": {
				DisplayMetrics metrics = new DisplayMetrics();
				WindowManager window = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
				if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
					window.getCurrentWindowMetrics().getBounds();
					metrics = context.getResources().getDisplayMetrics();
					android.graphics.Rect bounds = window.getCurrentWindowMetrics().getBounds();
					answer.put("screenWidth", bounds.width());
					answer.put("screenHeight", bounds.height());
				} else {
					window.getDefaultDisplay().getRealMetrics(metrics);
					answer.put("screenWidth", metrics.widthPixels);
					answer.put("screenHeight", metrics.heightPixels);
				}
				answer.put("accessibility", PhoneUseService.isRunning());
				answer.put("android", Build.VERSION.RELEASE);
				answer.put("model", Build.MODEL);
				return answer;
			}
			case "/screen": {
				File directory = new File(context.getCacheDir(), "phone-shots");
				File target = new File(directory, "phone-" + System.currentTimeMillis() + ".png");
				PhoneUseService.Size size = PhoneUseService.screenshot(target);
				answer.put("path", target.getAbsolutePath());
				answer.put("width", size.width);
				answer.put("height", size.height);
				return answer;
			}
			case "/nodes": {
				int maxNodes = arguments.optInt("maxNodes", 120);
				PhoneUseService.Tree tree = PhoneUseService.dump(Math.max(1, Math.min(400, maxNodes)));
				answer.put("tree", tree.text);
				answer.put("count", tree.count);
				return answer;
			}
			case "/tap": {
				PhoneUseService.tap(arguments.getInt("x"), arguments.getInt("y"));
				return answer;
			}
			case "/swipe": {
				PhoneUseService.swipe(
					arguments.getInt("x1"), arguments.getInt("y1"),
					arguments.getInt("x2"), arguments.getInt("y2"),
					arguments.optInt("durationMs", 300));
				return answer;
			}
			case "/type": {
				String focused = PhoneUseService.type(arguments.optString("text", ""));
				answer.put("focused", focused);
				return answer;
			}
			case "/key": {
				String key = arguments.getString("key");
				if (key.equals("enter")) PhoneUseService.enter();
				else if (key.equals("delete")) PhoneUseService.backspace();
				else PhoneUseService.key(key);
				return answer;
			}
			case "/apps": {
				answer.put("apps", apps(arguments.optString("query", ""), arguments.optInt("limit", 60)));
				return answer;
			}
			case "/launch": {
				String packageName = arguments.getString("package");
				Intent launch = context.getPackageManager().getLaunchIntentForPackage(packageName);
				if (launch == null) throw new IllegalStateException("起動できないアプリです: " + packageName);
				launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
				context.startActivity(launch);
				answer.put("label", label(packageName));
				return answer;
			}
			default:
				throw new IllegalStateException("知らない操作です: " + path);
		}
	}

	/**
	 * List launchable apps.
	 *
	 * @param query - case-insensitive filter on label or package.
	 * @param limit - maximum rows.
	 * @return a JSON array of `{label, package}`.
	 */
	private JSONArray apps(String query, int limit) {
		PackageManager packages = context.getPackageManager();
		Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
		List<ResolveInfo> resolved = packages.queryIntentActivities(intent, 0);
		String needle = query.toLowerCase(Locale.ROOT);
		List<JSONObject> rows = new ArrayList<>();
		for (ResolveInfo info : resolved) {
			String packageName = info.activityInfo.packageName;
			String name = String.valueOf(info.loadLabel(packages));
			if (!needle.isEmpty()
				&& !name.toLowerCase(Locale.ROOT).contains(needle)
				&& !packageName.toLowerCase(Locale.ROOT).contains(needle)) {
				continue;
			}
			JSONObject row = new JSONObject();
			try {
				row.put("label", name);
				row.put("package", packageName);
			} catch (Exception ignored) {
				continue;
			}
			rows.add(row);
			if (rows.size() >= Math.max(1, Math.min(200, limit))) break;
		}
		JSONArray array = new JSONArray();
		for (JSONObject row : rows) array.put(row);
		return array;
	}

	/**
	 * The user-visible name of a package.
	 *
	 * @param packageName - the package.
	 * @return its label, or the package id when unknown.
	 */
	private String label(String packageName) {
		try {
			PackageManager packages = context.getPackageManager();
			return String.valueOf(packages.getApplicationLabel(packages.getApplicationInfo(packageName, 0)));
		} catch (Exception missing) {
			return packageName;
		}
	}

	/**
	 * Write a JSON response.
	 *
	 * @param socket - the connection.
	 * @param status - the HTTP status.
	 * @param payload - the body.
	 * @throws IOException when the client is gone.
	 */
	private static void write(Socket socket, int status, JSONObject payload) throws IOException {
		byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
		OutputStream output = socket.getOutputStream();
		String header = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
			+ "content-type: application/json; charset=utf-8\r\n"
			+ "content-length: " + body.length + "\r\n"
			+ "connection: close\r\n\r\n";
		output.write(header.getBytes(StandardCharsets.UTF_8));
		output.write(body);
		output.flush();
	}

	/**
	 * Build a failure payload.
	 *
	 * @param message - what went wrong.
	 * @return the payload.
	 */
	private static JSONObject error(String message) {
		JSONObject payload = new JSONObject();
		try {
			payload.put("ok", false);
			payload.put("error", message);
		} catch (Exception impossible) {
			// JSONObject only throws on non-finite numbers.
		}
		return payload;
	}

	/**
	 * A reason phrase for a status code.
	 *
	 * @param status - the code.
	 * @return the phrase.
	 */
	private static String reason(int status) {
		switch (status) {
			case 200: return "OK";
			case 400: return "Bad Request";
			case 401: return "Unauthorized";
			case 405: return "Method Not Allowed";
			default: return "Internal Server Error";
		}
	}
}

