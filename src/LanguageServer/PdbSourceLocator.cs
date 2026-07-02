// <copyright file="PdbSourceLocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Threading;

namespace GSharp.LanguageServer;

/// <summary>
/// Tier 2 of cross-project Go-to-Definition: resolves a CLR member to a source
/// file/line by reading its declaring assembly's portable PDB (sidecar
/// <c>{Name}.pdb</c> or embedded in the PE).
/// </summary>
/// <remarks>
/// Per-assembly readers are cached for the lifetime of the language server.
/// The cache key is the resolved assembly path plus its last-write time, so a
/// successful rebuild invalidates the cached PDB automatically on the next
/// lookup. The cache stores the owning <see cref="MetadataReaderProvider"/>
/// alongside its <see cref="MetadataReader"/> so the provider (and the native
/// or managed memory it owns) stays rooted for as long as the reader is in
/// use. When a rebuild replaces a cache entry, the previous provider is
/// disposed under the same per-path lock used to hand out readers, so it is
/// never disposed while another thread is still reading through it.
/// <para>
/// MSBuild emits the public-API <c>refint/{Name}.dll</c> for any project with
/// <c>ProduceReferenceAssembly=true</c> (the SDK default for libraries), and
/// that DLL has no method bodies — hence no sequence points. When the supplied
/// path lives under a <c>refint</c> directory we transparently swap to the
/// sibling runtime assembly one level up (<c>obj/.../{Name}.dll</c>), which
/// the SDK writes alongside its PDB.
/// </para>
/// </remarks>
public static class PdbSourceLocator
{
    private static readonly ConcurrentDictionary<string, CachedReader> ReaderCache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Per-path locks that serialize cache load/replace against reader use, so
    /// a cache replacement never disposes a <see cref="MetadataReaderProvider"/>
    /// while another thread is still reading through it.
    /// </summary>
    private static readonly ConcurrentDictionary<string, object> PathLocks = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Resolves a method's first sequence point to a source file and span.
    /// Returns <see langword="false"/> when no portable PDB is reachable from
    /// the supplied assembly path, or when the metadata token has no sequence
    /// points (e.g. compiler-generated or PDB-less builds).
    /// </summary>
    /// <param name="assemblyFilePath">Absolute path to the imported assembly, as
    /// it appears in the project's reference list.</param>
    /// <param name="methodMetadataToken">A 0x06xxxxxx-typed
    /// <c>MethodInfo.MetadataToken</c>.</param>
    /// <param name="location">The resolved source location on success.</param>
    /// <returns>True when a source location was found.</returns>
    public static bool TryGetMethodSourceLocation(string assemblyFilePath, int methodMetadataToken, out SourceLocation location)
    {
        location = default;
        if (string.IsNullOrEmpty(assemblyFilePath))
        {
            return false;
        }

        // Per cmt above: prefer the runtime assembly's PDB when the input is a refint shim.
        var probePath = RebaseRefIntPath(assemblyFilePath);
        var lease = GetOrLoadReaderLease(probePath);
        if (!lease.IsValid && !string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase))
        {
            lease = GetOrLoadReaderLease(assemblyFilePath);
        }

