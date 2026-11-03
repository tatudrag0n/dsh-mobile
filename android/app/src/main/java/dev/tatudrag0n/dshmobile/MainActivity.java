package dev.tatudrag0n.dshmobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;

/**
 * The DSH Mobile app.
 *
 * It has two shapes, chosen in the menu:
 *
 * <b>Standalone</b> (the default) - the phone is the Host. The app installs a
 * Node runtime and the DSH package into its own storage, runs `dsh mobile` as
 * a foreground service, and points the WebView at the loopback URL that Host
 * prints. Nothing else is needed: no PC, no pairing, no network beyond the one
 * the model API itself needs.
 *
 * <b>Remote</b> - the phone is a client of a Host on the PC. It opens the
 * pairing page, the PIN is typed in, and the Host's cookie keeps it signed in.
 * This is the older behaviour, kept because a phone with the desktop open is
 * sometimes the thing you want.
 *
 * In standalone mode the phone's own input and screen are exposed to the agent
 * through {@link PhoneUseService}; the app's job is only to keep the Host
 * running and to put the Web UI on screen.
 */
public class MainActivity extends Activity {

	/** Where the mode, the remote host and the pairing path are remembered. */
	private static final String PREFS = "dsh-mobile";
	private static final String KEY_HOST = "host";
	private static final String KEY_PAIR_PATH = "pairPath";
	/** The pairing path the plugin uses unless it is configured otherwise. */
	private static final String DEFAULT_PAIR_PATH = "/mobile";
	/** The scheme the Host serves the Web UI on unless the user typed one. */
	private static final String DEFAULT_SCHEME = "http";
	/** The port the Host serves the Web UI on unless the user typed one. */
	private static final int DEFAULT_PORT = 3080;
	/** The request code of the file chooser. */
	private static final int REQUEST_FILE = 1001;
	/** The request code of the microphone permission. */
	private static final int REQUEST_AUDIO = 1002;
	/** The request code of the notification permission. */
	private static final int REQUEST_NOTIFICATIONS = 1003;
	/** How often the standalone status card is refreshed. */
	private static final long POLL_MS = 500;
	/** How long before a lost cookie may send the phone back to the pairing page. */
	private static final long AUTH_RETRY_MS = 8000;

