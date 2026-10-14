// <copyright file="PdbSourceLocatorCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.LanguageServer
import System
import System.Collections
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Runtime.CompilerServices
import System.Threading
import Xunit

/// Regression coverage for the (cref:PdbSourceLocator) reader cache
/// (issue #1658): the cache must keep the owning `MetadataReaderProvider`
/// rooted for as long as its `MetadataReader` is cached, and must dispose
/// a replaced provider only after it can no longer be read.
open class PdbSourceLocatorCacheTests {
    /// Before the fix, only the `MetadataReader` was cached; the
    /// `MetadataReaderProvider` that owns its backing buffer became
    /// unreferenced as soon as `LoadReader` returned, so a GC could
    /// collect and finalize it out from under the cached reader. This test
    /// captures a (cref:WeakReference{T}) to the provider actually
    /// held by the cache entry (via reflection) and proves two invariants
    /// directly: (1) the provider stays rooted — and therefore alive — by
    /// the cache entry alone across a full GC while it is still cached, and
    /// (2) once the entry is evicted and replaced (a rebuild bumping the
    /// file's write time), the old provider is disposed and becomes
    /// collectable. Unlike asserting only that a lookup "still resolves"
    /// (which a managed, GC-surviving-by-luck sidecar buffer can satisfy
    /// even without the fix), this directly exercises the rooting
    /// invariant the fix establishes.
    @Fact
    func CachedReader_ProviderStaysRootedByCache_UntilEvicted() {
        let (asmPath, _) = CopyCoreAssemblyToTempDir()
        try {
            let type = typeof(PropertySymbol)
            let ok1 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out var loc1)
            Assert.True(ok1, "First lookup should populate the reader cache.")
            let providerWeakRef = CaptureCachedProviderWeakReference(asmPath)
            // Force any unreferenced MetadataReaderProvider to be collected and finalized.
            GC.Collect()
            GC.WaitForPendingFinalizers()
            GC.Collect()
            Assert.True(
                IsAlive(providerWeakRef),
                "The provider must stay rooted by the cache entry: before the fix only the " +
                    "reader was cached and the provider could be collected here."
            )
            let ok2 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out var loc2)
            Assert.True(ok2, "Second lookup (post-GC) must still resolve through the cached reader.")
            Assert.Equal(loc1, loc2)
            Assert.Contains("PropertySymbol", loc2.FilePath)
            // Bump the write time so the cache evicts and disposes the entry captured above.
            File.SetLastWriteTimeUtc(asmPath, DateTime.UtcNow.AddSeconds(5.0))
            let ok3 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _)
            Assert.True(ok3, "Lookup after an mtime bump should reload and evict the old entry.")
            GC.Collect()
            GC.WaitForPendingFinalizers()
            GC.Collect()
            Assert.False(
                IsAlive(providerWeakRef),
                "Once evicted and disposed, the old provider must become collectable."
            )
        } finally {
            CleanupTempDir(asmPath)
        }
    }

    /// Reproduces the pre-fix lock-leak deadlock: `GetMetadataReader`
    /// throws (cref:BadImageFormatException) lazily on a malformed
    /// portable PDB image (confirmed to happen after
    /// `FromPortablePdbImage` itself succeeds, since it does not eagerly
    /// validate the buffer). Before the fix, that exception unwound out of
    /// `GetOrLoadReaderLease` without releasing the per-path
    /// `Monitor`, permanently deadlocking every subsequent lookup for
    /// the same assembly path — but only when a *different* thread tries to
    /// acquire it: (cref:Monitor) is reentrant, so if the thread pool
    /// happened to reuse the very same thread for a later lookup, the
    /// leaked lock would look harmless. This test therefore runs both
    /// attempts on dedicated, explicitly distinct (cref:Thread)
    /// instances (never pooled) and asserts the second one completes within
    /// a timeout instead of hanging.
    @Fact
    func LookupAfterCorruptPdbException_DoesNotDeadlock() {
        let (asmPath, pdbPath) = CopyCoreAssemblyToTempDir()
        try {
            let type = typeof(PropertySymbol)
            // Corrupt the sidecar PDB so FromPortablePdbImage attaches successfully
            // (it does not eagerly validate) but GetMetadataReader() throws
            // BadImageFormatException when GetOrLoadReaderLease calls it.
            let garbage = [256]uint8
            Random(42).NextBytes(garbage)
            File.WriteAllBytes(pdbPath, garbage)
            var firstException Exception? = nil
            let firstThread = Thread(
                () -> {
                    try {
                        PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _)
                    } catch (ex Exception) {
                        firstException = ex
                    }
                }
            )
            firstThread.Start()
            Assert.True(
                firstThread.Join(TimeSpan.FromSeconds(10)),
                "The first lookup against a corrupt PDB must not hang."
            )
            Assert.IsType[BadImageFormatException](firstException)
            var secondException Exception? = nil
            var secondCompleted = false
            let secondThread = Thread(
                () -> {
                    try {
                        PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _)
                    } catch (ex Exception) {
                        // The corrupted sidecar PDB still fails to parse on retry (as expected);
                        // what matters here is that this thread was able to acquire the lock and
                        // fail promptly instead of hanging.
                        secondException = ex
                    }
                    secondCompleted = true
                }
            )
            secondThread.Start()
            let secondJoined = secondThread.Join(TimeSpan.FromSeconds(10))
            Assert.True(
                secondJoined && secondCompleted,
                "A second lookup on the same path from a different thread must not deadlock: " +
                    "the per-path lock must be released even when the first lookup threw while " +
                    "loading the reader."
            )
            Assert.IsType[BadImageFormatException](secondException)
        } finally {
            CleanupTempDir(asmPath)
        }
    }

    /// When a rebuild changes an assembly's last-write time, the cache must
    /// load a fresh provider/reader pair and dispose the previous provider
    /// (releasing its buffer) rather than leaking it forever.
    @Fact
    func CacheReplacement_OnMtimeChange_DisposesPreviousProvider() {
        let (asmPath, _) = CopyCoreAssemblyToTempDir()
        try {
            let type = typeof(PropertySymbol)
            let ok1 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _)
            Assert.True(ok1)
            let firstProvider object? = GetCachedProvider(asmPath)
            Assert.NotNull(firstProvider)
            // Bump the write time so the cache treats this as a rebuilt assembly.
            File.SetLastWriteTimeUtc(asmPath, DateTime.UtcNow.AddSeconds(5.0))
            let ok2 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _)
            Assert.True(ok2, "Lookup after an mtime bump should reload and re-resolve.")
            let secondProvider object? = GetCachedProvider(asmPath)
            Assert.NotNull(secondProvider)
            Assert.NotSame(firstProvider, secondProvider)
            // The old provider must have been disposed: any further use of it now throws
            // (the exact exception type/wrapping is an implementation detail of
            // System.Reflection.Metadata's disposed-state guard and reflective invoke).
            let getReader MethodInfo? = firstProvider!!.GetType().GetMethod("GetMetadataReader", Type.EmptyTypes)
            let ex = Record.Exception(() -> getReader!!.Invoke(firstProvider, nil)!!)!!
            let actual Exception? = if ex is TargetInvocationException tie {
                tie.InnerException
            } else {
                ex
            }
            Assert.True(
                actual is ObjectDisposedException || actual is NullReferenceException,
                "Expected a disposed-state failure but got ${actual?.GetType()}."
            )
        } finally {
            CleanupTempDir(asmPath)
        }
    }

    shared {
        @MethodImpl(MethodImplOptions.NoInlining)
        private func CaptureCachedProviderWeakReference(assemblyFilePath string) WeakReference[MetadataReaderProvider] {
            let provider MetadataReaderProvider? = cast[MetadataReaderProvider](GetCachedProvider(assemblyFilePath))
            return WeakReference[MetadataReaderProvider](provider!!)
        }

        /// Checks whether [`weakReference`](paramref)'s target is still
        /// alive. This must live in its own non-inlined method rather than
        /// being called inline from the test body: the JIT's baseline tier
        /// keeps every local of a method — including the target captured by an
        /// `out` parameter, even when discarded — conservatively live for
        /// the whole method, not just its lexical scope. Isolating the check in
        /// a separate frame ensures that stale strong reference is released as
        /// soon as this method returns, instead of accidentally keeping the
        /// provider rooted for the rest of the test.
        @MethodImpl(MethodImplOptions.NoInlining)
        private func IsAlive(weakReference WeakReference[MetadataReaderProvider]) bool {
            return weakReference.TryGetTarget(out _)
        }

        private func GetCachedProvider(assemblyFilePath string) object? {
            let cacheField FieldInfo? = typeof(PdbSourceLocator).GetField(
                "ReaderCache",
                BindingFlags.NonPublic | BindingFlags.Static
            )
            let cache IDictionary? = cast[IDictionary](cacheField!!.GetValue(nil))
            // ConcurrentDictionary<string, CachedReader> — index via the non-generic
            // IDictionary view since CachedReader is a private nested type.
            let entry object? = cache!![assemblyFilePath]
            let providerProperty PropertyInfo? = entry!!.GetType().GetProperty("Provider")
            return providerProperty!!.GetValue(entry)
        }

        private func CopyCoreAssemblyToTempDir()(AsmPath string, PdbPath string) {
            let srcAsm = typeof(PropertySymbol).Assembly.Location
            let srcPdb = Path.ChangeExtension(srcAsm, ".pdb")
            Assert.True(File.Exists(srcPdb), "This test requires a build with sidecar portable PDBs.")
            let dir = Path.Combine(Path.GetTempPath(), "pdbcache_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(dir)
            let dstAsm = Path.Combine(dir, Path.GetFileName(srcAsm))
            let dstPdb = Path.Combine(dir, Path.GetFileName(srcPdb))
            File.Copy(srcAsm, dstAsm)
            File.Copy(srcPdb, dstPdb)
            return (dstAsm, dstPdb)
        }

        private func CleanupTempDir(asmPath string) {
            try {
                let dir string? = Path.GetDirectoryName(asmPath)
                if !string.IsNullOrEmpty(dir) && Directory.Exists(dir) {
                    Directory.Delete(dir!!, recursive: true)
                }
            } catch (IOException) {
                // Best-effort cleanup; leftover temp files don't affect test correctness.

            }
        }
    }
}
