package dev.tatudrag0n.dshmobile;

import java.io.File;
import java.io.IOException;

/** Recoverable directory swap. User state is never part of this transaction. */
final class RuntimeSwap {
	interface Validator { void validate(File directory) throws IOException; }
	interface Mover { boolean move(File from, File to); }
	interface Cleaner { void delete(File directory); }

	static void promote(File staging, File target, File previous, Validator validate,
		Cleaner clean, Mover move) throws IOException {
		validate.validate(staging);
		if (previous.exists()) throw new IOException("Recover the previous runtime before installing");
		boolean backedUp = target.exists();
		if (backedUp && !move.move(target, previous)) throw new IOException("Cannot back up runtime");
		try {
			if (!move.move(staging, target)) throw new IOException("Cannot promote runtime");
			validate.validate(target);
		} catch (IOException failure) {
			// If promotion failed, target does not exist. If validation failed,
			// remove only the new tree and restore the old tree.
			clean.delete(target);
			if (backedUp && !move.move(previous, target)) {
				failure.addSuppressed(new IOException("Rollback pending; previous runtime retained"));
			}
			throw failure;
		}
		clean.delete(previous);
	}

	static void recover(File target, File previous, Validator validate, Cleaner clean) throws IOException {
		if (!previous.exists()) return;
		if (target.exists()) {
			try { validate.validate(target); clean.delete(previous); return; }
			catch (IOException invalid) { clean.delete(target); }
		}
		if (!previous.renameTo(target)) throw new IOException("Cannot restore previous runtime");
	}
}
