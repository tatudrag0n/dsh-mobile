package dev.tatudrag0n.dshmobile;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class RuntimeSwapTest {
	@Rule public TemporaryFolder tmp = new TemporaryFolder();
	private File dir(String name, String content) throws IOException {
		File result = tmp.newFolder(name); Files.write(new File(result, "entry").toPath(), content.getBytes()); return result;
	}
	private String content(File dir) throws IOException { return new String(Files.readAllBytes(new File(dir, "entry").toPath())); }
	private void validate(File dir) throws IOException { if (!new File(dir, "entry").isFile()) throw new IOException("incomplete"); }
	private void clean(File file) { File[] children = file.listFiles(); if (children != null) for (File child : children) clean(child); file.delete(); }
	private File previous() { return new File(tmp.getRoot(), "previous"); }

	@Test public void successPreservesHomeAndRemovesBackup() throws Exception {
		File home = dir("home", "sessions"), old = dir("runtime", "old"), staging = dir("staging", "new");
		RuntimeSwap.promote(staging, old, previous(), this::validate, this::clean, File::renameTo);
		assertEquals("new", content(old)); assertEquals("sessions", content(home)); assertFalse(previous().exists());
	}
	@Test public void invalidStagingNeverMovesWorkingRuntime() throws Exception {
		File old = dir("runtime", "old"), staging = tmp.newFolder("staging");
		assertThrows(IOException.class, () -> RuntimeSwap.promote(staging, old, previous(), this::validate, this::clean, File::renameTo));
		assertEquals("old", content(old));
	}
	@Test public void failedPromotionRestoresOldRuntime() throws Exception {
		File old = dir("runtime", "old"), staging = dir("staging", "new");
		assertThrows(IOException.class, () -> RuntimeSwap.promote(staging, old, previous(), this::validate, this::clean,
			(from, to) -> !from.equals(staging) && from.renameTo(to)));
		assertEquals("old", content(old));
	}
	@Test public void failedPostPromotionValidationRollsBack() throws Exception {
		File old = dir("runtime", "old"), staging = dir("staging", "new");
		assertThrows(IOException.class, () -> RuntimeSwap.promote(staging, old, previous(), directory -> {
			validate(directory); if (directory.equals(old)) throw new IOException("native links failed");
		}, this::clean, File::renameTo));
		assertEquals("old", content(old));
	}
	@Test public void interruptedSwapRecoversBackup() throws Exception {
		File old = dir("runtime", "old"); assertTrue(old.renameTo(previous()));
		RuntimeSwap.recover(old, previous(), this::validate, this::clean);
		assertEquals("old", content(old));
	}
	@Test public void interruptedSwapWithInvalidNewTreeRecoversBackup() throws Exception {
		File old = dir("runtime", "old"); assertTrue(old.renameTo(previous())); assertTrue(old.mkdir());
		RuntimeSwap.recover(old, previous(), this::validate, this::clean);
		assertEquals("old", content(old));
	}
}
