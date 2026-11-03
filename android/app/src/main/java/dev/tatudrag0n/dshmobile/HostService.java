package dev.tatudrag0n.dshmobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;

/**
 * Keeps the standalone Host alive.
 *
 * Running DSH on the phone means running a server in the app's own process
 * tree, and Android kills that tree as soon as the last activity is gone. A
 * foreground service is the platform's answer: the Host keeps serving (and the
 * agent keeps working) while the user is in another app, with a notification
 * that says so and offers to stop it.
 *
 * The service also owns the two things that must exist before the Host can
 * start: an installed runtime ({@link RuntimeStore}) and the loopback bridge
 * ({@link PhoneBridge}). Its state is published statically because the only
 * observer is this app's own activity.
 */
public class HostService extends Service {

	private static final String TAG = "DshMobile";

	/** Notification channel for the "host is running" notice. */
	private static final String CHANNEL = "dsh-host";
	/** The one notification id. */
	private static final int NOTIFICATION = 41;

	/** What the activity shows. */
	enum State { IDLE, INSTALLING, STARTING, READY, FAILED }

	/** The Host phase, readable from the activity. */
	private static volatile State state = State.IDLE;
	/** The line shown under the phase. */
	private static volatile String message = "";
	/** The launch URL once the server listens. */
	private static volatile String url = "";
	/** The last failure, kept for the activity. */
	private static volatile String failure = "";

	private HostProcess host;
	private PhoneBridge bridge;
	private Thread worker;

	/**
	 * The current phase.
	 *
	 * @return the state.
	 */
	static State state() {
		return state;
	}

	/**
	 * The current status line.
	 *
	 * @return the message.
	 */
	static String message() {
		return message;
	}

	/**
	 * The launch URL, or an empty string before the server listens.
	 *
	 * @return the URL.
	 */
	static String url() {
		return url;
	}

	/**
	 * The last failure.
	 *
	 * @return the failure text, or an empty string.
	 */
	static String failure() {
		return failure;
	}

	/**
	 * Start the Host for the standalone mode.
	 *
	 * @param context - any context.
	 */
	static void startHost(Context context) {
		Intent intent = new Intent(context, HostService.class);
		intent.setAction("dev.tatudrag0n.dshmobile.START");
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
		else context.startService(intent);
	}

	/**
	 * Stop the Host.
	 *
	 * @param context - any context.
	 */
	static void stopHost(Context context) {
		context.stopService(new Intent(context, HostService.class));
	}

	@Override
	public void onCreate() {
		super.onCreate();
		createChannel();
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		startForeground(NOTIFICATION, notification(statusText()));
		if (worker == null || !worker.isAlive()) {
			worker = new Thread(this::boot, "dsh-host-service");
			worker.setDaemon(true);
			worker.start();
		}
		return START_STICKY;
	}

	@Override
	public void onDestroy() {
		super.onDestroy();
		state = State.IDLE;
		message = "";
		url = "";
		if (host != null) {
			host.stop();
			host = null;
		}
		if (bridge != null) {
			bridge.stop();
			bridge = null;
		}
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}

	/**
	 * Install what is missing, then start the bridge and the Host.
	 */
	private void boot() {
		try {
			// An app update moves the native library directory the runtime's
			// executables link into, so a broken link is repaired before it is
			// mistaken for a missing runtime.
			if (!RuntimeStore.isInstalled(this) && !RuntimeStore.ensureLinks(this)) {
				state = State.INSTALLING;
				message = "ランタイムを取得しています…";
				updateNotification();
				installRuntime();
			}
			if (!RuntimeStore.isInstalled(this)) {
				throw new IllegalStateException("ランタイムを用意できませんでした");
			}

			state = State.STARTING;
			message = "スマホの操作ブリッジを準備しています…";
			updateNotification();
			if (bridge == null) {
				bridge = new PhoneBridge(this);
				bridge.start();
			}

			int hostPort = HostProcess.preferredPort();
			// One line the support case can be read from: a fallback port means
			// the phone will start with a fresh WebView origin (and so a fresh
			// session), which explains a lost login.
			Log.i(TAG, "host: loopback port " + hostPort
				+ (hostPort == HostProcess.PREFERRED_PORT ? " (preferred)" : " (fallback)"));
			RuntimeStore.prepareHome(this, hostPort, bridge.port(), bridge.token());

			message = "Host を起動しています…";
			updateNotification();
			host = new HostProcess(this, new HostProcess.Listener() {
				@Override
				public void onUrl(String launchUrl) {
					url = launchUrl;
					state = State.READY;
					message = "起動しました";
					failure = "";
					updateNotification();
				}

				@Override
				public void onLine(String line) {
					Log.i(TAG, "host: " + line);
				}

				@Override
				public void onExit(int code) {
					if ((idle())) return;
					state = State.FAILED;
					url = "";
					failure = "Host が終了しました (exit " + code + ")。" + tail();
					message = failure;
					updateNotification();
				}
			});
			// A port that a leftover node still holds must not become a boot failure
		// card: the home is prepared again for the next free port and the Host is
		// started there. Three attempts walk past a stale process without
		// looping, and the last failure is reported as it always was.
		int port = hostPort;
		for (int attempt = 0; ; attempt += 1) {
			try {
				host.start(port);
				break;
			} catch (java.io.IOException busy) {
				if (attempt >= 2) throw busy;
				port = HostProcess.portAfter(port);
				RuntimeStore.prepareHome(this, port, bridge.port(), bridge.token());
				Log.w(TAG, "host: port busy, retrying on " + port + " (" + busy.getMessage() + ")");
			}
		}
		} catch (Exception failure) {
			state = State.FAILED;
			url = "";
			this.failure = String.valueOf(failure.getMessage());
			message = this.failure;
			Log.e(TAG, "host boot failed", failure);
			updateNotification();
		}
	}

