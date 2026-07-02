// <copyright file="PdbSourceLocatorCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Runtime.CompilerServices;
using System.Threading;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Regression coverage for the <see cref="PdbSourceLocator"/> reader cache
/// (issue #1658): the cache must keep the owning <c>MetadataReaderProvider</c>
/// rooted for as long as its <c>MetadataReader</c> is cached, and must dispose
/// a replaced provider only after it can no longer be read.
/// </summary>
public class PdbSourceLocatorCacheTests
{
    /// <summary>
    /// Before the fix, only the <c>MetadataReader</c> was cached; the
    /// <c>MetadataReaderProvider</c> that owns its backing buffer became
    /// unreferenced as soon as <c>LoadReader</c> returned, so a GC could
    /// collect and finalize it out from under the cached reader. This test
    /// captures a <see cref="WeakReference{T}"/> to the provider actually
    /// held by the cache entry (via reflection) and proves two invariants
    /// directly: (1) the provider stays rooted — and therefore alive — by
    /// the cache entry alone across a full GC while it is still cached, and
    /// (2) once the entry is evicted and replaced (a rebuild bumping the
    /// file's write time), the old provider is disposed and becomes
    /// collectable. Unlike asserting only that a lookup "still resolves"
    /// (which a managed, GC-surviving-by-luck sidecar buffer can satisfy
    /// even without the fix), this directly exercises the rooting
    /// invariant the fix establishes.
    /// </summary>
    [Fact]
    public void CachedReader_ProviderStaysRootedByCache_UntilEvicted()
    {
        var (asmPath, _) = CopyCoreAssemblyToTempDir();
        try
        {
            var type = typeof(GSharp.Core.CodeAnalysis.Symbols.PropertySymbol);

            var ok1 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out var loc1);
            Assert.True(ok1, "First lookup should populate the reader cache.");

            var providerWeakRef = CaptureCachedProviderWeakReference(asmPath);

            // Force any unreferenced MetadataReaderProvider to be collected and finalized.
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();

            Assert.True(
                IsAlive(providerWeakRef),
                "The provider must stay rooted by the cache entry: before the fix only the " +
                "reader was cached and the provider could be collected here.");

            var ok2 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out var loc2);
            Assert.True(ok2, "Second lookup (post-GC) must still resolve through the cached reader.");
            Assert.Equal(loc1, loc2);
            Assert.Contains("PropertySymbol", loc2.FilePath);

