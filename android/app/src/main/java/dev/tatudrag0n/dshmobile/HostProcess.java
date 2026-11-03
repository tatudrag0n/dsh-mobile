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
	 * Pick a free loopback port, whatever its number.
	 *
	 * This is the last resort behind {@link #preferredPort()}: an arbitrary port
	 * keeps the Host bootable where the preferred range is taken, at the cost of
	 * a new WebView origin.
	 *
	 * @return the port.
	 * @throws IOException when no port can be bound.
	 */
	static int freePort() throws IOException {
		// SO_REUSEADDR only counts when it is set before the socket is bound; on
		// a bound socket the call is accepted and does nothing.
		try (ServerSocket socket = new ServerSocket()) {
			socket.setReuseAddress(true);
			socket.bind(new java.net.InetSocketAddress(java.net.InetAddress.getByName("127.0.0.1"), 0));
			return socket.getLocalPort();
		}
	}

	/**
	 * Whether nothing is listening on a loopback port.
	 * @param port - the port to probe.
	 * @returns true when it can be bound.
	 */
	private static boolean portIsFree(int port) {
		// The probe has to reuse the address too: a port left in TIME_WAIT by the
		// previous run is free for us, and treating it as taken is what pushed
		// the Host onto a new port - and so onto a new WebView origin - on every
		// restart after a clean stop.
		try (ServerSocket probe = new ServerSocket()) {
			probe.setReuseAddress(true);
			probe.bind(new java.net.InetSocketAddress(java.net.InetAddress.getByName("127.0.0.1"), port));
			return true;
		} catch (Exception busy) {
			return false;
		}
	}

	/**
	 * The port the Host prefers to listen on.
	 *
	 * It matches the port the desktop Host and the Termux instructions use, so a
	 * phone that pairs with either one is talking about the same origin.
	 */
	static final int PREFERRED_PORT = 3080;

	/** How many ports above the preferred one are tried before falling back. */
	private static final int PREFERRED_TRIES = 4;

	/**
	 * The port the Host should listen on, stable across launches.
	 *
	 * The WebView's origin *is* the port, and the stored session id, the read
	 * flags and the service-worker cache are all keyed by that origin. A Host
	 * that came up on a fresh port every launch therefore looked like a new
	 * browser to the Harness on every start: it piled up sessions and re-showed
	 * its notices. The preferred range is tried first; an ephemeral port stays
	 * the last resort, because a phone where 3080 is taken still has to boot.
	 * @returns a port nothing is listening on.
	 * @throws IOException when even the fallback cannot be found.
	 */
	static int preferredPort() throws IOException {
		for (int offset = 0; offset < PREFERRED_TRIES; offset += 1) {
			int candidate = PREFERRED_PORT + offset;
			if (portIsFree(candidate)) return candidate;
		}
		return freePort();
	}

	/**
	 * The next port to try after one turned out to be taken.
	 *
	 * A retry walks forward from the port that failed instead of starting over at
	 * the preferred one: starting over would only find the same busy port again
	 * when something took it between the probe and the bind.
	 * @param previous - the port that failed.
	 * @returns a port nothing is listening on.
	 * @throws IOException when nothing can be bound.
	 */
	static int portAfter(int previous) throws IOException {
		for (int offset = 1; offset <= PREFERRED_TRIES + 4; offset += 1) {
			int candidate = previous + offset;
			if (candidate > 65_535) break;
			if (portIsFree(candidate)) return candidate;
		}
		return freePort();
	}

	/**
	 * Start the Host.
	 *
	 * @param port - the loopback port to listen on.
	 * @throws IOException when the runtime is incomplete or the process cannot start.
	 */
	void start(int port) throws IOException {
		// A START_STICKY redelivery or a second "start" is not a reason to run a
		// second node: the two would fight over the port and the phone would show
		// the boot failure card with EADDRINUSE in the log.
		if (process != null && process.isAlive()) return;
		// A node process can also outlive a force-stop and keep the port of the
		// previous run, so anything recorded under our own pid file goes first.
		stopLeftover();
		// The pid file is only trustworthy while /proc is readable. When it is
		// not, a stale Host is still the likeliest reason a port is taken, so the
		// port is probed here and the caller moves on to the next one instead of
		// letting node die on EADDRINUSE behind a boot failure card.
		if (!portIsFree(port)) throw new IOException("ポート " + port + " は使用中です");
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
		// The plugin prints one start line with the mode, the bind address and
		// the home; this is what fills the mode in.
		environment.put("DSH_MOBILE_MODE", "standalone");
		environment.put("DSH_MOBILE_BRIDGE", new File(home, "bridge.json").getAbsolutePath());
		// The profile's bundles are resolved from the profile directory; this
		// is the fallback when the app could not create the node_modules link.
		environment.put("NODE_PATH", new File(runtime, "app/node_modules").getAbsolutePath());
		environment.put("TERM", "xterm-256color");

		process = builder.start();
		writePid(process);
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
		// Nothing of ours is running any more, so the pid file is stale.
		pidFile().delete();
	}

	/**
	 * The file that carries the pid of the Host child process.
	 *
	 * It lives in the app's private files: it is a handle on our own node, not
	 * something another app has any business reading.
	 * @returns the file.
	 */
	private File pidFile() {
		return new File(context.getFilesDir(), "host.pid");
	}

	/**
	 * Record the pid of a freshly started Host.
	 * @param started - the process that was just started.
	 */
	private void writePid(Process started) {
		int pid = pidOf(started);
		if (pid <= 0) return;
		try {
			// The pid alone is not proof of anything: Android reuses them, so the
			// start time from /proc is recorded next to it.
			RuntimeStore.writeText(pidFile(), pid + " " + startTimeOf(pid));
		} catch (Exception unwritable) {
			Log.w(TAG, "host: cannot record the pid: " + unwritable.getMessage());
		}
	}

	/**
	 * Read the pid of a process.
	 *
	 * `Process.pid()` arrived in API 26 and the app supports 24, so the field is
	 * read reflectively and a failure only means "no pid", never a crash.
	 * @param target - the process.
	 * @returns the pid, or 0 when it cannot be read.
	 */
	private static int pidOf(Process target) {
		try {
			java.lang.reflect.Field field = target.getClass().getDeclaredField("pid");
			field.setAccessible(true);
			return field.getInt(target);
		} catch (Exception unreadable) {
			return 0;
		}
	}

	/**
	 * The start time `/proc/<pid>/stat` records for a process.
	 *
	 * Two processes that shared a pid have different start times, which is what
	 * makes it safe to act on a recorded pid at all.
	 * @param pid - the process id.
	 * @returns the start time, or 0 when /proc cannot be read.
	 */
	private static long startTimeOf(int pid) {
		try {
			String stat = RuntimeStore.readText(new File("/proc/" + pid + "/stat"));
			int end = stat.lastIndexOf(')');
			if (end < 0) return 0;
			// After "pid (command)" the record continues with the state, so the
			// start time (field 22 of the record) is the twentieth token here.
			String[] fields = stat.substring(end + 1).trim().split("\\s+");
			if (fields.length < 20) return 0;
			return Long.parseLong(fields[19]);
		} catch (Exception unreadable) {
			return 0;
		}
	}

	/**
	 * Stop a Host left behind by a previous run of the app.
	 *
	 * The pid is only acted on when `/proc` still names it as a node process, so
	 * a recycled pid can never take an unrelated process down with it.
	 */
	private void stopLeftover() {
		File file = pidFile();
		if (!file.isFile()) return;
		try {
			String text = RuntimeStore.readText(file).trim();
			file.delete();
			String[] parts = text.split("\\s+");
			int pid = Integer.parseInt(parts[0]);
			if (pid <= 0 || pid == android.os.Process.myPid()) return;
			// A recycled pid must never be killed, so the start time recorded with
			// it has to match the process that carries the pid now.
			long recorded = parts.length > 1 ? Long.parseLong(parts[1]) : 0;
			if (recorded == 0 || startTimeOf(pid) != recorded) return;
			File command = new File("/proc/" + pid + "/cmdline");
			String name = command.isFile() ? RuntimeStore.readText(command) : "";
			if (!name.contains("node")) return;
			Log.i(TAG, "host: stopping the leftover Host pid " + pid);
			android.os.Process.killProcess(pid);
			Thread.sleep(200);
		} catch (Exception unreadable) {
			// A dead, unreadable or unrecognised pid is nothing to stop; the port
			// probe then moves the Host to the next port instead.
		}
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
