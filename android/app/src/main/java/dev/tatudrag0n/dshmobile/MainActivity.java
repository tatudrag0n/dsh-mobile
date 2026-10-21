package dev.tatudrag0n.dshmobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceRequest;
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
 * The app is a native shell around the very same Web UI the PC uses: the
 * phone talks to the PC's DSH Host directly, so there is no server side of
 * its own and no state beyond the host address. Because both clients sit on
 * one Host, the conversation on the phone and the conversation on the PC are
 * the same conversation - that is what "auto sync" means here.
 *
 * The first launch asks for the host address and then hands the pairing page
 * to the WebView, where the PIN the PC printed is typed. The Host answers
 * that with a signed cookie, and from then on the app reopens the host root
 * with nothing but the cookie.
 */
public class MainActivity extends Activity {

	/** Where the host address and the pairing path are remembered. */
	private static final String PREFS = "dsh-mobile";
	private static final String KEY_HOST = "host";
	private static final String KEY_PAIR_PATH = "pairPath";
	/** The pairing path the plugin uses unless it is configured otherwise. */
	private static final String DEFAULT_PAIR_PATH = "/mobile";
	/** The request code of the file chooser. */
	private static final int REQUEST_FILE = 1001;
	/** The request code of the microphone permission. */
	private static final int REQUEST_AUDIO = 1002;

