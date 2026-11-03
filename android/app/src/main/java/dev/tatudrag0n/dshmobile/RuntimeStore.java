package dev.tatudrag0n.dshmobile;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Enumeration;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/**
 * The on-device DSH runtime: where it lives, how it is installed, and the
 * small files the Host needs beside it.
 *
 * A standalone install is four trees under the app's private storage:
 *
 * <pre>
 *   files/runtime/          the downloaded bundle: bin/node, lib/*.so,
 *                           app/ (the DSH package tree), plugins/, profile/
 *   files/home/             DSH_HOME: sessions, credentials, the mobile profile
 *   files/home/bridge.json  the loopback bridge the phone plugin dials
 *   files/logs/host.log     the Host's own output
 * </pre>
 *
 * The workspace - the directory the agent's file tools see - is
 * {@code /sdcard/DSH} when the user granted all-files access and a private
 * directory otherwise, so an install without that permission still works.
 */
final class RuntimeStore {

	private static final String TAG = "DshMobile";

	/** Where the unpacked bundle lives. */
	static final String RUNTIME = "runtime";
	/** Where the Host keeps user state. */
	static final String HOME = "home";
	/** Where the Host's stdout/stderr is appended. */
	static final String LOGS = "logs";

	/** Prefs that remember the install and the chosen mode. */
	private static final String PREFS = "dsh-mobile";
	private static final String KEY_MODE = "mode";
	private static final String KEY_INSTALLED_VERSION = "runtimeVersion";
	private static final String KEY_WORKSPACE = "workspace";

	/** Standalone mode: the phone is the Host. */
	static final String MODE_STANDALONE = "standalone";
	/** Remote mode: the phone is a client of a PC Host. */
	static final String MODE_REMOTE = "remote";

	/** The bundle's own description, written by the build. */
	private static final String MANIFEST = "runtime-manifest.json";

	private RuntimeStore() {
	}

	/**
	 * The runtime directory.
	 *
	 * @param context - any context.
	 * @return the directory.
	 */
	static File runtimeDir(Context context) {
		return new File(context.getFilesDir(), RUNTIME);
	}

	/**
	 * The harness home.
	 *
	 * @param context - any context.
	 * @return the directory.
	 */
	static File homeDir(Context context) {
		return new File(context.getFilesDir(), HOME);
	}

	/**
	 * The log directory.
	 *
	 * @param context - any context.
	 * @return the directory.
	 */
	static File logDir(Context context) {
		return new File(context.getFilesDir(), LOGS);
	}

	/**
	 * The Node binary of an installed runtime.
	 *
	 * @param context - any context.
	 * @return the file.
	 */
	static File nodeBinary(Context context) {
		return new File(new File(runtimeDir(context), "bin"), "node");
	}

	/**
	 * The DSH entry point inside an installed runtime.
	 *
	 * @param context - any context.
	 * @return the file.
	 */
	static File dshEntry(Context context) {
		return new File(runtimeDir(context),
			"app/node_modules/@deepseek-ai/dsh/lib/bin.js");
	}

	/**
	 * Whether a complete runtime is installed.
	 *
	 * @param context - any context.
	 * @return true when the node binary and the DSH entry point both exist.
	 */
	static boolean isInstalled(Context context) {
		return nodeBinary(context).isFile() && dshEntry(context).isFile();
	}

	/**
	 * The mode the user chose, defaulting to standalone.
	 *
	 * @param context - any context.
	 * @return {@link #MODE_STANDALONE} or {@link #MODE_REMOTE}.
	 */
	static String mode(Context context) {
		return prefs(context).getString(KEY_MODE, MODE_STANDALONE);
	}

	/**
	 * Remember the mode.
	 *
	 * @param context - any context.
	 * @param mode - the mode to remember.
	 */
	static void setMode(Context context, String mode) {
		prefs(context).edit().putString(KEY_MODE, mode).apply();
	}

