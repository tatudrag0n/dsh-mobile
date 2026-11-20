package dev.tatudrag0n.dshmobile;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.net.Socket;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

/** Real Android sockets, not source-string assertions. No accessibility permission required. */
@RunWith(AndroidJUnit4.class)
public class PhoneBridgeTest {
	private PhoneBridge bridge;
	@Before public void start() throws Exception { bridge = new PhoneBridge(ApplicationProvider.getApplicationContext()); bridge.start(); }
	@After public void stop() { bridge.stop(); }

	private String status(String request) throws Exception {
		try (Socket socket = new Socket("127.0.0.1", bridge.port())) {
			socket.setSoTimeout(2000);
			socket.getOutputStream().write(request.getBytes(StandardCharsets.UTF_8));
			return new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)).readLine();
		}
	}
	@Test public void healthRequiresToken() throws Exception {
		assertTrue(status("GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n").contains("401"));
		assertTrue(status("GET /health HTTP/1.1\r\nAuthorization: Bearer " + bridge.token() + "\r\n\r\n").contains("200"));
	}
	@Test public void unauthorizedClientIsRejectedBeforeWaitingForBody() throws Exception {
		assertTrue(status("POST /status HTTP/1.1\r\nContent-Length: 65000\r\n\r\n").contains("401"));
	}
	@Test public void oversizedBodyIsRejectedRatherThanTruncated() throws Exception {
		assertTrue(status("POST /status HTTP/1.1\r\nAuthorization: Bearer " + bridge.token()
			+ "\r\nContent-Length: 65537\r\n\r\n").contains("413"));
	}
	@Test public void duplicateLengthAndExcessiveHeadersAreRejected() throws Exception {
		assertTrue(status("POST /status HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n").contains("400"));
		StringBuilder request = new StringBuilder("GET /health HTTP/1.1\r\n");
		for (int i = 0; i < 65; i++) request.append("X-Test: value\r\n");
		request.append("\r\n"); assertTrue(status(request.toString()).contains("431"));
	}
	@Test public void stopClosesIncompleteConnections() throws Exception {
		try (Socket socket = new Socket("127.0.0.1", bridge.port())) {
			socket.setSoTimeout(2000);
			socket.getOutputStream().write("GET /health HTTP/1.1\r\n".getBytes(StandardCharsets.UTF_8));
			bridge.stop();
			try { assertEquals(-1, socket.getInputStream().read()); }
			catch (java.net.SocketException closed) { /* reset is also an explicit close */ }
		}
	}
}
