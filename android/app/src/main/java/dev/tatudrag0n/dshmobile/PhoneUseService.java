package dev.tatudrag0n.dshmobile;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The phone's input and observation surface, exposed to the Host.
 *
 * Accessibility is the only API that lets an ordinary app tap, swipe and type
 * in *other* apps, and `AccessibilityService.takeScreenshot` is the only way to
 * see the screen without a MediaProjection consent dialog on every capture. So
 * the agent's eyes and hands on the phone are this service.
 *
 * Nothing here talks to the Host directly: {@link PhoneBridge} owns the
 * loopback protocol and calls these methods. Keeping the platform calls in one
 * class also keeps the "does this device have the API" questions in one place.
 */
public class PhoneUseService extends AccessibilityService {

	private static final String TAG = "DshMobile";

	/** The running service, or null while the user has not enabled it. */
	private static volatile PhoneUseService instance;

	/** Runs screenshot callbacks off the main thread. */
	private final Executor screenshots = Executors.newSingleThreadExecutor();

	/** The main looper, where gesture and screenshot callbacks arrive. */
	private final Handler main = new Handler(Looper.getMainLooper());

	/** Whether the service is currently connected. */
	static boolean isRunning() {
		return instance != null;
	}

	@Override
	protected void onServiceConnected() {
		super.onServiceConnected();
		instance = this;
		Log.i(TAG, "phone use service connected");
	}

	@Override
	public void onDestroy() {
		instance = null;
		super.onDestroy();
	}

	@Override
	public void onAccessibilityEvent(AccessibilityEvent event) {
		// The Host asks for the tree on demand; nothing is streamed.
	}

	@Override
	public void onInterrupt() {
		// No long-running feedback is produced.
	}

	/**
	 * The connected service.
	 *
	 * @return the service.
	 * @throws IllegalStateException when the user has not enabled it.
	 */
	private static PhoneUseService require() {
		PhoneUseService current = instance;
		if (current == null) {
			throw new IllegalStateException(
				"スマホ操作の許可（ユーザー補助）が有効になっていません。DSH Mobile の設定から有効にしてください。");
		}
		return current;
	}

	/**
	 * Tap a pixel.
	 *
	 * @param x - horizontal pixel.
	 * @param y - vertical pixel.
	 */
	static void tap(int x, int y) {
		PhoneUseService service = require();
		Path path = new Path();
		path.moveTo(clamp(x), clamp(y));
		GestureDescription gesture = new GestureDescription.Builder()
			.addStroke(new GestureDescription.StrokeDescription(path, 0, 40))
			.build();
		dispatch(service, gesture);
	}