	private WebView web;
	private TextView hostLabel;
	private View setup;
	private View error;
	private String pendingError;
	private TextView errorText;
	private EditText hostInput;
	private EditText pairPathInput;
	private ValueCallback<Uri[]> fileCallback;
	private PermissionRequest pendingAudio;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		setContentView(buildLayout());
		SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
		String host = prefs.getString(KEY_HOST, "");
		if (host.isEmpty()) {
			showSetup();
		} else {
			openHost(host, prefs.getString(KEY_PAIR_PATH, DEFAULT_PAIR_PATH), false);
		}
	}

	/**
	 * Build the whole screen: a slim bar, the setup form, the web view and
	 * the error card, stacked on top of each other.
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
		content.addView(buildError(), new FrameLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		root.addView(content, new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
		return root;
	}

	/**
	 * The bar at the top: the host on the left, a menu on the right.
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
		hostLabel.setOnClickListener(view -> showHostDialog());
		bar.addView(hostLabel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

		TextView menu = new TextView(this);
		menu.setText("⋮");
		menu.setTextColor(getColor(R.color.dsh_text));
		menu.setTextSize(20f);
		menu.setGravity(Gravity.CENTER);
		menu.setPadding(dp(12), dp(4), dp(12), dp(4));
		menu.setOnClickListener(view -> showMenu(view));
		bar.addView(menu, new LinearLayout.LayoutParams(
			ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
		return bar;
	}

	/**
	 * The WebView that carries the Harness UI.
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
				// Leaving the pairing page means the PIN was accepted and the
				// Host handed out its session cookie.
				if (isLocal(uri) && !isPairingUrl(url)) {
					rememberHost(uri);
				}
			}

			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				super.onReceivedError(view, request, error);
				if (!request.isForMainFrame()) return;
				String description = error.getDescription() == null ? "" : error.getDescription().toString();
				pendingError = description;
				showError(description);
			}
			/**
			 * The host rejected the session (the token rotated after a restart).
			 * The DSH app answers with 401, so the phone would only show an empty
			 * page. Point the user at the pairing page instead.
			 * @param view - the web view.
			 * @param request - the request that failed.
			 * @param response - the response that failed.
			 */
			@Override
			public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
				super.onReceivedHttpError(view, request, response);
				if (!request.isForMainFrame()) return;
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
	 * The first-run form: the address of the PC's host.
	 * @return the form.
	 */
	private View buildSetup() {
		LinearLayout panel = new LinearLayout(this);
		panel.setOrientation(LinearLayout.VERTICAL);
		panel.setBackgroundColor(getColor(R.color.dsh_background));
		panel.setPadding(dp(24), dp(40), dp(24), dp(24));

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
	 * The card shown when the host cannot be reached.
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
			openHost(currentHost(), currentPairPath(), false);
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
		web.loadUrl(target);
	}

	/**
	 * Remember the host once the app itself is on screen.
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
	 * @param anchor - the view the menu drops from.
	 */
	private void showMenu(View anchor) {
		PopupMenu menu = new PopupMenu(this, anchor);
		menu.getMenu().add(0, 1, 0, R.string.menu_host);
		menu.getMenu().add(0, 2, 1, R.string.menu_reload);
		menu.getMenu().add(0, 3, 2, R.string.menu_state);
		menu.getMenu().add(0, 4, 3, R.string.menu_share);
		menu.getMenu().add(0, 5, 4, R.string.menu_reset);
		menu.getMenu().add(0, 6, 5, R.string.menu_about);
		menu.setOnMenuItemClickListener(item -> {
			int id = item.getItemId();
			if (id == 1) showHostDialog();
			else if (id == 2) web.reload();
			else if (id == 3) showState();
			else if (id == 4) shareHost();
			else if (id == 5) resetPairing();
			else if (id == 6) showAbout();
			return true;
		});
		menu.show();
	}

	/**
	 * Ask for the host address, and let it be changed.
	 */
	private void showHostDialog() {
		LinearLayout fields = new LinearLayout(this);
		fields.setOrientation(LinearLayout.VERTICAL);
		fields.setPadding(dp(24), dp(8), dp(24), 0);

		EditText host = new EditText(this);
		host.setText(currentHost());
		host.setSingleLine(true);
		host.setHint("192.168.0.166:3080");
		fields.addView(host);

		EditText pairPath = new EditText(this);
		pairPath.setText(currentPairPath());
		pairPath.setSingleLine(true);
		pairPath.setPadding(0, dp(12), 0, 0);
		fields.addView(pairPath);

		new AlertDialog.Builder(this)
			.setTitle(R.string.menu_host)
			.setView(fields)
			.setPositiveButton("接続", (dialog, which) -> {
				String target = normalizeHost(host.getText().toString());
				if (target == null) {
					Toast.makeText(this, "アドレスの形式が違います", Toast.LENGTH_LONG).show();
					return;
				}
				String path = normalizePairPath(pairPath.getText().toString());
				save(target, path);
				openHost(target, path, true);
			})
			.setNegativeButton("キャンセル", null)
			.show();
	}

	/**
	 * Show what the page thinks of the link to the PC.
	 */
	private void showState() {
		web.evaluateJavascript(
			"(function(){var f=window.__DSH_MOBILE_STATE__;return f?JSON.stringify(f()):'null';})()",
			value -> {
				String text = value == null ? "不明" : value;
				if (text.length() > 1 && text.startsWith("\"") && text.endsWith("\"")) {
					text = text.substring(1, text.length() - 1);
				}
				new AlertDialog.Builder(this)
					.setTitle(R.string.menu_state)
					.setMessage(text)
					.setPositiveButton("閉じる", null)
					.show();
			});
	}

	/**
	 * Share the address of the host, so it can be typed on another phone.
	 */
	private void shareHost() {
		Intent share = new Intent(Intent.ACTION_SEND);
		share.setType("text/plain");
		share.putExtra(Intent.EXTRA_TEXT, currentHost());
		startActivity(Intent.createChooser(share, getString(R.string.menu_share)));
	}

	/**
	 * Forget the session and pair again.
	 */
	private void resetPairing() {
		CookieManager.getInstance().removeAllCookies(null);
		web.clearCache(true);
		openHost(currentHost(), currentPairPath(), true);
	}

	/**
	 * What this app is.
	 */
	private void showAbout() {
		new AlertDialog.Builder(this)
			.setTitle(R.string.app_name)
			.setMessage("DeepSeek Harness をスマホから使うためのアプリです。\n"
				+ "通信先は " + currentHost() + " の DSH ホスト。\n"
				+ "会話は PC と同じホストに保管されているため、"
				+ "PC との操作はそのまま反映されます。")
			.setPositiveButton("閉じる", null)
			.show();
	}

	/**
	 * Open a link that leaves the host in the system browser.
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
	 * @param detail - what went wrong.
	 */
	private void showError(String detail) {
		if (errorText != null) {
			errorText.setText(currentHost() + "\n" + detail);
		}
		if (error != null) error.setVisibility(View.VISIBLE);
	}

	/**
	 * Hide the error card.
	 */
	private void hideError() {
		if (error != null) error.setVisibility(View.GONE);
	}

	/**
	 * Show the first-run form.
	 */
	private void showSetup() {
		if (setup != null) setup.setVisibility(View.VISIBLE);
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
	 * @return the origin, or an empty string.
	 */
	private String currentHost() {
		return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_HOST, "");
	}

	/**
	 * The stored pairing path.
	 * @return the path.
	 */
	private String currentPairPath() {
		return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_PAIR_PATH, DEFAULT_PAIR_PATH);
	}

	/**
	 * Remember the host and the pairing path.
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
	 * @param uri - the address.
	 * @return the answer.
	 */
	private boolean isLocal(Uri uri) {
		String host = currentHost();
		if (host.isEmpty()) return false;
		return host.equals(origin(uri));
	}

	/**
	 * Whether an address is the pairing page.
	 * @param url - the address.
	 * @return the answer.
	 */
	private boolean isPairingUrl(String url) {
		return url != null && url.contains(currentPairPath());
	}

	/**
	 * The origin of an address, without the path.
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
	 * @param value - the size in dp.
	 * @return the size in pixels.
	 */
	private int dp(int value) {
		return Math.round(value * getResources().getDisplayMetrics().density);
	}
}
