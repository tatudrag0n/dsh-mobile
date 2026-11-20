package dev.tatudrag0n.dshmobile;

/** Per-service lifecycle gate. Also guards publication from late process callbacks. */
final class HostLifecycle {
	private boolean started;
	private boolean stopped;

	synchronized boolean start() {
		if (started || stopped) return false;
		started = true;
		return true;
	}

	synchronized void stop() { stopped = true; }
	synchronized boolean active() { return started && !stopped; }

	synchronized void publish(Runnable action) {
		if (active()) action.run();
	}

	interface Action { void run() throws java.io.IOException; }

	/** The cancellation check and resource creation must be one transition. */
	synchronized void create(Action action) throws java.io.IOException {
		check();
		action.run();
	}

	void check() throws java.io.InterruptedIOException {
		if (!active() || Thread.currentThread().isInterrupted()) {
			throw new java.io.InterruptedIOException("Host startup cancelled");
		}
	}
}