	/**
	 * Swipe between two pixels.
	 *
	 * @param x1 - start x.
	 * @param y1 - start y.
	 * @param x2 - end x.
	 * @param y2 - end y.
	 * @param durationMs - gesture duration.
	 */
	static void swipe(int x1, int y1, int x2, int y2, int durationMs) {
		PhoneUseService service = require();
		Path path = new Path();
		path.moveTo(clamp(x1), clamp(y1));
		path.lineTo(clamp(x2), clamp(y2));
		GestureDescription gesture = new GestureDescription.Builder()
			.addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(20, durationMs)))
			.build();
		dispatch(service, gesture);
	}

	/**
	 * Write text into the focused editable field.
	 *
	 * @param text - the replacement text.
	 * @return a description of the field that received it.
	 * @throws IllegalStateException when no editable field is focused.
	 */
	static String type(String text) {
		PhoneUseService service = require();
		AccessibilityNodeInfo root = service.getRootInActiveWindow();
		if (root == null) throw new IllegalStateException("画面の内容を読めませんでした");
		AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
		if (focused == null) throw new IllegalStateException("入力できる欄にフォーカスがありません。先に欄をタップしてください。");
		Bundle arguments = new Bundle();
		arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
		if (!focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) {
			throw new IllegalStateException("入力欄への書き込みが拒否されました");
		}
		return describe(focused);
	}

	/**
	 * Delete the last character of the focused field.
	 *
	 * @return a description of the field.
	 */
	static String backspace() {
		PhoneUseService service = require();
		AccessibilityNodeInfo root = service.getRootInActiveWindow();
		if (root == null) throw new IllegalStateException("画面の内容を読めませんでした");
		AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
		if (focused == null) throw new IllegalStateException("入力できる欄にフォーカスがありません");
		CharSequence current = focused.getText();
		String text = current == null ? "" : current.toString();
		if (text.isEmpty()) return "すでに空です";
		Bundle arguments = new Bundle();
		arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
			text.substring(0, text.length() - 1));
		focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
		return describe(focused);
	}

	/**
	 * Press the enter key on the focused field.
	 *
	 * @throws IllegalStateException when the platform predates the IME action.
	 */
	static void enter() {
		PhoneUseService service = require();
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
			throw new IllegalStateException("この Android では Enter を送れません（Android 11 以降が必要）");
		}
		AccessibilityNodeInfo root = service.getRootInActiveWindow();
		if (root == null) throw new IllegalStateException("画面の内容を読めませんでした");
		AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
		if (focused == null) throw new IllegalStateException("入力できる欄にフォーカスがありません");
		if (!focused.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
			throw new IllegalStateException("Enter が拒否されました");
		}
	}

	/**
	 * Perform a global action.
	 *
	 * @param key - back, home, recents, notification, quick_settings or lock.
	 */
	static void key(String key) {
		PhoneUseService service = require();
		int action;
		switch (key) {
			case "back": action = GLOBAL_ACTION_BACK; break;
			case "home": action = GLOBAL_ACTION_HOME; break;
			case "recents": action = GLOBAL_ACTION_RECENTS; break;
			case "notification": action = GLOBAL_ACTION_NOTIFICATIONS; break;
			case "quick_settings": action = GLOBAL_ACTION_QUICK_SETTINGS; break;
			case "lock":
				if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
					throw new IllegalStateException("この Android では画面をロックできません");
				}
				action = GLOBAL_ACTION_LOCK_SCREEN;
				break;
			default:
				throw new IllegalArgumentException("unknown key: " + key);
		}
		if (!service.performGlobalAction(action)) {
			throw new IllegalStateException("キー操作が拒否されました: " + key);
		}
	}

	/**
	 * Render the accessibility tree of the current screen as text.
	 *
	 * Each line carries the tap-able bounds, so a coordinate the model takes
	 * from here is a coordinate {@link #tap} accepts.
	 *
	 * @param maxNodes - how many nodes to print at most.
	 * @return the rendering, and how many nodes it covers.
	 */
	static Tree dump(int maxNodes) {
		PhoneUseService service = require();
		AccessibilityNodeInfo root = service.getRootInActiveWindow();
		if (root == null) throw new IllegalStateException("画面の内容を読めませんでした");
		List<String> lines = new ArrayList<>();
		Deque<Node> queue = new ArrayDeque<>();
		queue.add(new Node(root, 0));
		int printed = 0;
		int seen = 0;
		while (!queue.isEmpty() && printed < maxNodes) {
			Node node = queue.poll();
			seen += 1;
			AccessibilityNodeInfo info = node.info;
			String line = render(info, node.depth);
			if (line != null) {
				lines.add(line);
				printed += 1;
			}
			for (int index = 0; index < info.getChildCount(); index += 1) {
				AccessibilityNodeInfo child = info.getChild(index);
				if (child != null) queue.add(new Node(child, node.depth + 1));
			}
		}
		StringBuilder text = new StringBuilder();
		for (String line : lines) text.append(line).append('\n');
		if (!queue.isEmpty()) text.append("… (残り ").append(queue.size()).append(" ノードは省略)\n");
		return new Tree(text.toString(), seen);
	}

	/**
	 * Capture the screen into a PNG file.
	 *
	 * @param target - the file to write.
	 * @return the captured size.
	 */
	static Size screenshot(File target) {
		PhoneUseService service = require();
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
			throw new IllegalStateException("この Android ではスクリーンショットを撮れません（Android 11 以降が必要）");
		}
		CountDownLatch done = new CountDownLatch(1);
		Throwable[] failure = new Throwable[1];
		Size[] size = new Size[1];
		service.takeScreenshot(Display.DEFAULT_DISPLAY, service.screenshots,
			new AccessibilityService.TakeScreenshotCallback() {
				@Override
				public void onSuccess(AccessibilityService.ScreenshotResult result) {
					try {
						HardwareBuffer buffer = result.getHardwareBuffer();
						Bitmap bitmap = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
						if (bitmap == null) throw new IllegalStateException("スクリーンショットを画像にできませんでした");
						Bitmap copy = bitmap.copy(Bitmap.Config.ARGB_8888, false);
						buffer.close();
						if (copy == null) throw new IllegalStateException("スクリーンショットを画像にできませんでした");
						File parent = target.getParentFile();
						if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
							throw new IllegalStateException("保存先を作れません: " + parent);
						}
						try (FileOutputStream output = new FileOutputStream(target)) {
							if (!copy.compress(Bitmap.CompressFormat.PNG, 100, output)) {
								throw new IllegalStateException("PNG を書き出せませんでした");
							}
						}
						size[0] = new Size(copy.getWidth(), copy.getHeight());
						copy.recycle();
					} catch (Throwable problem) {
						failure[0] = problem;
					} finally {
						done.countDown();
					}
				}

				@Override
				public void onFailure(int errorCode) {
					failure[0] = new IllegalStateException("スクリーンショットに失敗しました (code " + errorCode + ")");
					done.countDown();
				}
			});
		try {
			if (!done.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("スクリーンショットが時間内に撮れませんでした");
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
			throw new IllegalStateException("スクリーンショットが中断されました");
		}
		if (failure[0] != null) throw new IllegalStateException(failure[0].getMessage(), failure[0]);
		return size[0];
	}

	/**
	 * Describe a node in one line.
	 *
	 * @param info - the node.
	 * @param depth - its depth in the tree.
	 * @return the line, or null when the node carries nothing worth printing.
	 */
	private static String render(AccessibilityNodeInfo info, int depth) {
		String text = trim(info.getText());
		String description = trim(info.getContentDescription());
		String hint = trim(info.getHintText());
		String id = trim(info.getViewIdResourceName());
		boolean interesting = text != null || description != null || hint != null
			|| info.isClickable() || info.isEditable() || info.isScrollable() || id != null;
		if (!interesting) return null;
		Rect bounds = new Rect();
		info.getBoundsInScreen(bounds);
		StringBuilder line = new StringBuilder();
		for (int index = 0; index < depth; index += 1) line.append("  ");
		line.append('[').append(shortName(info.getClassName())).append(']');
		if (text != null) line.append(" text=").append(quote(text));
		if (description != null) line.append(" desc=").append(quote(description));
		if (hint != null) line.append(" hint=").append(quote(hint));
		if (id != null) line.append(" id=").append(id);
		if (info.isClickable()) line.append(" clickable");
		if (info.isEditable()) line.append(" editable");
		if (info.isScrollable()) line.append(" scrollable");
		if (info.isChecked()) line.append(" checked");
		if (!info.isEnabled()) line.append(" disabled");
		line.append(" bounds=").append(bounds.left).append(',').append(bounds.top)
			.append(' ').append(bounds.width()).append('x').append(bounds.height());
		return line.toString();
	}

	/**
	 * Describe the field that received text.
	 *
	 * @param info - the field.
	 * @return a short description.
	 */
	private static String describe(AccessibilityNodeInfo info) {
		String id = trim(info.getViewIdResourceName());
		String hint = trim(info.getHintText());
		if (id != null) return id;
		if (hint != null) return hint;
		return shortName(info.getClassName());
	}

	/**
	 * Dispatch a one-point gesture and wait for it.
	 *
	 * @param service - the service.
	 * @param x - horizontal pixel.
	 * @param y - vertical pixel.
	 * @param durationMs - stroke duration.
	 * @return the gesture.
	 */
	private static GestureDescription single(PhoneUseService service, int x, int y, int durationMs) {
		Path path = new Path();
		path.moveTo(clamp(x), clamp(y));
		return new GestureDescription.Builder()
			.addStroke(new GestureDescription.StrokeDescription(path, 0, durationMs))
			.build();
	}

	/**
	 * Dispatch a gesture and block until it completes.
	 *
	 * @param gesture - the gesture.
	 */
	private static void dispatch(GestureDescription gesture) {
		dispatch(require(), gesture);
	}

	/**
	 * Dispatch a gesture through a specific service and wait for its result.
	 *
	 * @param service - the service.
	 * @param gesture - the gesture.
	 */
	private static void dispatch(PhoneUseService service, GestureDescription gesture) {
		CountDownLatch done = new CountDownLatch(1);
		boolean[] completed = new boolean[1];
		service.dispatchGesture(gesture, new GestureResultCallback() {
			@Override
			public void onCompleted(GestureDescription description) {
				completed[0] = true;
				done.countDown();
			}

			@Override
			public void onCancelled(GestureDescription description) {
				done.countDown();
			}
		}, service.main);
		try {
			if (!done.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("操作が時間内に完了しませんでした");
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
			throw new IllegalStateException("操作が中断されました");
		}
		if (!completed[0]) throw new IllegalStateException("操作がキャンセルされました");
	}

	/**
	 * Clamp a coordinate into the float range a Path accepts.
	 *
	 * @param value - the coordinate.
	 * @return the coordinate as a float.
	 */
	private static float clamp(int value) {
		return Math.max(0, value);
	}

	/**
	 * Trim a node string, treating blank as absent.
	 *
	 * @param value - the candidate.
	 * @return the trimmed value, or null.
	 */
	private static String trim(CharSequence value) {
		if (value == null) return null;
		String text = value.toString().trim();
		return text.isEmpty() ? null : text;
	}

	/**
	 * Shorten a class name to its last segment.
	 *
	 * @param className - the full name.
	 * @return the short name.
	 */
	private static String shortName(CharSequence className) {
		if (className == null) return "?";
		String text = className.toString();
		int dot = text.lastIndexOf('.');
		return dot < 0 ? text : text.substring(dot + 1);
	}

	/**
	 * Quote a value for the tree rendering, truncating long text.
	 *
	 * @param value - the value.
	 * @return the quoted form.
	 */
	private static String quote(String value) {
		String text = value.length() > 120 ? value.substring(0, 117) + "…" : value;
		return '"' + text.replace("\n", " ") + '"';
	}

	/** A node plus its depth, in the traversal queue. */
	private static final class Node {
		final AccessibilityNodeInfo info;
		final int depth;

		Node(AccessibilityNodeInfo info, int depth) {
			this.info = info;
			this.depth = depth;
		}
	}

	/** A rendered tree. */
	static final class Tree {
		/** The text. */
		final String text;
		/** How many nodes were visited. */
		final int count;

		Tree(String text, int count) {
			this.text = text;
			this.count = count;
		}
	}

	/** A pixel size. */
	static final class Size {
		/** Width. */
		final int width;
		/** Height. */
		final int height;

		Size(int width, int height) {
			this.width = width;
			this.height = height;
		}
	}
}