	/**
	 * Whether the service is being torn down.
	 *
	 * @return the answer.
	 */
	private boolean idle() {
		return state == State.IDLE;
	}

	/**
	 * Install the runtime from the app's manifest entry, or from a bundle the
	 * user already has.
	 *
	 * @throws Exception when nothing can be installed.
	 */
	private void installRuntime() throws Exception {
		JSONObject manifest = RuntimeStore.manifest(this);
		File archive;
		if (manifest != null) {
			archive = RuntimeStore.download(this, manifest, (percent, text) -> {
				message = text;
				updateNotification();
			});
		} else {
			throw new IllegalStateException(
				"この APK にはランタイムの入手先が入っていません。設定からランタイムの zip を選んでください。");
		}
		message = "展開しています…";
		updateNotification();
		RuntimeStore.install(this, archive, (percent, text) -> {
			message = text;
			updateNotification();
		});
		archive.delete();
	}

	/**
	 * The last lines of the Host log, for a failure card.
	 *
	 * @return the tail, or an empty string.
	 */
	private String tail() {
		try {
			File log = new File(RuntimeStore.logDir(this), "host.log");
			if (!log.isFile()) return "";
			String text = RuntimeStore.readText(log);
			String[] lines = text.split("\n");
			StringBuilder tail = new StringBuilder();
			for (int index = Math.max(0, lines.length - 8); index < lines.length; index += 1) {
				if (lines[index].trim().isEmpty()) continue;
				tail.append('\n').append(lines[index]);
			}
			return tail.toString();
		} catch (Exception ignored) {
			return "";
		}
	}

	/**
	 * The one-line status the notification shows.
	 *
	 * @return the text.
	 */
	private String statusText() {
		switch (state) {
			case READY: return "DSH Mobile はスマホ上で動作しています";
			case INSTALLING: return "ランタイムを準備しています…";
			case STARTING: return "Host を起動しています…";
			case FAILED: return "Host を起動できませんでした";
			default: return "DSH Mobile";
		}
	}

	/**
	 * Refresh the foreground notification.
	 */
	private void updateNotification() {
		NotificationManager manager = getSystemService(NotificationManager.class);
		if (manager != null) manager.notify(NOTIFICATION, notification(statusText()));
	}

	/**
	 * Build the foreground notification.
	 *
	 * @param title - the status line.
	 * @return the notification.
	 */
	private Notification notification(String title) {
		Intent open = new Intent(this, MainActivity.class);
		PendingIntent content = PendingIntent.getActivity(this, 0, open,
			PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
		Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
			? new Notification.Builder(this, CHANNEL)
			: new Notification.Builder(this);
		builder.setContentTitle(title)
			.setContentText(message)
			.setSmallIcon(android.R.drawable.stat_sys_upload_done)
			.setOngoing(true)
			.setContentIntent(content);
		return builder.build();
	}

	/**
	 * Create the notification channel.
	 */
	private void createChannel() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
		NotificationManager manager = getSystemService(NotificationManager.class);
		if (manager == null) return;
		NotificationChannel channel = new NotificationChannel(
			CHANNEL, "DSH Host", NotificationManager.IMPORTANCE_LOW);
		channel.setDescription("スマホ上で動く DSH Host の状態");
		manager.createNotificationChannel(channel);
	}
}
