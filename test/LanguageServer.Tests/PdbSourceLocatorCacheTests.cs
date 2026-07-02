// <copyright file="PdbSourceLocatorCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.IO;
using System.Reflection;
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
    /// unreferenced as soon as <c>LoadReader</c> returned. A GC could collect
    /// and finalize it, freeing the buffer out from under the cached reader
    /// and corrupting (or crashing on) the next lookup. This test forces a GC
    /// between two lookups of the same assembly and asserts the second lookup
    /// still resolves correctly.
    /// </summary>
    [Fact]
    public void CachedReader_SurvivesGarbageCollection()
    {
        var (asmPath, _) = CopyCoreAssemblyToTempDir();
        try
        {
            var type = typeof(GSharp.Core.CodeAnalysis.Symbols.PropertySymbol);

            var ok1 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out var loc1);
            Assert.True(ok1, "First lookup should populate the reader cache.");

            // Force any unreferenced MetadataReaderProvider to be collected and finalized.
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();

            var ok2 = PdbSourceLocator.TryGetTypeSourceLocation(asmPath, type.MetadataToken, out var loc2);
            Assert.True(ok2, "Second lookup (post-GC) must still resolve through the cached reader.");
            Assert.Equal(loc1, loc2);
            Assert.Contains("PropertySymbol", loc2.FilePath);
        }
        finally
        {
            CleanupTempDir(asmPath);
        }
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
