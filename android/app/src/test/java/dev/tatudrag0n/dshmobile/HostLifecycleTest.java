package dev.tatudrag0n.dshmobile;

import org.junit.Test;
import java.io.InterruptedIOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class HostLifecycleTest {
	@Test public void repeatedStartsAreIdempotentEvenAfterBootReturns() throws Exception {
		HostLifecycle gate = new HostLifecycle();
		assertTrue(gate.start()); gate.check();
		assertFalse(gate.start()); assertTrue(gate.active());
	}

	@Test public void stopDuringInstallationRejectsLateStartAndCallbacks() throws Exception {
		HostLifecycle gate = new HostLifecycle(); gate.start();
		CountDownLatch installing = new CountDownLatch(1), resume = new CountDownLatch(1);
		AtomicInteger starts = new AtomicInteger(), callbacks = new AtomicInteger();
		Thread boot = new Thread(() -> {
			installing.countDown();
			try { resume.await(); gate.check(); starts.incrementAndGet(); }
			catch (Exception cancelled) { }
			gate.publish(callbacks::incrementAndGet);
		});
		boot.start(); installing.await(); gate.stop(); resume.countDown(); boot.join(2000);
		assertFalse(boot.isAlive()); assertEquals(0, starts.get()); assertEquals(0, callbacks.get());
		assertFalse(gate.start());
	}

	@Test public void timeoutInvalidatesOldCallbacksButAllowsNewServiceInstance() throws Exception {
		HostLifecycle old = new HostLifecycle(); old.start(); old.stop();
		assertThrows(InterruptedIOException.class, old::check);
		HostLifecycle replacement = new HostLifecycle(); assertTrue(replacement.start());
		AtomicInteger state = new AtomicInteger(); replacement.publish(() -> state.set(1));
		old.publish(() -> state.set(2)); assertEquals(1, state.get());
	}
	@Test public void cancelledGenerationCannotCreateResources() throws Exception {
		HostLifecycle gate = new HostLifecycle(); gate.start(); gate.stop();
		AtomicInteger resources = new AtomicInteger();
		assertThrows(InterruptedIOException.class, () -> gate.create(resources::incrementAndGet));
		assertEquals(0, resources.get());
	}

}