	/**
	 * The workspace the agent's file tools see.
	 *
	 * All-files access is what lets the agent work on real phone files, so it
	 * is preferred; without it the workspace stays inside the app, which still
	 * gives a usable (if isolated) filesystem.
	 *
	 * @param context - any context.
	 * @return the directory, created if needed.
	 */
	static File workspaceDir(Context context) {
		File chosen = null;
		if (hasAllFilesAccess(context)) {
			File shared = new File(Environment.getExternalStorageDirectory(), "DSH");
			if (shared.isDirectory() || shared.mkdirs()) chosen = shared;
		}
		if (chosen == null) {
			chosen = new File(context.getFilesDir(), "workspace");
			if (!chosen.isDirectory() && !chosen.mkdirs()) {
				Log.w(TAG, "workspace directory could not be created: " + chosen);
			}
			prefs(context).edit().putString(KEY_WORKSPACE, chosen.getAbsolutePath()).apply();
			return chosen;
		}
		prefs(context).edit().putString(KEY_WORKSPACE, chosen.getAbsolutePath()).apply();
		return chosen;
	}

	/**
	 * Whether the app may read and write all of shared storage.
	 *
	 * @param context - any context.
	 * @return the answer.
	 */
	static boolean hasAllFilesAccess(Context context) {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
			return context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
				== PackageManager.PERMISSION_GRANTED;
		}
		return Environment.isExternalStorageManager();
	}

	/**
	 * Prepare the harness home: the mobile profile, the module link and the
	 * bridge descriptor.
	 *
	 * The profile's patch names the plugin by absolute path, so it cannot be
	 * shipped as-is: the app rewrites the placeholders while copying it out of
	 * the runtime. The loader resolves packages from the profile directory, so
	 * a `node_modules` link back to the runtime tree is what makes
	 * `@deepseek-ai/dsh-base` and friends resolvable without installing them.
	 *
	 * @param context - any context.
	 * @param port - the loopback port the Host will listen on.
	 * @param bridgePort - the loopback port the app's bridge listens on.
	 * @param bridgeToken - the token the bridge requires.
	 * @throws IOException when the home cannot be prepared.
	 */
	static void prepareHome(Context context, int port, int bridgePort, String bridgeToken) throws IOException {
		File home = homeDir(context);
		File profile = new File(home, "profiles/mobile");
		File tmp = new File(home, "tmp");
		File logs = logDir(context);
		for (File directory : new File[] { home, profile, tmp, logs,
			new File(home, "sessions"), new File(home, "storages") }) {
			if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) {
				throw new IOException("cannot create " + directory);
			}
		}

		File source = new File(runtimeDir(context), "profile");
		copyText(new File(source, "package.json"), new File(profile, "package.json"), null);
		String plugins = new File(runtimeDir(context), "plugins").getAbsolutePath();
		String bridge = new File(home, "bridge.json").getAbsolutePath();
		// Android has no desktop "Documents" directory, so the profile cannot ask
		// the Host to discover one: the workspace controller is told where to make
		// its first workspace instead. This is also the agent's working directory.
		String workspace = workspaceDir(context).getAbsolutePath();
		copyText(new File(source, "cordis.patch.yml"), new File(profile, "cordis.patch.yml"),
			new String[][] {
				{ "{{port}}", Integer.toString(port) },
				{ "{{pluginsDir}}", plugins },
				{ "{{bridgePath}}", bridge },
				{ "{{workspace}}", workspace },
			});

		File modules = new File(home, "node_modules");
		File runtimeModules = new File(runtimeDir(context), "app/node_modules");
		if (!modules.exists()) {
			try {
				android.system.Os.symlink(runtimeModules.getAbsolutePath(), modules.getAbsolutePath());
			} catch (Exception failure) {
				Log.w(TAG, "node_modules link failed, relying on NODE_PATH: " + failure.getMessage());
			}
		}

		JSONObject descriptor = new JSONObject();
		try {
			descriptor.put("url", "http://127.0.0.1:" + bridgePort + "/");
			descriptor.put("token", bridgeToken);
			descriptor.put("workspace", workspaceDir(context).getAbsolutePath());
		} catch (Exception failure) {
			throw new IOException("cannot describe the bridge", failure);
		}
		writeText(new File(home, "bridge.json"), descriptor.toString());
	}

	/**
	 * Put the executables and libraries where the Host expects them.
	 *
	 * Since Android 10 an app may not execute a binary unpacked into its own
	 * data directory: `fork/exec` on that path fails with EACCES no matter what
	 * the file mode says. Files inside the APK's native library directory are
	 * an exception, so the bundle ships `bin/node`, `bin/bash` and every
	 * `lib*.so*` as `lib*.so` entries in `jniLibs`, and this restores the names
	 * the loader and the shell ask for as symlinks pointing back into that
	 * directory.
	 *
	 * `libmap.json` (written by `scripts/build-runtime.mjs`) is the mapping, so
	 * a new library in a future bundle needs no code change here.
	 *
	 * @param context - any context.
	 * @param runtime - the freshly installed runtime directory.
	 * @throws IOException when the map is missing or a link cannot be made.
	 */
	private static void linkExecutables(Context context, File runtime) throws IOException {
		File map = new File(runtime, "libmap.json");
		if (!map.isFile()) throw new IOException("libmap.json がありません");
		String nativeDirectory = context.getApplicationInfo().nativeLibraryDir;
		JSONObject links;
		try {
			links = new JSONObject(readText(map));
		} catch (Exception broken) {
			throw new IOException("libmap.json を読めません", broken);
		}
		File bin = new File(runtime, "bin");
		File lib = new File(runtime, "lib");
		if (!bin.isDirectory() && !bin.mkdirs() && !bin.isDirectory()) throw new IOException("cannot create " + bin);
		if (!lib.isDirectory() && !lib.mkdirs() && !lib.isDirectory()) throw new IOException("cannot create " + lib);
		linkAll(links.optJSONObject("bin"), bin, nativeDirectory);
		linkAll(links.optJSONObject("lib"), lib, nativeDirectory);
		if (!new File(bin, "node").exists()) throw new IOException("bin/node を用意できませんでした");
	}

	/**
	 * Create one symlink per mapping entry.
	 *
	 * @param entries - target name in the runtime to name inside jniLibs.
	 * @param directory - where the links go.
	 * @param nativeDirectory - the app's native library directory.
	 * @throws IOException when a link cannot be created.
	 */
	private static void linkAll(JSONObject entries, File directory, String nativeDirectory) throws IOException {
		if (entries == null) return;
		java.util.Iterator<String> names = entries.keys();
		while (names.hasNext()) {
			String name = names.next();
			String packaged = entries.optString(name, "");
			if (packaged.isEmpty()) continue;
			File source = new File(nativeDirectory, packaged);
			if (!source.isFile()) throw new IOException("同梱されていないファイルです: " + packaged);
			File link = new File(directory, name);
			if (link.exists()) continue;
			if (isSymlink(link)) {
				// A dangling link from a previous install of the APK: its
				// native library directory no longer exists.
				try {
					android.system.Os.remove(link.getAbsolutePath());
				} catch (android.system.ErrnoException missing) {
					// Already gone; the symlink below reports anything real.
				}
			}
			try {
				android.system.Os.symlink(source.getAbsolutePath(), link.getAbsolutePath());
			} catch (android.system.ErrnoException failure) {
				throw new IOException("リンクを作れません: " + name + " (" + failure.getMessage() + ")", failure);
			}
		}
	}

	/**
	 * Make sure the executables still resolve after an app update.
	 *
	 * The symlinks in the runtime point into the app's native library
	 * directory, and that directory's path contains a hash that changes on
	 * every install. A bundle update therefore only has to relink, not
	 * re-download half a gigabyte - this is the cheap repair that keeps that
	 * true.
	 *
	 * @param context - any context.
	 * @return true when a usable runtime with working links is present.
	 */
	static boolean ensureLinks(Context context) {
		if (!isInstalled(context)) {
			File runtime = runtimeDir(context);
			if (!new File(runtime, "libmap.json").isFile()) return false;
			try {
				linkExecutables(context, runtime);
			} catch (IOException broken) {
				Log.w(TAG, "relink failed: " + broken.getMessage());
				return false;
			}
		}
		return isInstalled(context);
	}

	/**
	 * Whether a path is a symbolic link, whether or not its target exists.
	 *
	 * @param file - the path.
	 * @return the answer.
	 */
	private static boolean isSymlink(File file) {
		try {
			android.system.StructStat stat = android.system.Os.lstat(file.getAbsolutePath());
			return (stat.st_mode & 0xF000) == 0xA000;
		} catch (Exception missing) {
			return false;
		}
	}

	/**
	 * The runtime library directory, used as the loader search path.
	 *
	 * @param context - any context.
	 * @return the directory.
	 */
	static File libDir(Context context) {
		return new File(runtimeDir(context), "lib");
	}

	/**
	 * The download this device should use.
	 *
	 * The manifest lists one bundle per ABI (`arm64-v8a` for real phones,
	 * `x86_64` for an emulator); the first ABI the device supports that has an
	 * entry wins, which is the same preference order Android uses for native
	 * libraries.
	 *
	 * @param context - any context.
	 * @return the entry with `url`, `sha256` and `abi`, or null when the app was
	 *         built without one.
	 */
	static JSONObject manifest(Context context) {
		try (InputStream input = context.getAssets().open(MANIFEST)) {
			JSONObject catalog = new JSONObject(readAll(input));
			JSONObject abis = catalog.optJSONObject("abis");
			if (abis == null) return null;
			for (String abi : Build.SUPPORTED_ABIS) {
				JSONObject entry = abis.optJSONObject(abi);
				if (entry == null) continue;
				entry.put("abi", abi);
				return entry;
			}
			return null;
		} catch (Exception missing) {
			return null;
		}
	}

	/**
	 * Download the runtime bundle named by the manifest into a cache file.
	 *
	 * @param context - any context.
	 * @param manifest - the manifest with `url` and `sha256`.
	 * @param listener - progress callback.
	 * @return the verified zip file.
	 * @throws IOException when the download fails or the digest does not match.
	 */
	static File download(Context context, JSONObject manifest, Progress listener) throws IOException {
		String url = manifest.optString("url", "");
		if (url.isEmpty()) throw new IOException("runtime-manifest.json に url がありません");
		File target = new File(context.getCacheDir(), "dsh-runtime.zip");
		listener.onProgress(0, "接続しています…");
		HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
		connection.setConnectTimeout(20000);
		connection.setReadTimeout(60000);
		connection.setInstanceFollowRedirects(true);
		connection.setRequestProperty("User-Agent", "dsh-mobile");
		File partial = new File(context.getCacheDir(), "dsh-runtime.zip.part");
		try {
			int status = connection.getResponseCode();
			if (status != HttpURLConnection.HTTP_OK) {
				throw new IOException("ダウンロードに失敗しました（HTTP " + status + "）");
			}
			long total = connection.getContentLengthLong();
			long copied = 0;
			long last = 0;
			try (InputStream input = connection.getInputStream();
				FileOutputStream output = new FileOutputStream(partial)) {
				byte[] buffer = new byte[256 * 1024];
				int read;
				while ((read = input.read(buffer)) > 0) {
					output.write(buffer, 0, read);
					copied += read;
					if (copied - last > 8L * 1024 * 1024) {
						last = copied;
						listener.onProgress(total > 0 ? (int) (copied * 100 / total) : 0,
							String.format(Locale.JAPAN, "%.1f / %.1f MB",
								copied / 1048576.0, total > 0 ? total / 1048576.0 : 0));
					}
				}
			}
			String expected = manifest.optString("sha256", "");
			if (!expected.isEmpty()) {
				listener.onProgress(100, "検証しています…");
				String actual = sha256(partial);
				if (!expected.equalsIgnoreCase(actual)) {
					throw new IOException("ダウンロードしたランタイムのハッシュが一致しません");
				}
			}
			if (!partial.renameTo(target)) {
				throw new IOException("ダウンロードしたファイルを置けませんでした");
			}
			return target;
		} finally {
			connection.disconnect();
			if (partial.exists() && !partial.equals(target)) partial.delete();
		}
	}

	/**
	 * Unpack a runtime bundle into the private runtime directory.
	 *
	 * Extraction is transactional: the archive goes into a sibling directory
	 * that is renamed into place only once every entry has been written, so a
	 * failure or a killed process never leaves a half-installed runtime that
	 * `isInstalled` would accept.
	 *
	 * @param context - any context.
	 * @param archive - the zip to unpack.
	 * @param listener - progress callback.
	 * @throws IOException when the archive is unreadable or an entry escapes.
	 */
	static void install(Context context, File archive, Progress listener) throws IOException {
		File target = runtimeDir(context);
		File staging = new File(context.getFilesDir(), "runtime-staging");
		deleteTree(staging);
		if (!staging.mkdirs()) throw new IOException("展開先を作れませんでした");
		long totalBytes = 0;
		try (ZipFile zip = new ZipFile(archive)) {
			Enumeration<? extends ZipEntry> entries = zip.entries();
			while (entries.hasMoreElements()) totalBytes += Math.max(0, entries.nextElement().getSize());
		}
		long written = 0;
		long last = 0;
		byte[] buffer = new byte[256 * 1024];
		try (ZipInputStream input = new ZipInputStream(new java.io.FileInputStream(archive))) {
			ZipEntry entry;
			while ((entry = input.getNextEntry()) != null) {
				String name = entry.getName();
				if (name.startsWith("/") || name.contains("..")) {
					throw new IOException("アーカイブに不正なパスがあります: " + name);
				}
				File out = new File(staging, name);
				if (entry.isDirectory()) {
					if (!out.isDirectory() && !out.mkdirs() && !out.isDirectory()) {
						throw new IOException("ディレクトリを作れません: " + name);
					}
					continue;
				}
				File parent = out.getParentFile();
				if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
					throw new IOException("ディレクトリを作れません: " + parent);
				}
				try (FileOutputStream output = new FileOutputStream(out)) {
					int read;
					while ((read = input.read(buffer)) > 0) {
						output.write(buffer, 0, read);
						written += read;
						if (written - last > 16L * 1024 * 1024) {
							last = written;
							listener.onProgress(totalBytes > 0 ? (int) (written * 100 / totalBytes) : 0,
								"展開しています… " + (written / 1048576) + " MB");
						}
					}
				}
				// The zip stores the executable bit; Android needs it back for
				// bin/node and bin/bash.
				if (name.startsWith("bin/")) out.setExecutable(true, true);
			}
		} catch (IOException failure) {
			deleteTree(staging);
			throw failure;
		}
		// The old tree is moved aside rather than deleted in place: a directory
		// that is still being watched by a dying process is a poor rename
		// target, and moving it keeps the swap to one atomic step.
		File previous = new File(context.getFilesDir(), "runtime-previous");
		deleteTree(previous);
		if (target.exists() && !target.renameTo(previous)) {
			deleteTree(target);
		}
		if (!staging.renameTo(target)) {
			deleteTree(staging);
			throw new IOException("ランタイムを所定の場所へ移せませんでした");
		}
		deleteTree(previous);
		linkExecutables(context, target);
		String version = "";
		try {
			File manifest = new File(target, "runtime.json");
			if (manifest.isFile()) {
				version = new JSONObject(readText(manifest)).optString("version", "");
			}
		} catch (Exception ignored) {
			// A missing manifest only loses the version label.
		}
		prefs(context).edit().putString(KEY_INSTALLED_VERSION, version).apply();
		listener.onProgress(100, "展開しました");
	}

	/**
	 * The version label of the installed runtime.
	 *
	 * @param context - any context.
	 * @return the version, or an empty string.
	 */
	static String installedVersion(Context context) {
		return prefs(context).getString(KEY_INSTALLED_VERSION, "");
	}

	/**
	 * Remove an installed runtime.
	 *
	 * @param context - any context.
	 */
	static void uninstall(Context context) {
		deleteTree(runtimeDir(context));
		prefs(context).edit().remove(KEY_INSTALLED_VERSION).apply();
	}

	/**
	 * Progress sink for installs.
	 */
	interface Progress {
		/**
		 * Report progress.
		 *
		 * @param percent - 0-100, or 0 when the total is unknown.
		 * @param message - a short status line.
		 */
		void onProgress(int percent, String message);
	}

	/**
	 * The app's preferences.
	 *
	 * @param context - any context.
	 * @return the preferences.
	 */
	private static SharedPreferences prefs(Context context) {
		return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
	}

	/**
	 * Copy a text file while replacing placeholders.
	 *
	 * @param from - the source.
	 * @param to - the destination.
	 * @param replacements - pairs of literal and replacement, or null to copy.
	 * @throws IOException when either side fails.
	 */
	private static void copyText(File from, File to, String[][] replacements) throws IOException {
		String text = readText(from);
		if (replacements != null) {
			for (String[] pair : replacements) text = text.replace(pair[0], pair[1]);
		}
		writeText(to, text);
	}

	/**
	 * Read a text file.
	 *
	 * @param file - the file.
	 * @return its contents.
	 * @throws IOException when it cannot be read.
	 */
	static String readText(File file) throws IOException {
		try (InputStream input = new java.io.FileInputStream(file)) {
			return readAll(input);
		}
	}

	/**
	 * Write a text file atomically enough for the Host to read on next start.
	 *
	 * @param file - the destination.
	 * @param text - the contents.
	 * @throws IOException when it cannot be written.
	 */
	static void writeText(File file, String text) throws IOException {
		File parent = file.getParentFile();
		if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
			throw new IOException("cannot create " + parent);
		}
		File temporary = new File(file.getParentFile(), file.getName() + ".part");
		try (FileOutputStream output = new FileOutputStream(temporary)) {
			output.write(text.getBytes(StandardCharsets.UTF_8));
		}
		if (!temporary.renameTo(file)) {
			temporary.delete();
			throw new IOException("cannot write " + file);
		}
	}

	/**
	 * Read a stream fully as UTF-8.
	 *
	 * @param input - the stream.
	 * @return the text.
	 * @throws IOException when reading fails.
	 */
	private static String readAll(InputStream input) throws IOException {
		java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
		byte[] chunk = new byte[64 * 1024];
		int read;
		while ((read = input.read(chunk)) > 0) buffer.write(chunk, 0, read);
		return buffer.toString("UTF-8");
	}

	/**
	 * SHA-256 of a file, lowercase hex.
	 *
	 * @param file - the file.
	 * @return the digest.
	 * @throws IOException when the file cannot be read.
	 */
	private static String sha256(File file) throws IOException {
		try {
			MessageDigest digest = MessageDigest.getInstance("SHA-256");
			try (InputStream input = new java.io.FileInputStream(file)) {
				byte[] chunk = new byte[256 * 1024];
				int read;
				while ((read = input.read(chunk)) > 0) digest.update(chunk, 0, read);
			}
			StringBuilder hex = new StringBuilder();
			for (byte value : digest.digest()) hex.append(String.format("%02x", value));
			return hex.toString();
		} catch (java.security.NoSuchAlgorithmException missing) {
			throw new IOException("SHA-256 が使えません", missing);
		}
	}

	/**
	 * Delete a tree, ignoring failures.
	 *
	 * @param file - the root to delete.
	 */
	static void deleteTree(File file) {
		if (file == null || !file.exists()) return;
		File[] children = file.listFiles();
		if (children != null) for (File child : children) deleteTree(child);
		if (!file.delete()) file.deleteOnExit();
	}
}
