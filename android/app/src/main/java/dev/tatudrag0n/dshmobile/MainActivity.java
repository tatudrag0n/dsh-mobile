package dev.tatudrag0n.dshmobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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
	/** The request code of the file chooser. */
	private static final int REQUEST_FILE = 1001;
	/** The request code of the microphone permission. */
	private static final int REQUEST_AUDIO = 1002;
	/** The request code of the notification permission. */
	private static final int REQUEST_NOTIFICATIONS = 1003;
	/** How often the standalone status card is refreshed. */
	private static final long POLL_MS = 500;

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
		if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(this))) {
			startPolling();
			refreshWorkspaceLabel();
		}
	}

	@Override
	protected void onPause() {
		super.onPause();
		poller.removeCallbacks(pollTask);
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
		settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
		settings.setAllowFileAccess(false);
		settings.setAllowContentAccess(true);
		settings.setCacheMode(WebSettings.LOAD_DEFAULT);
		CookieManager.getInstance().setAcceptCookie(true);
		CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

		web.setWebViewClient(new WebViewClient() {
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				Uri uri = request.getUrl();
				if (isLocal(uri)) return false;
				openExternally(uri);
				return true;
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
				if (RuntimeStore.MODE_STANDALONE.equals(RuntimeStore.mode(MainActivity.this))) return;
				int status = response.getStatusCode();
				if (status != 401 && status != 403) return;
				if (isPairingUrl(request.getUrl().toString())) return;
				pendingError = getString(R.string.error_auth);
				showError(pendingError);
			}
		});

		web.setWebChromeClient(new WebChromeClient() {
			@Override
			public void onPermissionRequest(PermissionRequest request) {
				grantAudio(request);
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
		return RuntimeStore.workspaceDir(this).getAbsolutePath();
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
		try {
			startActivity(new Intent(Intent.ACTION_VIEW, uri));
		} catch (Exception failure) {
			Toast.makeText(this, "リンクを開けませんでした", Toast.LENGTH_SHORT).show();
		}
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
		return host.equals(origin(uri));
	}

	/**
	 * Whether an address is the pairing page.
	 *
	 * @param url - the address.
	 * @return the answer.
	 */
	private boolean isPairingUrl(String url) {
		return url != null && url.contains(currentPairPath());
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
	 * Turn what the user typed into a host origin.
	 *
	 * @param input - the text of the field.
	 * @return the origin, or null when the text is not an address.
	 */
	private static String normalizeHost(String input) {
		String text = input.trim();
		if (text.isEmpty()) return null;
		if (!text.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) text = "http://" + text;
		Uri uri = Uri.parse(text);
		String host = uri.getHost();
		if (host == null || host.isEmpty()) return null;
		StringBuilder origin = new StringBuilder("http://").append(host);
		if (uri.getPort() > 0) origin.append(':').append(uri.getPort());
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