            // Bump the write time so the cache evicts and disposes the entry captured above.
            File.SetLastWriteTimeUtc(asmPath, DateTime.UtcNow.AddSeconds(5));
            var ok3 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _);
            Assert.True(ok3, "Lookup after an mtime bump should reload and evict the old entry.");

            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();

            Assert.False(
                IsAlive(providerWeakRef),
                "Once evicted and disposed, the old provider must become collectable.");
        }
        finally
        {
            CleanupTempDir(asmPath);
        }
    }

    /// <summary>
    /// Reproduces the pre-fix lock-leak deadlock: <c>GetMetadataReader</c>
    /// throws <see cref="BadImageFormatException"/> lazily on a malformed
    /// portable PDB image (confirmed to happen after
    /// <c>FromPortablePdbImage</c> itself succeeds, since it does not eagerly
    /// validate the buffer). Before the fix, that exception unwound out of
    /// <c>GetOrLoadReaderLease</c> without releasing the per-path
    /// <c>Monitor</c>, permanently deadlocking every subsequent lookup for
    /// the same assembly path — but only when a *different* thread tries to
    /// acquire it: <see cref="Monitor"/> is reentrant, so if the thread pool
    /// happened to reuse the very same thread for a later lookup, the
    /// leaked lock would look harmless. This test therefore runs both
    /// attempts on dedicated, explicitly distinct <see cref="Thread"/>
    /// instances (never pooled) and asserts the second one completes within
    /// a timeout instead of hanging.
    /// </summary>
    [Fact]
    public void LookupAfterCorruptPdbException_DoesNotDeadlock()
    {
        var (asmPath, pdbPath) = CopyCoreAssemblyToTempDir();
        try
        {
            var type = typeof(GSharp.Core.CodeAnalysis.Symbols.PropertySymbol);

            // Corrupt the sidecar PDB so FromPortablePdbImage attaches successfully
            // (it does not eagerly validate) but GetMetadataReader() throws
            // BadImageFormatException when GetOrLoadReaderLease calls it.
            var garbage = new byte[256];
            new Random(42).NextBytes(garbage);
            File.WriteAllBytes(pdbPath, garbage);

            Exception firstException = null;
            var firstThread = new Thread(() =>
            {
                try
                {
                    PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _);
                }
                catch (Exception ex)
                {
                    firstException = ex;
                }
            });
            firstThread.Start();
            Assert.True(firstThread.Join(TimeSpan.FromSeconds(10)), "The first lookup against a corrupt PDB must not hang.");
            Assert.IsType<BadImageFormatException>(firstException);

            Exception secondException = null;
            var secondCompleted = false;
            var secondThread = new Thread(() =>
            {
                try
                {
                    PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _);
                }
                catch (Exception ex)
                {
                    // The corrupted sidecar PDB still fails to parse on retry (as expected);
                    // what matters here is that this thread was able to acquire the lock and
                    // fail promptly instead of hanging.
                    secondException = ex;
                }

                secondCompleted = true;
            });
            secondThread.Start();
            var secondJoined = secondThread.Join(TimeSpan.FromSeconds(10));
            Assert.True(
                secondJoined && secondCompleted,
                "A second lookup on the same path from a different thread must not deadlock: " +
                "the per-path lock must be released even when the first lookup threw while " +
                "loading the reader.");
            Assert.IsType<BadImageFormatException>(secondException);
        }
        finally
        {
            CleanupTempDir(asmPath);
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference<MetadataReaderProvider> CaptureCachedProviderWeakReference(string assemblyFilePath)
    {
        var provider = (MetadataReaderProvider)GetCachedProvider(assemblyFilePath);
        return new WeakReference<MetadataReaderProvider>(provider);
    }

    /// <summary>
    /// Checks whether <paramref name="weakReference"/>'s target is still
    /// alive. This must live in its own non-inlined method rather than
    /// being called inline from the test body: the JIT's baseline tier
    /// keeps every local of a method — including the target captured by an
    /// <c>out</c> parameter, even when discarded — conservatively live for
    /// the whole method, not just its lexical scope. Isolating the check in
    /// a separate frame ensures that stale strong reference is released as
    /// soon as this method returns, instead of accidentally keeping the
    /// provider rooted for the rest of the test.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool IsAlive(WeakReference<MetadataReaderProvider> weakReference)
    {
        return weakReference.TryGetTarget(out _);
    }

    /// <summary>
    /// When a rebuild changes an assembly's last-write time, the cache must
    /// load a fresh provider/reader pair and dispose the previous provider
    /// (releasing its buffer) rather than leaking it forever.
    /// </summary>
    [Fact]
    public void CacheReplacement_OnMtimeChange_DisposesPreviousProvider()
    {
        var (asmPath, _) = CopyCoreAssemblyToTempDir();
        try
        {
            var type = typeof(GSharp.Core.CodeAnalysis.Symbols.PropertySymbol);

            var ok1 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _);
            Assert.True(ok1);

            var firstProvider = GetCachedProvider(asmPath);
            Assert.NotNull(firstProvider);

            // Bump the write time so the cache treats this as a rebuilt assembly.
            File.SetLastWriteTimeUtc(asmPath, DateTime.UtcNow.AddSeconds(5));

            var ok2 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out _);
            Assert.True(ok2, "Lookup after an mtime bump should reload and re-resolve.");

            var secondProvider = GetCachedProvider(asmPath);
            Assert.NotNull(secondProvider);
            Assert.NotSame(firstProvider, secondProvider);

            // The old provider must have been disposed: any further use of it now throws
            // (the exact exception type/wrapping is an implementation detail of
            // System.Reflection.Metadata's disposed-state guard and reflective invoke).
            var getReader = firstProvider.GetType().GetMethod("GetMetadataReader", Type.EmptyTypes);
            var ex = Record.Exception(() => getReader.Invoke(firstProvider, null));
            var actual = ex is TargetInvocationException tie ? tie.InnerException : ex;
            Assert.True(
                actual is ObjectDisposedException or NullReferenceException,
                $"Expected a disposed-state failure but got {actual?.GetType()}.");
        }
        finally
        {
            CleanupTempDir(asmPath);
        }
    }

    private static object GetCachedProvider(string assemblyFilePath)
    {
        var cacheField = typeof(PdbSourceLocator).GetField("ReaderCache", BindingFlags.NonPublic | BindingFlags.Static);
        var cache = (IDictionary)cacheField.GetValue(null);

        // ConcurrentDictionary<string, CachedReader> — index via the non-generic
        // IDictionary view since CachedReader is a private nested type.
        var entry = cache[assemblyFilePath];
        var providerProperty = entry.GetType().GetProperty("Provider");
        return providerProperty.GetValue(entry);
    }

    private static (string AsmPath, string PdbPath) CopyCoreAssemblyToTempDir()
    {
        var srcAsm = typeof(GSharp.Core.CodeAnalysis.Symbols.PropertySymbol).Assembly.Location;
        var srcPdb = Path.ChangeExtension(srcAsm, ".pdb");
        Assert.True(File.Exists(srcPdb), "This test requires a build with sidecar portable PDBs.");

        var dir = Path.Combine(Path.GetTempPath(), "pdbcache_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var dstAsm = Path.Combine(dir, Path.GetFileName(srcAsm));
        var dstPdb = Path.Combine(dir, Path.GetFileName(srcPdb));
        File.Copy(srcAsm, dstAsm);
        File.Copy(srcPdb, dstPdb);
        return (dstAsm, dstPdb);
    }

    private static void CleanupTempDir(string asmPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(asmPath);
            if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch (IOException)
        {
            // Best-effort cleanup; leftover temp files don't affect test correctness.
        }
    }
}
