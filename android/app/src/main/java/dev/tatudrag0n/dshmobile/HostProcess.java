package dev.tatudrag0n.dshmobile;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The Node process that *is* the DSH Host on this phone.
 *
 * The app does not reimplement the harness; it runs the same `dsh` package the
 * desktop app ships, against a Node binary built for Android. Everything the
 * process needs is passed through its environment, so the launcher keeps no
 * hidden state: the runtime root, the harness home, the workspace (its working
 * directory), the loopback port, and the plugin/bridge paths the mobile profile
 * refers to.
 *
 * The launch URL - including the one-time token - is printed by the Host on
 * stdout, so this class tails that stream: it is both the readiness signal and
 * the diagnostic log.
 */
final class HostProcess {

	private static final String TAG = "DshMobile";

	/** Matches the URL `dsh web` prints once the server is listening. */
	private static final Pattern URL_LINE =
		Pattern.compile("dsh web:\\s*(http://\\S+)");

	/** How much of the Host's output is kept in the log file. */
	private static final long LOG_LIMIT_BYTES = 2L * 1024 * 1024;

	/** What the launcher wants to know about the Host. */
	interface Listener {
		/**
		 * The server is listening.
		 *
		 * @param url - the launch URL, token included.
		 */
		void onUrl(String url);

		/**
		 * One line of Host output.
		 *
		 * @param line - the line.
		 */
		void onLine(String line);

		/**
		 * The process ended.
		 *
		 * @param code - its exit status.
		 */
		void onExit(int code);
	}

	private final Context context;
	private final Listener listener;
	private Process process;
	private Thread pump;
	private volatile boolean stopped;

	/**
	 * @param context - any context.
	 * @param listener - the readiness and log sink.
	 */
	HostProcess(Context context, Listener listener) {
		this.context = context.getApplicationContext();
		this.listener = listener;
	}

	/**
	 * Pick a free loopback port.
	 *
	 * @return the port.
	 * @throws IOException when no port can be bound.
	 */
	static int freePort() throws IOException {
		try (ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
			socket.setReuseAddress(true);
			return socket.getLocalPort();
		}
	}

	/**
	 * Start the Host.
	 *
	 * @param port - the loopback port to listen on.
	 * @throws IOException when the runtime is incomplete or the process cannot start.
	 */
	void start(int port) throws IOException {
		if (!RuntimeStore.isInstalled(context)) {
			throw new IOException("ランタイムが入っていません");
		}
		File runtime = RuntimeStore.runtimeDir(context);
		File home = RuntimeStore.homeDir(context);
		File workspace = RuntimeStore.workspaceDir(context);
		File log = new File(RuntimeStore.logDir(context), "host.log");
		if (log.length() > LOG_LIMIT_BYTES) {
			File rotated = new File(log.getParentFile(), "host.previous.log");
			RuntimeStore.deleteTree(rotated);
			if (!log.renameTo(rotated)) Log.w(TAG, "cannot rotate " + log);
		}

		List<String> command = new ArrayList<>();
		command.add(new File(runtime, "bin/node").getAbsolutePath());
		// DSH reaches into Node's own module loader to patch it. The upstream
		// binding for that is native and has no Android build, so this runtime
		// ships a JS stand-in and starts Node with internals exposed.
		command.add("--expose-internals");
		command.add(RuntimeStore.dshEntry(context).getAbsolutePath());
		command.add("mobile");
		command.add("--no-open");
		command.add("--host");
		command.add("127.0.0.1");
		command.add("--port");
		command.add(Integer.toString(port));

		ProcessBuilder builder = new ProcessBuilder(command);
		builder.directory(workspace);
		builder.redirectErrorStream(true);
		Map<String, String> environment = builder.environment();
		environment.put("OPENSSL_CONF", "/dev/null");
		environment.put("LD_LIBRARY_PATH", RuntimeStore.libDir(context).getAbsolutePath());
		environment.put("PATH", new File(runtime, "bin").getAbsolutePath() + ":/system/bin:/system/xbin");
		environment.put("SHELL", new File(runtime, "bin/bash").getAbsolutePath());
		environment.put("HOME", home.getAbsolutePath());
		environment.put("DSH_HOME", home.getAbsolutePath());
		environment.put("TMPDIR", new File(home, "tmp").getAbsolutePath());
		environment.put("DSH_MOBILE_PLUGINS", new File(runtime, "plugins").getAbsolutePath());
		environment.put("DSH_MOBILE_PORT", Integer.toString(port));
		environment.put("DSH_MOBILE_BRIDGE", new File(home, "bridge.json").getAbsolutePath());
		// The profile's bundles are resolved from the profile directory; this
		// is the fallback when the app could not create the node_modules link.
		environment.put("NODE_PATH", new File(runtime, "app/node_modules").getAbsolutePath());
		environment.put("TERM", "xterm-256color");

		process = builder.start();
		pump = new Thread(() -> pumpLogs(log), "dsh-host-log");
		pump.setDaemon(true);
		pump.start();
	}

	/**
	 * Whether the Host process is alive.
	 *
	 * @return the answer.
	 */
	boolean isRunning() {
		Process current = process;
		return current != null && current.isAlive();
	}

	/**
	 * Stop the Host, waiting briefly for a clean exit.
	 */
	void stop() {
		stopped = true;
		Process current = process;
		if (current == null) return;
		current.destroy();
		try {
			if (!current.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) current.destroyForcibly();
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
			current.destroyForcibly();
		}
		process = null;
	}

	/**
	 * Copy the Host's output into the log file, reporting the launch URL the
	 * first time it appears.
	 *
	 * @param log - the log file to append to.
	 */
	private void pumpLogs(File log) {
		Process current = process;
		if (current == null) return;
		try (BufferedReader reader = new BufferedReader(
			new InputStreamReader(current.getInputStream(), StandardCharsets.UTF_8));
			FileOutputStream output = new FileOutputStream(log, true)) {
			String line;
			while ((line = reader.readLine()) != null) {
				output.write((line + "\n").getBytes(StandardCharsets.UTF_8));
				output.flush();
				Matcher match = URL_LINE.matcher(line);
				if (match.find()) listener.onUrl(match.group(1));
				else listener.onLine(line);
			}
		} catch (IOException failure) {
			if (!stopped) Log.w(TAG, "host log pump ended: " + failure.getMessage());
		}
		int code = -1;
		try {
			code = current.waitFor();
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
		}
		if (!stopped) listener.onExit(code);
	}
}