	private WebView web;
	private TextView hostLabel;
	private View setup;
	private View error;
	private View statusCard;
	private TextView statusTitle;
	private TextView statusText;
	private Button statusRetry;
	private Button statusPermissions;
	private String pendingError;
	private TextView errorText;
	private EditText hostInput;
	private EditText pairPathInput;
	private ValueCallback<Uri[]> fileCallback;
	private PermissionRequest pendingAudio;
	private final Handler poller = new Handler(Looper.getMainLooper());
	private final Runnable pollTask = this::pollHost;
	private String loadedUrl = "";
	/** When the Host last rejected the cookie, in milliseconds. */
	private long lastSessionLoss;
	/** Whether a link was handed to another app, so coming back reloads. */
	private boolean leftForBrowser;
	/** The window a page opened for itself, while one is open. */
	private WebView popupWeb;
	/** The dialog that carries that window. */
	private Dialog popupDialog;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		setContentView(buildLayout());
		if (RuntimeStore.MODE_REMOTE.equals(RuntimeStore.mode(this))) enterRemote();
		else enterStandalone();
	}

	@Override
	protected void onResume() {
		super.onResume();
		if (leftForBrowser) {
			leftForBrowser = false;
			// The browser may have finished the login; coming back to the app is
			// the only moment it can pick that up.
			if (web != null) web.reload();
		}
		if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) {
			startPolling();
			refreshWorkspaceLabel();
		}
	}

	@Override
	protected void onPause() {
		super.onPause();
		// The Host's cookie is the whole session, so it is flushed while the app
		// still has focus: a kill from the task switcher would otherwise drop a
		// login the phone had already finished.
		CookieManager.getInstance().flush();
		poller.removeCallbacks(pollTask);
		// A window the page opened is not something the activity owns once it is
		// going away; dismissing it here keeps the teardown in one place.
		if (isFinishing()) closePopup(popupWeb);
	}

	@Override
	protected void onDestroy() {
		// A login window that outlives the activity keeps a WebView, its
		// renderer and a share of the cookie jar alive with it.
		closePopup(popupWeb);
		// The app's own WebView holds a renderer too, and an activity that is
		// destroyed for good has no further use for it.
		if (web != null) {
			web.destroy();
			web = null;
		}
		super.onDestroy();
	}

	/**
	 * Build the whole screen: a slim bar, the web view and the overlays.
	 *
	 * @return the root view.
	 */
	private View buildLayout() {
		LinearLayout root = new LinearLayout(this);
		root.setOrientation(LinearLayout.VERTICAL);
		root.setBackgroundColor(getColor(R.color.dsh_background));
		root.setFitsSystemWindows(true);
		// Android 15 draws the window edge to edge whether the app asks or not.
		// The listener is what keeps the bar and the WebView out from under the
		// status and navigation bars, and out from under the keyboard: the PIN
		// field sits at the bottom of the page, and the ime inset is the only
		// thing that keeps it visible while typing.
		root.setOnApplyWindowInsetsListener((view, insets) -> {
			int top;
			int bottom;
			int left;
			int right;
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
				android.graphics.Insets bars = insets.getInsets(
					WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
				android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
				top = bars.top;
				bottom = Math.max(bars.bottom, keyboard.bottom);
				left = bars.left;
				right = bars.right;
			} else {
				top = insets.getSystemWindowInsetTop();
				bottom = insets.getSystemWindowInsetBottom();
				left = insets.getSystemWindowInsetLeft();
				right = insets.getSystemWindowInsetRight();
			}
			view.setPadding(left, top, right, bottom);
			return insets;
		});

		root.addView(buildBar(), new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, dp(46)));

		FrameLayout content = new FrameLayout(this);
		content.addView(buildWebView(), new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		content.addView(buildSetup(), new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		content.addView(buildStatusCard(), new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		content.addView(buildError(), new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		root.addView(content, new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
		return root;
	}

	/**
	 * The bar at the top: the status label on the left, a menu on the right.
	 *
	 * @return the bar.
	 */
	private View buildBar() {
		LinearLayout bar = new LinearLayout(this);
		bar.setOrientation(LinearLayout.HORIZONTAL);
		bar.setGravity(Gravity.CENTER_VERTICAL);
		bar.setBackgroundColor(getColor(R.color.dsh_background));
		bar.setPadding(dp(14), 0, dp(6), 0);

		hostLabel = new TextView(this);
		hostLabel.setTextColor(getColor(R.color.dsh_text_dim));
		hostLabel.setTextSize(13f);
		hostLabel.setSingleLine(true);
		hostLabel.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
		hostLabel.setOnClickListener(view -> showMenu(view));
		bar.addView(hostLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

		TextView menu = new TextView(this);
		menu.setText("⋮");
		menu.setTextColor(getColor(R.color.dsh_text));
		menu.setTextSize(20f);
		menu.setGravity(Gravity.CENTER);
		menu.setPadding(dp(12), dp(4), dp(12), dp(4));
		menu.setOnClickListener(this::showMenu);
		bar.addView(menu, new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
		return bar;
	}

	/**
	 * The WebView that carries the Harness UI.
	 *
	 * @return the web view.
	 */
	@SuppressLint("SetJavaScriptEnabled")
	private View buildWebView() {
		web = new WebView(this);
		web.setBackgroundColor(getColor(R.color.dsh_background));
		web.setOverScrollMode(View.OVER_SCROLL_NEVER);
		WebSettings settings = web.getSettings();
		settings.setJavaScriptEnabled(true);
		settings.setDomStorageEnabled(true);
		settings.setDatabaseEnabled(true);
		settings.setUseWideViewPort(true);
		settings.setLoadWithOverviewMode(true);
		settings.setSupportZoom(false);
		settings.setBuiltInZoomControls(false);
		settings.setDisplayZoomControls(false);
		settings.setMediaPlaybackRequiresUserGesture(false);
		// The settings the phone needs in every WebView of the session: the font
		// scale, the popup windows the login drives, mixed content, file and
		// content access, and the cookie jar. The login window gets the same set.
		applySessionSettings(web);
		settings.setAllowFileAccess(false);
		settings.setAllowContentAccess(true);
		settings.setCacheMode(WebSettings.LOAD_DEFAULT);
		CookieManager.getInstance().setAcceptCookie(true);
		CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

		web.setWebViewClient(new WebViewClient() {
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				// The Host's cookie, the pairing page and the account login all
				// live in this WebView's jar. Handing any of them to the browser
				// mints the session outside the app and leaves this one signed
				// out, which is the whole "the phone cannot log in" report.
				return handOff(request.getUrl());
			}

			@Override
			public void onPageFinished(WebView view, String url) {
				super.onPageFinished(view, url);
				if (pendingError == null) {
					hideError();
				} else {
					showError(pendingError);
				}
				Uri uri = Uri.parse(url);
				if (RuntimeStore.MODE_REMOTE.equals(RuntimeStore.mode(MainActivity.this))
					&& isLocal(uri) && !isPairingUrl(url)) {
					rememberHost(uri);
				}
			}

			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				super.onReceivedError(view, request, error);
				if (!request.isForMainFrame()) return;
				if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(MainActivity.this))) {
					pendingError = error.getDescription() == null ? "" : error.getDescription().toString();
					showError(pendingError);
					return;
				}
				pendingError = error.getDescription() == null ? "" : error.getDescription().toString();
				showError(pendingError);
			}

			@Override
			public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
				super.onReceivedHttpError(view, request, response);
				if (!request.isForMainFrame()) return;
				onSessionHttpError(request, response);
			}
		});

		web.setWebChromeClient(new WebChromeClient() {
			@Override
			public void onPermissionRequest(PermissionRequest request) {
				grantAudio(request);
			}

			@Override
			public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
				// The account login reserves a blank tab with window.open() and
				// then navigates it to the consent page. Without a window here the
				// call returns null, no login tab ever appears, and the attempt
				// sits until it expires. A window nobody tapped for is refused:
				// the WebView has no address bar to show what it covered.
				if (!isUserGesture) return false;
				return openPopupWindow(resultMsg);
			}

			@Override
			public void onCloseWindow(WebView window) {
				super.onCloseWindow(window);
				// The login closes its own tab once the Host reports success.
				closePopup(window);
			}

			@Override
			public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
				if (fileCallback != null) fileCallback.onReceiveValue(null);
				fileCallback = callback;
				try {
					startActivityForResult(params.createIntent(), REQUEST_FILE);
				} catch (Exception failure) {
					fileCallback = null;
					return false;
				}
				return true;
			}
		});
		return web;
	}

	/**
	 * The remote-mode form: the address of the PC's host.
	 *
	 * @return the form.
	 */
	private View buildSetup() {
		LinearLayout panel = new LinearLayout(this);
		panel.setOrientation(LinearLayout.VERTICAL);
		panel.setBackgroundColor(getColor(R.color.dsh_background));
		panel.setPadding(dp(24), dp(40), dp(24), dp(24));
		panel.setVisibility(View.GONE);

		TextView title = new TextView(this);
		title.setText(R.string.setup_title);
		title.setTextColor(getColor(R.color.dsh_text));
		title.setTextSize(20f);
		title.setTypeface(null, android.graphics.Typeface.BOLD);
		panel.addView(title);

		TextView subtitle = new TextView(this);
		subtitle.setText(R.string.setup_subtitle);
		subtitle.setTextColor(getColor(R.color.dsh_text_dim));
		subtitle.setTextSize(14f);
		subtitle.setPadding(0, dp(8), 0, dp(20));
		panel.addView(subtitle);

		hostInput = new EditText(this);
		hostInput.setHint("192.168.0.166:3080");
		hostInput.setSingleLine(true);
		hostInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
		hostInput.setTextColor(getColor(R.color.dsh_text));
		hostInput.setHintTextColor(getColor(R.color.dsh_text_dim));
		panel.addView(hostInput, new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

		TextView label = new TextView(this);
		label.setText("ペアリングパス（既定: " + DEFAULT_PAIR_PATH + "）");
		label.setTextColor(getColor(R.color.dsh_text_dim));
		label.setTextSize(12f);
		label.setPadding(0, dp(12), 0, dp(4));
		panel.addView(label);

		pairPathInput = new EditText(this);
		pairPathInput.setText(DEFAULT_PAIR_PATH);
		pairPathInput.setSingleLine(true);
		pairPathInput.setTextColor(getColor(R.color.dsh_text));
		panel.addView(pairPathInput, new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

		Button connect = new Button(this);
		connect.setText(R.string.connect);
		connect.setTextColor(getColor(R.color.dsh_on_accent));
		connect.setBackgroundColor(getColor(R.color.dsh_accent));
		connect.setOnClickListener(view -> connectFromForm());
		LinearLayout.LayoutParams connectParams = new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
		connectParams.topMargin = dp(20);
		panel.addView(connect, connectParams);

		TextView hint = new TextView(this);
		hint.setText(R.string.setup_hint);
		hint.setTextColor(getColor(R.color.dsh_text_dim));
		hint.setTextSize(13f);
		hint.setPadding(0, dp(24), 0, 0);
		panel.addView(hint);

		setup = panel;
		return panel;
	}

	/**
	 * The standalone status card: what the Host is doing right now.
	 *
	 * @return the card.
	 */
	private View buildStatusCard() {
		LinearLayout panel = new LinearLayout(this);
		panel.setOrientation(LinearLayout.VERTICAL);
		panel.setGravity(Gravity.CENTER);
		panel.setBackgroundColor(getColor(R.color.dsh_background));
		panel.setPadding(dp(24), dp(24), dp(24), dp(24));
		panel.setVisibility(View.GONE);

		TextView title = new TextView(this);
		title.setText("スマホ上で DSH を起動しています");
		title.setTextColor(getColor(R.color.dsh_text));
		title.setTextSize(18f);
		title.setGravity(Gravity.CENTER);
		panel.addView(title);
		statusTitle = title;

		TextView body = new TextView(this);
		body.setTextColor(getColor(R.color.dsh_text_dim));
		body.setTextSize(13f);
		body.setGravity(Gravity.CENTER);
		body.setPadding(0, dp(12), 0, dp(18));
		panel.addView(body);
		statusText = body;

		Button permissions = new Button(this);
		permissions.setText("権限を確認する");
		permissions.setTextColor(getColor(R.color.dsh_text));
		permissions.setOnClickListener(view -> showPermissions());
		panel.addView(permissions);
		statusPermissions = permissions;

		Button retry = new Button(this);
		retry.setText("Host を起動し直す");
		retry.setTextColor(getColor(R.color.dsh_on_accent));
		retry.setBackgroundColor(getColor(R.color.dsh_accent));
		retry.setOnClickListener(view -> restartHost());
		panel.addView(retry);
		statusRetry = retry;

		statusCard = panel;
		return panel;
	}

	/**
	 * The card shown when the host cannot be reached.
	 *
	 * @return the card.
	 */
	private View buildError() {
		LinearLayout panel = new LinearLayout(this);
		panel.setOrientation(LinearLayout.VERTICAL);
		panel.setGravity(Gravity.CENTER);
		panel.setBackgroundColor(getColor(R.color.dsh_background));
		panel.setPadding(dp(24), dp(24), dp(24), dp(24));
		panel.setVisibility(View.GONE);

		TextView title = new TextView(this);
		title.setText(R.string.error_title);
		title.setTextColor(getColor(R.color.dsh_text));
		title.setTextSize(17f);
		title.setGravity(Gravity.CENTER);
		panel.addView(title);

		errorText = new TextView(this);
		errorText.setTextColor(getColor(R.color.dsh_text_dim));
		errorText.setTextSize(13f);
		errorText.setGravity(Gravity.CENTER);
		errorText.setPadding(0, dp(10), 0, dp(18));
		panel.addView(errorText);

		Button retry = new Button(this);
		retry.setText(R.string.retry);
		retry.setTextColor(getColor(R.color.dsh_on_accent));
		retry.setBackgroundColor(getColor(R.color.dsh_accent));
		retry.setOnClickListener(view -> {
			hideError();
			if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) {
				restartHost();
			} else {
				openHost(currentHost(), currentPairPath(), false);
			}
		});
		panel.addView(retry);
		Button rePair = new Button(this);
		rePair.setText(R.string.repair);
		rePair.setTextColor(getColor(R.color.dsh_text));
		rePair.setOnClickListener(view -> {
			hideError();
			openHost(currentHost(), currentPairPath(), true);
		});
		panel.addView(rePair);

		error = panel;
		return panel;
	}

	/**
	 * Enter the standalone mode: keep the Host running and show its UI.
	 */
	private void enterStandalone() {
		hostLabel.setText("このスマホで動作中");
		if (setup != null) setup.setVisibility(View.GONE);
		statusCard.setVisibility(View.VISIBLE);
		statusTitle.setText("スマホ上で DSH を起動しています");
		statusText.setText("ランタイムを確認しています…");
		statusRetry.setVisibility(View.GONE);
		statusPermissions.setVisibility(View.GONE);
		HostService.startHost(this);
		requestNotificationPermission();
		startPolling();
	}

	/**
	 * Enter the remote mode: the stored host, or the address form.
	 */
	private void enterRemote() {
		if (statusCard != null) statusCard.setVisibility(View.GONE);
		String host = currentHost();
		if (host.isEmpty()) {
			if (setup != null) setup.setVisibility(View.VISIBLE);
			hostLabel.setText("PC のホストに接続");
			return;
		}
		openHost(host, currentPairPath(), false);
	}

	/**
	 * Start polling the Host status.
	 */
	private void startPolling() {
		poller.removeCallbacks(pollTask);
		poller.post(pollTask);
	}

	/**
	 * Reflect the service state on the status card, and load the UI once the
	 * server is listening.
	 */
	private void pollHost() {
		if (!RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) return;
		HostService.State state = HostService.state();
		String message = HostService.message();
		String url = HostService.url();

		switch (state) {
			case READY: {
				if (statusCard != null) statusCard.setVisibility(View.GONE);
				if (!url.isEmpty() && !url.equals(loadedUrl)) {
					loadedUrl = url;
					pendingError = null;
					hideError();
					web.loadUrl(url);
				}
				hostLabel.setText("このスマホで動作中 · " + workspaceLabel());
				break;
			}
			case FAILED: {
				statusCard.setVisibility(View.VISIBLE);
				statusTitle.setText("Host を起動できませんでした");
				statusText.setText(HostService.failure().isEmpty() ? message : HostService.failure());
				statusRetry.setVisibility(View.VISIBLE);
				statusPermissions.setVisibility(View.VISIBLE);
				break;
			}
			case INSTALLING:
			case STARTING: {
				statusCard.setVisibility(View.VISIBLE);
				statusTitle.setText(state == HostService.State.INSTALLING
					? "ランタイムを準備しています"
					: "Host を起動しています");
				statusText.setText(message);
				statusRetry.setVisibility(View.GONE);
				statusPermissions.setVisibility(View.GONE);
				break;
			}
			default: {
				statusCard.setVisibility(View.VISIBLE);
				statusTitle.setText("待機中");
				statusText.setText("Host を起動しています…");
				break;
			}
		}
		poller.postDelayed(pollTask, POLL_MS);
	}

	/**
	 * The workspace the agent sees, as a short label.
	 *
	 * @return the label.
	 */
	private String workspaceLabel() {
		// The bar has room for a name, not for a path: the full path pushed the
		// state text off the right edge of a phone.
		String name = RuntimeStore.workspaceDir(this).getName();
		return name == null || name.isEmpty() ? RuntimeStore.workspaceDir(this).getAbsolutePath() : name;
	}

	/**
	 * Refresh the bar label once the workspace is known.
	 */
	private void refreshWorkspaceLabel() {
		if (HostService.state() == HostService.State.READY) {
			hostLabel.setText("このスマホで動作中 · " + workspaceLabel());
		}
	}

	/**
	 * Restart the Host after a failure.
	 */
	private void restartHost() {
		loadedUrl = "";
		statusRetry.setVisibility(View.GONE);
		statusText.setText("再起動しています…");
		HostService.stopHost(this);
		poller.postDelayed(() -> {
			HostService.startHost(this);
			startPolling();
		}, 600);
	}

	/**
	 * Ask for the notification permission the foreground service needs.
	 */
	private void requestNotificationPermission() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
		if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
		requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQUEST_NOTIFICATIONS);
	}

	/**
	 * Explain and open the two settings the standalone mode works best with.
	 */
	private void showPermissions() {
		boolean files = RuntimeStore.hasAllFilesAccess(this);
		boolean phone = PhoneUseService.isRunning();
		StringBuilder text = new StringBuilder();
		text.append("・ファイルアクセス: ").append(files ? "許可済み" : "未許可").append('\n')
			.append("  許可すると /sdcard/DSH を作業場所にします。\n")
			.append("・スマホ操作（ユーザー補助）: ").append(phone ? "有効" : "無効").append('\n')
			.append("  有効にすると、エージェントが画面を見てタップ・入力できます。\n");

		new AlertDialog.Builder(this)
			.setTitle("権限")
			.setMessage(text.toString())
			.setPositiveButton("ファイルアクセス", (dialog, which) -> openAllFilesSettings())
			.setNeutralButton("スマホ操作", (dialog, which) -> openAccessibilitySettings())
			.setNegativeButton("閉じる", null)
			.show();
	}

	/**
	 * Open the "all files access" page for this app.
	 */
	private void openAllFilesSettings() {
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
				Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
					Uri.parse("package:" + getPackageName()));
				startActivity(intent);
			} else {
				requestPermissions(new String[] {
					Manifest.permission.READ_EXTERNAL_STORAGE,
					Manifest.permission.WRITE_EXTERNAL_STORAGE,
				}, REQUEST_NOTIFICATIONS);
			}
		} catch (Exception missing) {
			startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
		}
	}

	/**
	 * Open the accessibility settings page, where the service is enabled.
	 */
	private void openAccessibilitySettings() {
		try {
			startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
			Toast.makeText(this, "「DSH Mobile スマホ操作」を有効にしてください", Toast.LENGTH_LONG).show();
		} catch (Exception missing) {
			Toast.makeText(this, "設定を開けませんでした", Toast.LENGTH_SHORT).show();
		}
	}

	/**
	 * Take the address from the form, remember it and open the pairing page.
	 */
	private void connectFromForm() {
		String host = normalizeHost(hostInput.getText().toString());
		if (host == null) {
			Toast.makeText(this, "アドレスの形式が違います", Toast.LENGTH_LONG).show();
			return;
		}
		String pairPath = normalizePairPath(pairPathInput.getText().toString());
		save(host, pairPath);
		openHost(host, pairPath, true);
	}

	/**
	 * Open the host: the pairing page the first time, the app afterwards.
	 *
	 * @param host - the host origin.
	 * @param pairPath - the path of the pairing page.
	 * @param pairing - whether the pairing page is the target.
	 */
	private void openHost(String host, String pairPath, boolean pairing) {
		hostLabel.setText(host);
		pendingError = null;
		hideError();
		if (setup != null) setup.setVisibility(View.GONE);
		String target = pairing ? host + pairPath : host + "/";
		loadedUrl = target;
		web.loadUrl(target);
	}

	/**
	 * Remember the host once the app itself is on screen.
	 *
	 * @param uri - the address of the app.
	 */
	private void rememberHost(Uri uri) {
		String host = origin(uri);
		if (host == null) return;
		if (!host.equals(currentHost())) save(host, currentPairPath());
		hostLabel.setText(host);
	}

	/**
	 * Report the things that decide whether the phone can sign in.
	 *
	 * "It cannot log in" is nearly always one of these: the Host is not
	 * listening, the Host keeps its home somewhere else, or no account
	 * credentials were ever written. The phone can answer all three itself, so
	 * the user does not need the PC to find out which one it is.
	 */
	private void showDiagnostics() {
		String mode = RuntimeStore.mode(this);
		boolean standalone = RuntimeStore.MODE_STANDALONE.equals(mode);
		StringBuilder report = new StringBuilder();
		report.append("モード: ").append(standalone ? "単体" : "PC のホスト").append('\n');
		report.append("Host: ").append(standalone ? HostService.state().name() : (currentHost().isEmpty() ? "未設定" : currentHost())).append('\n');
		report.append("作業フォルダ: ").append(workspaceLabel()).append('\n');
		report.append("DSH ホーム: ").append(RuntimeStore.homeDir(this).getAbsolutePath()).append('\n');
		report.append("アカウント: ").append(accountState()).append('\n');
		if (!standalone) {
			report.append("アカウントログインはスマホ単体モードでのみ完了できます。");
		}
		new AlertDialog.Builder(this)
			.setTitle(R.string.menu_diagnostics)
			.setMessage(report.toString())
			.setPositiveButton(android.R.string.ok, null)
			.show();
	}

	/**
	 * Whether the phone holds the account credentials the Harness writes.
	 * @returns a line for the diagnostics card.
	 */
	private String accountState() {
		// Only the presence is reported: the file itself is the secret.
		return new File(RuntimeStore.homeDir(this), ".credentials.yaml").isFile()
			? "ログイン済み (.credentials.yaml あり)"
			: "未ログイン (.credentials.yaml なし)";
	}

	/**
	 * The menu of the bar.
	 *
	 * @param anchor - the view the menu drops from.
	 */
	private void showMenu(View anchor) {
		PopupMenu menu = new PopupMenu(this, anchor);
		menu.getMenu().add(0, 1, 0, "このスマホで動かす（単体モード）");
		menu.getMenu().add(0, 2, 1, "権限");
		menu.getMenu().add(0, 3, 2, "スマホ操作を有効にする");
		menu.getMenu().add(0, 4, 3, R.string.menu_reload);
		menu.getMenu().add(0, 5, 4, "状態");
		menu.getMenu().add(0, 6, 5, "Host を再起動");
		menu.getMenu().add(0, 7, 6, "作業フォルダ");
		menu.getMenu().add(0, 8, 7, "ランタイムを削除");
		menu.getMenu().add(0, 9, 8, R.string.menu_about);
		menu.getMenu().add(0, 10, 9, "PC のホストに接続する（リモート）");
		menu.getMenu().add(0, 11, 10, R.string.menu_local_host);
		menu.getMenu().add(0, 12, 11, R.string.menu_diagnostics);
		menu.setOnMenuItemClickListener(item -> {
			switch (item.getItemId()) {
				case 1: setModeAndRestart(RuntimeStore.MODE_STANDALONE); return true;
				case 2: showPermissions(); return true;
				case 3: openAccessibilitySettings(); return true;
				case 4: web.reload(); return true;
				case 5: showState(); return true;
				case 6: restartHost(); return true;
				case 7: showWorkspace(); return true;
				case 8: confirmUninstall(); return true;
				case 9: showAbout(); return true;
				case 10: setModeAndRestart(RuntimeStore.MODE_REMOTE); return true;
				case 11: launchLocalHost(); return true;
				case 12: showDiagnostics(); return true;
				default: return false;
			}
		});
		menu.show();
	}

	/**
	 * Switch mode and rebuild the screen for it.
	 *
	 * @param mode - the mode to select.
	 */
	private void setModeAndRestart(String mode) {
		RuntimeStore.setMode(this, mode);
		if (RuntimeStore.MODE_REMOTE.equals(mode)) {
			HostService.stopHost(this);
			statusCard.setVisibility(View.GONE);
			enterRemote();
			return;
		}
		HostService.stopHost(this);
		loadedUrl = "";
		enterStandalone();
	}

	/**
	 * Show what the page thinks of the link.
	 */
	private void showState() {
		web.evaluateJavascript(
			"(function(){var f=window.__DSH_MOBILE_STATE__;return f?JSON.stringify(f()):'null';})()",
			value -> {
				String text = value == null ? "不明" : value;
				if (text.length() > 1 && text.startsWith("\"") && text.endsWith("\"")) {
					text = text.substring(1, text.length() - 1);
				}
				StringBuilder body = new StringBuilder();
				body.append("モード: ").append(RuntimeStore.mode(this)).append('\n')
					.append("Host: ").append(HostService.state()).append(' ').append(HostService.message()).append('\n')
					.append("作業フォルダ: ").append(workspaceLabel()).append('\n')
					.append("スマホ操作: ").append(PhoneUseService.isRunning() ? "有効" : "無効").append('\n')
					.append("ランタイム: ").append(RuntimeStore.installedVersion(this)).append('\n')
					.append("ページ: ").append(text);
				new AlertDialog.Builder(this)
					.setTitle("状態")
					.setMessage(body.toString())
					.setPositiveButton("閉じる", null)
					.show();
			});
	}

	/**
	 * Show the workspace path and offer to copy it.
	 */
	private void showWorkspace() {
		String path = workspaceLabel();
		new AlertDialog.Builder(this)
			.setTitle("作業フォルダ")
			.setMessage(path + "\n\nエージェントのファイルツールはこのフォルダを起点に動きます。")
			.setPositiveButton("閉じる", null)
			.show();
	}

	/**
	 * Remove the installed runtime, so the next start downloads it again.
	 */
	private void confirmUninstall() {
		new AlertDialog.Builder(this)
			.setTitle("ランタイムを削除")
			.setMessage("スマホ上の Node と DSH のファイルを削除します。会話と設定（ホーム）は残ります。")
			.setPositiveButton("削除", (dialog, which) -> {
				HostService.stopHost(this);
				RuntimeStore.uninstall(this);
				loadedUrl = "";
				statusText.setText("次回起動時にダウンロードします");
				HostService.startHost(this);
			})
			.setNegativeButton("キャンセル", null)
			.show();
	}

	/**
	 * What this app is.
	 */
	private void showAbout() {
		new AlertDialog.Builder(this)
			.setTitle(R.string.app_name)
			.setMessage("DeepSeek Harness をスマホ単体で動かすアプリです。\n"
				+ "このモードでは、スマホの中の Node が DSH の Host として動き、"
				+ "同じ DSH の Web UI を WebView で開きます。\n"
				+ "PC の Host に接続する使い方も残しています（メニューから切り替え）。")
			.setPositiveButton("閉じる", null)
			.show();
	}

	/**
	 * Launch a DSH host inside Termux, then point the app at it.
	 *
	 * This is the fallback for a phone where the bundled runtime cannot start
	 * (an unsupported Android version, a locked-down ROM): Termux brings its
	 * own Node, and its RUN_COMMAND intent starts `dsh web` in the background.
	 * Termux must be installed; if it is not, the user is sent to its install
	 * page.
	 */
	private void launchLocalHost() {
		// Termux's RUN_COMMAND intent runs a command in the background.
		Intent termux = new Intent();
		termux.setClassName("com.termux", "com.termux.app.RunCommandService");
		termux.setAction("com.termux.RUN_COMMAND");
		termux.putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/dsh");
		termux.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"web", "--host", "127.0.0.1", "--port", "3080"});
		termux.putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home");
		try {
			startService(termux);
		} catch (Exception failure) {
			// Termux is not installed (or refused); open its install page.
			try {
				startActivity(new Intent(Intent.ACTION_VIEW,
					Uri.parse("https://f-droid.org/packages/com.termux/")));
			} catch (Exception ignored) { }
			Toast.makeText(this, "Termux が必要です。インストール後に再試行してください。", Toast.LENGTH_LONG).show();
			return;
		}
		// Point the app at the local host and persist it.
		getSharedPreferences(PREFS, MODE_PRIVATE).edit()
			.putString(KEY_HOST, "127.0.0.1:3080")
			.putString(KEY_PAIR_PATH, DEFAULT_PAIR_PATH)
			.apply();
		Toast.makeText(this, "ローカルホストを起動しました。接続中...", Toast.LENGTH_SHORT).show();
		openHost("127.0.0.1:3080", DEFAULT_PAIR_PATH, false);
	}

	/**
	 * Open a link that leaves the app in the system browser.
	 *
	 * @param uri - the target.
	 */
	private void openExternally(Uri uri) {
		leftForBrowser = true;
		try {
			startActivity(new Intent(Intent.ACTION_VIEW, uri));
		} catch (Exception failure) {
			leftForBrowser = false;
			Toast.makeText(this, "リンクを開けませんでした", Toast.LENGTH_SHORT).show();
		}
	}

	/**
	 * Apply the settings that decide whether a WebView belongs to this session.
	 *
	 * The app's WebView and the login window share one cookie jar, so they have
	 * to share this set: the font scale, the multiple windows the login opens,
	 * the mixed-content policy, file and content access, and the cookies an
	 * embedded login frame needs.
	 *
	 * @param view - the WebView to configure.
	 */
	private void applySessionSettings(WebView view) {
		WebSettings settings = view.getSettings();
		settings.setJavaScriptEnabled(true);
		settings.setDomStorageEnabled(true);
		settings.setDatabaseEnabled(true);
		settings.setUseWideViewPort(true);
		settings.setLoadWithOverviewMode(true);
		settings.setSupportZoom(false);
		settings.setBuiltInZoomControls(false);
		settings.setDisplayZoomControls(false);
		settings.setMediaPlaybackRequiresUserGesture(false);
		// The system font scale is not the app's to change, but the Harness UI
		// is: at 1.3x its layout reflows into a shape the phone cannot use.
		settings.setTextZoom(100);
		// The account login reserves a blank tab with window.open() and then
		// navigates it to the consent page. A WebView without multiple windows
		// returns null there, the login tab never appears, and the attempt
		// expires after ten minutes - which reads as "the phone cannot log in".
		settings.setSupportMultipleWindows(true);
		settings.setJavaScriptCanOpenWindowsAutomatically(true);
		// The Host is served over the scheme the page itself uses, so nothing
		// legitimate here is mixed content.
		settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
		settings.setAllowFileAccess(false);
		settings.setAllowContentAccess(false);
		settings.setCacheMode(WebSettings.LOAD_DEFAULT);
		CookieManager.getInstance().setAcceptCookie(true);
		CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
	}

	/**
	 * The client a page of this session navigates with.
	 *
	 * The login window shares the cookie jar, so it has to share the rules too:
	 * one allow list decides what opens inside, and one handler notices when the
	 * Host dropped the session.
	 *
	 * @returns the client.
	 */
	private WebViewClient sessionClient() {
		return new WebViewClient() {
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				return handOff(request.getUrl());
			}

			@Override
			public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
				super.onReceivedHttpError(view, request, response);
				onSessionHttpError(request, response);
			}
		};
	}

	/**
	 * Answer a 401/403 the Host sent to a page of this session.
	 *
	 * Both WebViews run on the same cookie, so both have to notice when it is
	 * gone; without this the login window sat on a blank page while the app
	 * behind it stayed signed out.
	 *
	 * @param request - the request that was answered.
	 * @param response - the response the Host sent.
	 */
	private void onSessionHttpError(WebResourceRequest request, WebResourceResponse response) {
		if (!request.isForMainFrame()) return;
		if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) return;
		int status = response.getStatusCode();
		if (status != 401 && status != 403) return;
		if (isPairingUrl(request.getUrl().toString())) return;
		pendingError = getString(R.string.error_auth);
		showError(pendingError);
		// The cookie is gone and only the pairing page can mint a new one, so the
		// phone is sent there instead of being left on a 401 screen.
		loseSession();
	}

	/**
	 * Open the window a page asked for with window.open().
	 *
	 * The account login reserves a blank tab and then navigates it to the
	 * consent page, so this has to be a visible WebView that shares this app's
	 * cookie jar: the callback has to land on a page the app can go on using. A
	 * null here is why "log in" did nothing on the phone until the attempt
	 * expired ten minutes later.
	 *
	 * @param resultMsg - the transport message the page's WebView handed over.
	 * @return true when the window was created.
	 */
	private boolean openPopupWindow(Message resultMsg) {
		if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) return false;
		// A second window.open() replaces the first: leaving the old one up
		// would leak a WebView - and its share of the cookie jar - per click.
		// The close is deferred because this call can run on the popup itself.
		if (popupWeb != null) closePopupSoon(popupWeb);
		WebView popup = new WebView(this);
		// The login window runs on the same cookie jar as the app, so it gets the
		// same settings and the same navigation rules.
		applySessionSettings(popup);
		popup.setBackgroundColor(getColor(R.color.dsh_background));
		popup.setWebViewClient(sessionClient());
		popup.setWebChromeClient(new WebChromeClient() {
			@Override
			public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message message) {
				// A window nobody asked for would let a page cover the app.
				return isUserGesture && openPopupWindow(message);
			}
		});
		Dialog dialog = new Dialog(this);
		dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
		dialog.setContentView(popup);
		dialog.setOnDismissListener(dismissed -> {
			if (popupWeb != null) {
				popupWeb.destroy();
				popupWeb = null;
			}
			popupDialog = null;
		});
		popupWeb = popup;
		popupDialog = dialog;
		boolean shown = true;
		try {
			dialog.show();
			Window window = dialog.getWindow();
			if (window != null) window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
		} catch (Exception gone) {
			// Showing a window from an activity that is already going away throws.
			// The page still needs its transport answered, and the login is best
			// continued in the app's own WebView.
			shown = false;
			Log.w("DshMobile", "popup: cannot show the login window: " + gone.getMessage());
		}
		WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
		if (shown) {
			transport.setWebView(popup);
		} else {
			closePopup(popup);
			transport.setWebView(web);
		}
		resultMsg.sendToTarget();
		return true;
	}

	/**
	 * Close the window a page opened for itself.
	 *
	 * `null` closes whatever is open, which is what the activity's own teardown
	 * needs: a dialog outlives the activity it was shown from and takes its
	 * WebView, its renderer and the cookie jar with it.
	 * @param window - the WebView the page asked to close, or null for any.
	 */
	private void closePopup(WebView window) {
		if (window != null && window != popupWeb) {
			// onCloseWindow can arrive again after the dialog took the WebView
			// down; destroying a dead WebView throws, and it is already gone.
			return;
		}
		if (popupDialog != null) {
			// Dismissing runs the dialog's listener, which destroys the WebView.
			popupDialog.dismiss();
			return;
		}
		if (popupWeb != null) {
			popupWeb.destroy();
			popupWeb = null;
		}
	}

	/**
	 * Close a window once the callback that is running has returned.
	 *
	 * The popup's own onCreateWindow runs on the WebView that a close would
	 * destroy, so closing it there tears down the object the callback is still
	 * using.
	 * @param previous - the window to close.
	 */
	private void closePopupSoon(WebView previous) {
		View anchor = web;
		if (anchor == null) {
			closePopup(previous);
			return;
		}
		anchor.post(() -> closePopup(previous));
	}

	/**
	 * Decide whether a navigation is taken over by another app.
	 *
	 * The WebView has no address bar, so a page that opens here sits next to the
	 * Host's cookie - and, because a page may open windows, could raise a
	 * full-screen window of its own. An http(s) address is therefore not
	 * trusted just for being http(s): only the Host, its loopback and the
	 * account login the Harness drives stay inside, and everything else - plus
	 * every non-web scheme - belongs to another app.
	 *
	 * @param uri - the address the page is navigating to.
	 * @return true when the navigation was handed to another app.
	 */
	private boolean handOff(Uri uri) {
		if (uri == null) return false;
		String scheme = uri.getScheme();
		if (scheme == null) return false;
		// The blank document window.open("about:blank") reserves is not a link
		// to anywhere: sending it to another app would drop the login's tab.
		if ("about".equalsIgnoreCase(scheme) || "blob".equalsIgnoreCase(scheme)
			|| "data".equalsIgnoreCase(scheme) || "javascript".equalsIgnoreCase(scheme)) return false;
		if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
			openExternally(uri);
			return true;
		}
		if (staysInApp(uri)) return false;
		openExternally(uri);
		return true;
	}

	/**
	 * Whether an http(s) address belongs to this session.
	 *
	 * The list is short on purpose: the Host itself (any port on the same host
	 * name, and the loopback the account login calls back to) and the account
	 * domain that login goes through. Everything here shares the cookie jar.
	 *
	 * @param uri - the address the page asked for.
	 * @return true to open it in this WebView.
	 */
	private boolean staysInApp(Uri uri) {
		String host = uri.getHost();
		if (host == null) return false;
		if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
		// The loopback is only this Host's loopback: every other service on the
		// phone listens there too, and this WebView carries the Host's cookie.
		if ("localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host) || "::1".equals(host)) return isHostPort(uri.getPort());
		if (isLocal(uri)) return true;
		String bare = host.toLowerCase(java.util.Locale.ROOT);
		return "deepseek.com".equals(bare) || bare.endsWith(".deepseek.com");
	}

	/**
	 * Whether a port is the one this Host listens on.
	 *
	 * The login returns to `http://127.0.0.1:<port>/oauth/callback`, and only
	 * that port is the Host; anything else on the loopback belongs to some other
	 * app's service and has no business sharing this cookie jar.
	 *
	 * @param port - the port of the address, or -1 when it carries none.
	 * @returns true when it is the Host's own port.
	 */
	private boolean isHostPort(int port) {
		if (port <= 0) return false;
		String known = currentHost();
		if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) {
			String local = HostService.url();
			if (local != null && !local.isEmpty()) known = local;
		}
		if (known.isEmpty()) return false;
		int expected = Uri.parse(known).getPort();
		if (expected <= 0) expected = DEFAULT_PORT;
		return port == expected;
	}

	/**
	 * Send the phone back to the pairing page after the Host dropped its cookie.
	 *
	 * The pairing page answers without a cookie, so this cannot loop; the
	 * throttle is only there for a Host that answers 401 to everything.
	 */
	private void loseSession() {
		if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) return;
		String host = currentHost();
		if (host.isEmpty()) return;
		long now = System.currentTimeMillis();
		if (now - lastSessionLoss < AUTH_RETRY_MS) return;
		lastSessionLoss = now;
		Toast.makeText(this, R.string.need_pairing, Toast.LENGTH_LONG).show();
		openHost(host, currentPairPath(), true);
	}

	/**
	 * Show the card that says the host is out of reach.
	 *
	 * @param detail - what went wrong.
	 */
	private void showError(String detail) {
		if (errorText != null) {
			String target = RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))
				? "このスマホの Host"
				: currentHost();
			errorText.setText(target + "\n" + detail);
		}
		if (error != null) error.setVisibility(View.VISIBLE);
	}

	/**
	 * Hide the error card.
	 */
	private void hideError() {
		if (error != null) error.setVisibility(View.GONE);
	}

	@Override
	protected void onActivityResult(int requestCode, int resultCode, Intent data) {
		super.onActivityResult(requestCode, resultCode, data);
		if (requestCode != REQUEST_FILE) return;
		if (fileCallback == null) return;
		Uri[] result = null;
		if (resultCode == RESULT_OK && data != null) {
			result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
		}
		fileCallback.onReceiveValue(result);
		fileCallback = null;
	}

	@Override
	public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
		super.onRequestPermissionsResult(requestCode, permissions, results);
		if (requestCode != REQUEST_AUDIO) return;
		if (pendingAudio == null) return;
		boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
		pendingAudio.grant(granted ? pendingAudio.getResources() : new String[0]);
		pendingAudio = null;
	}

	/**
	 * Allow the page to use the microphone, asking for the permission first.
	 *
	 * @param request - the request of the page.
	 */
	private void grantAudio(PermissionRequest request) {
		boolean wantsAudio = false;
		for (String resource : request.getResources()) {
			if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
		}
		if (!wantsAudio) {
			request.deny();
			return;
		}
		if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
			request.grant(request.getResources());
			return;
		}
		pendingAudio = request;
		requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_AUDIO);
	}

	@Override
	public void onBackPressed() {
		if (web != null && web.canGoBack()) {
			web.goBack();
			return;
		}
		super.onBackPressed();
	}

	/**
	 * The stored host origin.
	 *
	 * @return the origin, or an empty string.
	 */
	private String currentHost() {
		return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_HOST, "");
	}

	/**
	 * The stored pairing path.
	 *
	 * @return the path.
	 */
	private String currentPairPath() {
		return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_PAIR_PATH, DEFAULT_PAIR_PATH);
	}

	/**
	 * Remember the host and the pairing path.
	 *
	 * @param host - the origin.
	 * @param pairPath - the path.
	 */
	private void save(String host, String pairPath) {
		getSharedPreferences(PREFS, MODE_PRIVATE).edit()
			.putString(KEY_HOST, host)
			.putString(KEY_PAIR_PATH, pairPath)
			.apply();
		hostLabel.setText(host);
	}

	/**
	 * Whether an address belongs to the configured host.
	 *
	 * @param uri - the address.
	 * @return the answer.
	 */
	private boolean isLocal(Uri uri) {
		if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) {
			String url = HostService.url();
			return url != null && !url.isEmpty() && origin(uri) != null
				&& origin(uri).equals(origin(Uri.parse(url)));
		}
		String host = currentHost();
		if (host.isEmpty()) return false;
		// The Host may answer on a second port (a TLS front end, a tunnel), so
		// the host name, not the whole origin, is what makes an address "this
		// Host" - the origin-only test sent the phone's own app to the browser.
		return host.equals(origin(uri)) || sameHostName(host, uri);
	}

	/**
	 * Whether an address is the pairing page.
	 *
	 * @param url - the address.
	 * @return the answer.
	 */
	private boolean isPairingUrl(String url) {
		if (url == null) return false;
		// The path, not the whole URL: a query string that happens to carry the
		// pairing path is not the pairing page.
		String path = Uri.parse(url).getPath();
		if (path == null) return false;
		String pairPath = currentPairPath();
		return path.equals(pairPath) || path.startsWith(pairPath + "/");
	}

	/**
	 * The origin of an address, without the path.
	 *
	 * @param uri - the address.
	 * @return the origin, or null.
	 */
	private static String origin(Uri uri) {
		if (uri == null) return null;
		String scheme = uri.getScheme();
		String host = uri.getHost();
		if (scheme == null || host == null) return null;
		StringBuilder origin = new StringBuilder(scheme).append("://").append(host);
		if (uri.getPort() > 0) origin.append(':').append(uri.getPort());
		return origin.toString();
	}

	/**
	 * Whether an address names the same machine as an origin, whatever the port.
	 * @param reference - an origin, e.g. `http://192.168.0.166:3080`.
	 * @param uri - the address to compare.
	 * @return true when the two host names match.
	 */
	private static boolean sameHostName(String reference, Uri uri) {
		if (reference == null || uri == null) return false;
		String left = Uri.parse(reference).getHost();
		String right = uri.getHost();
		return left != null && left.equalsIgnoreCase(right);
	}

	/**
	 * The port of an address, with the Host's default filled in.
	 *
	 * The user types `192.168.0.166` far more often than not, and an origin
	 * without a port never matches the address the WebView then loads, which
	 * made a correctly typed host look like someone else's machine.
	 *
	 * @param scheme - the scheme of the address.
	 * @param port - the port as parsed, or -1 when the address carries none.
	 * @return the port to print, or -1 to leave it out (the scheme's own).
	 */
	private static int portOrDefault(String scheme, int port) {
		if (port > 0) return port;
		return "http".equalsIgnoreCase(scheme) ? DEFAULT_PORT : -1;
	}

	/**
	 * Turn what the user typed into a host origin.
	 *
	 * @param input - the text of the field.
	 * @return the origin, or null when the text is not an address.
	 */
	private static String normalizeHost(String input) {
		String text = input.trim();
		if (text.isEmpty()) return null;
		if (!text.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) text = DEFAULT_SCHEME + "://" + text;
		Uri uri = Uri.parse(text);
		String host = uri.getHost();
		if (host == null || host.isEmpty()) return null;
		String scheme = uri.getScheme() == null ? DEFAULT_SCHEME : uri.getScheme();
		StringBuilder origin = new StringBuilder(scheme).append("://").append(host);
		int port = portOrDefault(scheme, uri.getPort());
		if (port > 0) origin.append(':').append(port);
		return origin.toString();
	}

	/**
	 * Turn what the user typed into a pairing path.
	 *
	 * @param input - the text of the field.
	 * @return the path, always starting with a slash.
	 */
	private static String normalizePairPath(String input) {
		String text = input.trim();
		if (text.isEmpty()) return DEFAULT_PAIR_PATH;
		if (!text.startsWith("/")) text = "/" + text;
		while (text.endsWith("/") && text.length() > 1) text = text.substring(0, text.length() - 1);
		return text;
	}

	/**
	 * Density independent pixels.
	 *
	 * @param value - the size in dp.
	 * @return the size in pixels.
	 */
	private int dp(int value) {
		return Math.round(value * getResources().getDisplayMetrics().density);
	}
}