        using (lease)
        {
            if (!lease.IsValid)
            {
                return false;
            }

            return TryReadFirstSequencePoint(lease.Reader, methodMetadataToken, out location);
        }
    }

    /// <summary>
    /// Resolves a type's source location by walking its methods (constructors
    /// first, then declared methods) and returning the earliest sequence point
    /// found. The earliest declaration is the best proxy for "where the type
    /// is defined": even if the methods live in a partial across multiple
    /// files, the first sequence point of the first non-synthetic method
    /// reliably lands at or just inside the type's body.
    /// </summary>
    /// <param name="assemblyFilePath">Absolute path to the imported assembly.</param>
    /// <param name="typeMetadataToken">A 0x02xxxxxx-typed <c>Type.MetadataToken</c>.</param>
    /// <param name="location">The resolved source location on success.</param>
    /// <returns>True when at least one sequence point was found for the type.</returns>
    public static bool TryGetTypeSourceLocation(string assemblyFilePath, int typeMetadataToken, out SourceLocation location)
    {
        location = default;
        if (string.IsNullOrEmpty(assemblyFilePath))
        {
            return false;
        }

        var probePath = RebaseRefIntPath(assemblyFilePath);
        var lease = GetOrLoadReaderLease(probePath);
        if (!lease.IsValid && !string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase))
        {
            lease = GetOrLoadReaderLease(assemblyFilePath);
        }

        using (lease)
        {
            if (!lease.IsValid)
            {
                return false;
            }

            // The PDB MethodDebugInformation table is parallel to the PE
            // MethodDef table; we don't need the PE here because the supplied
            // method tokens are already resolved by the caller from
            // typeDef.GetMethods(). Resolve them via the PE alongside the PDB.
            if (!TryReadTypeMethodTokens(probePath, typeMetadataToken, out var methodTokens))
            {
                if (!string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase))
                {
                    if (!TryReadTypeMethodTokens(assemblyFilePath, typeMetadataToken, out methodTokens))
                    {
                        return false;
                    }
                }
                else
                {
                    return false;
                }
            }

            SourceLocation? best = null;
            foreach (var methodToken in methodTokens)
            {
                if (TryReadFirstSequencePoint(lease.Reader, methodToken, out var candidate))
                {
                    if (best == null || IsEarlier(candidate, best.Value))
                    {
                        best = candidate;
                    }
                }
            }

            if (best == null)
            {
                return false;
            }

            location = best.Value;
            return true;
        }
    }

    private static bool IsEarlier(SourceLocation a, SourceLocation b)
    {
        var cmp = string.Compare(a.FilePath, b.FilePath, StringComparison.OrdinalIgnoreCase);
        if (cmp != 0)
        {
            return cmp < 0;
        }

        if (a.StartLine != b.StartLine)
        {
            return a.StartLine < b.StartLine;
        }

        return a.StartColumn < b.StartColumn;
    }

    private static bool TryReadTypeMethodTokens(string assemblyFilePath, int typeMetadataToken, out IReadOnlyList<int> methodTokens)
    {
        methodTokens = Array.Empty<int>();
        if (!File.Exists(assemblyFilePath))
        {
            return false;
        }

        try
        {
            using var stream = new FileStream(assemblyFilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var peReader = new PEReader(stream);
            if (!peReader.HasMetadata)
            {
                return false;
            }

            var mdReader = peReader.GetMetadataReader();
            var handle = MetadataTokens.EntityHandle(typeMetadataToken);
            if (handle.Kind != HandleKind.TypeDefinition)
            {
                return false;
            }

            var typeDef = mdReader.GetTypeDefinition((TypeDefinitionHandle)handle);
            var collected = new List<int>();
            foreach (var methodHandle in typeDef.GetMethods())
            {
                collected.Add(MetadataTokens.GetToken(methodHandle));
            }

            methodTokens = collected;
            return collected.Count > 0;
        }
        catch (IOException)
        {
            return false;
        }
        catch (BadImageFormatException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool TryReadFirstSequencePoint(MetadataReader reader, int methodMetadataToken, out SourceLocation location)
    {
        location = default;
        try
        {
            var entityHandle = MetadataTokens.EntityHandle(methodMetadataToken);
            if (entityHandle.Kind != HandleKind.MethodDefinition)
            {
                return false;
            }

            var debugInfoHandle = ((MethodDefinitionHandle)entityHandle).ToDebugInformationHandle();
            var debugInfo = reader.GetMethodDebugInformation(debugInfoHandle);
            if (debugInfo.SequencePointsBlob.IsNil)
            {
                return false;
            }

            foreach (var sp in debugInfo.GetSequencePoints())
            {
                if (sp.IsHidden)
                {
                    continue;
                }

                var doc = reader.GetDocument(sp.Document);
                var filePath = reader.GetString(doc.Name);
                location = new SourceLocation(filePath, sp.StartLine, sp.StartColumn, sp.EndLine, sp.EndColumn);
                return true;
            }

            return false;
        }
        catch (BadImageFormatException)
        {
            return false;
        }
        catch (ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    /// <summary>
    /// Acquires the per-path lock, ensures the cached reader for
    /// <paramref name="assemblyFilePath"/> is up to date with the file's
    /// current write time (disposing and replacing a stale
    /// <see cref="MetadataReaderProvider"/> if needed), and returns a lease
    /// that holds the lock until disposed. The caller must use the reader
    /// only while the lease is held (e.g. inside a <c>using</c> block) and
    /// must check <see cref="ReaderLease.IsValid"/> before use.
    /// </summary>
    private static ReaderLease GetOrLoadReaderLease(string assemblyFilePath)
    {
        var pathLock = PathLocks.GetOrAdd(assemblyFilePath, static _ => new object());
        Monitor.Enter(pathLock);

        if (!File.Exists(assemblyFilePath))
        {
            Monitor.Exit(pathLock);
            return ReaderLease.Invalid;
        }

        DateTime mtimeUtc;
        try
        {
            mtimeUtc = File.GetLastWriteTimeUtc(assemblyFilePath);
        }
        catch (IOException)
        {
            Monitor.Exit(pathLock);
            return ReaderLease.Invalid;
        }

        if (ReaderCache.TryGetValue(assemblyFilePath, out var cached) && cached.MtimeUtc == mtimeUtc)
        {
            return new ReaderLease(pathLock, cached.Reader);
        }

        var loadedProvider = LoadReaderProvider(assemblyFilePath);
        if (loadedProvider == null)
        {
            Monitor.Exit(pathLock);
            return ReaderLease.Invalid;
        }

        var loadedReader = loadedProvider.GetMetadataReader();
        ReaderCache[assemblyFilePath] = new CachedReader(loadedProvider, loadedReader, mtimeUtc);

        // The stale entry's reader is no longer reachable from the cache and no
        // other thread can be reading it: we hold this path's lock, and every
        // reader is only ever used while that lock is held.
        cached.Provider?.Dispose();

        return new ReaderLease(pathLock, loadedReader);
    }

    private static MetadataReaderProvider LoadReaderProvider(string assemblyFilePath)
    {
        try
        {
            var sidecar = Path.ChangeExtension(assemblyFilePath, ".pdb");
            if (File.Exists(sidecar))
            {
                // Read the file into memory so MetadataReaderProvider keeps the
                // bytes alive after the underlying file handle is closed
                // (FromPortablePdbImage stores the buffer directly).
                var bytes = File.ReadAllBytes(sidecar);
                return MetadataReaderProvider.FromPortablePdbImage(System.Collections.Immutable.ImmutableArray.Create(bytes));
            }

            // Probe the PE for an embedded PDB.
            using var stream = new FileStream(assemblyFilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var peReader = new PEReader(stream);
            if (!peReader.HasMetadata)
            {
                return null;
            }

            var debugDirectory = peReader.ReadDebugDirectory();
            var embedded = debugDirectory.FirstOrDefault(e => e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb);
            if (embedded.DataSize == 0)
            {
                return null;
            }

            // The embedded-PDB provider owns a native-heap buffer that is
            // released by its finalizer; it must be cached (not just the
            // reader it hands out) so the buffer stays alive for as long as
            // the reader is used.
            return peReader.ReadEmbeddedPortablePdbDebugDirectoryData(embedded);
        }
        catch (IOException)
        {
            return null;
        }
        catch (BadImageFormatException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// Rewrites a path ending in <c>obj/.../refint/{Name}.dll</c> to the
    /// sibling runtime DLL <c>obj/.../{Name}.dll</c>. Returns the input
    /// unchanged when the segment <c>refint</c> is not present.
    /// </summary>
    private static string RebaseRefIntPath(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return path;
        }

        var directory = Path.GetDirectoryName(path);
        if (string.IsNullOrEmpty(directory))
        {
            return path;
        }

        var leaf = Path.GetFileName(directory);
        if (!string.Equals(leaf, "refint", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(leaf, "ref", StringComparison.OrdinalIgnoreCase))
        {
            return path;
        }

        var parent = Path.GetDirectoryName(directory);
        if (string.IsNullOrEmpty(parent))
        {
            return path;
        }

        var candidate = Path.Combine(parent, Path.GetFileName(path));
        return File.Exists(candidate) ? candidate : path;
    }

    /// <summary>
    /// Source location returned by the PDB lookup. Lines and columns are
    /// 1-based per the Portable PDB sequence-point convention; the caller is
    /// expected to convert to LSP's 0-based <see cref="Protocol.Position"/>.
    /// </summary>
    public readonly record struct SourceLocation(string FilePath, int StartLine, int StartColumn, int EndLine, int EndColumn);

    /// <summary>
    /// A cache entry that keeps the <see cref="MetadataReaderProvider"/>
    /// rooted alongside the <see cref="MetadataReader"/> it produced, so the
    /// provider (and any native or managed buffer it owns) cannot be
    /// collected and finalized while the reader is still cached and in use.
    /// </summary>
    private readonly record struct CachedReader(MetadataReaderProvider Provider, MetadataReader Reader, DateTime MtimeUtc);

    /// <summary>
    /// Holds the per-path lock for a cached reader while the caller uses it.
    /// Disposing the lease releases the lock. Always check
    /// <see cref="IsValid"/> before using <see cref="Reader"/>: an invalid
    /// lease means no lock is held and <see cref="Reader"/> is <see langword="null"/>.
    /// </summary>
    private readonly struct ReaderLease : IDisposable
    {
        /// <summary>
        /// A lease value representing a failed lookup: no lock is held.
        /// </summary>
        public static readonly ReaderLease Invalid = default;

        private readonly object pathLock;

        /// <summary>
        /// Initializes a new instance of the <see cref="ReaderLease"/> struct
        /// that holds <paramref name="pathLock"/> until disposed.
        /// </summary>
        /// <param name="pathLock">The per-path lock, already entered by the caller.</param>
        /// <param name="reader">The cached reader to hand out while the lock is held.</param>
        public ReaderLease(object pathLock, MetadataReader reader)
        {
            this.pathLock = pathLock;
            Reader = reader;
        }

        /// <summary>
        /// Gets the cached reader. Only valid to use while the lease is held (i.e. before <see cref="Dispose"/> is called).
        /// </summary>
        public MetadataReader Reader { get; }

        /// <summary>
        /// Gets a value indicating whether this lease holds a lock and carries a usable <see cref="Reader"/>.
        /// </summary>
        public bool IsValid => pathLock != null;

        /// <summary>
        /// Releases the per-path lock acquired for this lease, if any.
        /// </summary>
        public void Dispose()
        {
            if (pathLock != null)
            {
                Monitor.Exit(pathLock);
            }
        }
    }
}
