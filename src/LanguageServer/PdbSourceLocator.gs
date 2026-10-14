// <copyright file="PdbSourceLocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Threading
import SystemObject = System.Object

/// Tier 2 of cross-project Go-to-Definition: resolves a CLR member to a source
/// file/line by reading its declaring assembly's portable PDB (sidecar
/// `{Name}.pdb` or embedded in the PE).
/// @remarks Per-assembly readers are cached for the lifetime of the language server.
/// The cache key is the resolved assembly path plus its last-write time, so a
/// successful rebuild invalidates the cached PDB automatically on the next
/// lookup. The cache stores the owning (cref:MetadataReaderProvider)
/// alongside its (cref:MetadataReader) so the provider (and the native
/// or managed memory it owns) stays rooted for as long as the reader is in
/// use. When a rebuild replaces a cache entry, the previous provider is
/// disposed under the same per-path lock used to hand out readers, so it is
/// never disposed while another thread is still reading through it.
///
/// MSBuild emits the public-API `refint/{Name}.dll` for any project with
/// `ProduceReferenceAssembly=true` (the SDK default for libraries), and
/// that DLL has no method bodies — hence no sequence points. When the supplied
/// path lives under a `refint` directory we transparently swap to the
/// sibling runtime assembly one level up (`obj/.../{Name}.dll`), which
/// the SDK writes alongside its PDB.
shared class PdbSourceLocator {
    /// Source location returned by the PDB lookup. Lines and columns are
    /// 1-based per the Portable PDB sequence-point convention; the caller is
    /// expected to convert to LSP's 0-based (cref:Protocol.Position).
    data struct SourceLocation(
        FilePath string,
        StartLine int32,
        StartColumn int32,
        EndLine int32,
        EndColumn int32
    ) : IEquatable[SourceLocation] { }

    /// A cache entry that keeps the (cref:MetadataReaderProvider)
    /// rooted alongside the (cref:MetadataReader) it produced, so the
    /// provider (and any native or managed buffer it owns) cannot be
    /// collected and finalized while the reader is still cached and in use.
    private data struct CachedReader(
        Provider MetadataReaderProvider,
        Reader MetadataReader,
        MtimeUtc DateTime
    ) : IEquatable[CachedReader] { }

    /// Holds the per-path lock for a cached reader while the caller uses it.
    /// Disposing the lease releases the lock. Always check
    /// (cref:IsValid) before using (cref:Reader): an invalid
    /// lease means no lock is held and (cref:Reader) is `null`.
    private struct ReaderLease : IDisposable {
        private let pathLock object?

        /// Initializes a new instance of the (cref:ReaderLease) struct
        /// that holds [`pathLock`](paramref) until disposed.
        /// @param pathLock The per-path lock, already entered by the caller.
        /// @param reader The cached reader to hand out while the lock is held.
        init(pathLock object, reader MetadataReader) {
            this.pathLock = pathLock
            Reader = reader
        }

        /// Gets the cached reader. Only valid to use while the lease is held (i.e. before (cref:Dispose) is
        /// called).
        prop Reader MetadataReader {
            get;
        }

        /// Gets a value indicating whether this lease holds a lock and carries a usable (cref:Reader).
        prop IsValid bool -> pathLock != nil

        /// Releases the per-path lock acquired for this lease, if any.
        func Dispose() {
            if pathLock != nil {
                Monitor.Exit(pathLock!!)
            }
        }

        shared {
            /// A lease value representing a failed lookup: no lock is held.
            let Invalid ReaderLease = default(ReaderLease)
        }
    }

    private let ReaderCache ConcurrentDictionary[string, CachedReader] = ConcurrentDictionary[string, CachedReader](
        StringComparer.OrdinalIgnoreCase
    )

    /// Per-path locks that serialize cache load/replace against reader use, so
    /// a cache replacement never disposes a (cref:MetadataReaderProvider)
    /// while another thread is still reading through it.
    private let PathLocks ConcurrentDictionary[string, object] = ConcurrentDictionary[string, object](
        StringComparer.OrdinalIgnoreCase
    )

    /// Resolves a method's first sequence point to a source file and span.
    /// Returns `false` when no portable PDB is reachable from
    /// the supplied assembly path, or when the metadata token has no sequence
    /// points (e.g. compiler-generated or PDB-less builds).
    /// @param assemblyFilePath Absolute path to the imported assembly, as
    /// it appears in the project's reference list.
    /// @param methodMetadataToken A 0x06xxxxxx-typed
    /// `MethodInfo.MetadataToken`.
    /// @param location The resolved source location on success.
    /// @returns True when a source location was found.
    func TryGetMethodSourceLocation(
        assemblyFilePath string,
        methodMetadataToken int32,
        out location SourceLocation
    ) bool {
        location = default(SourceLocation)
        if string.IsNullOrEmpty(assemblyFilePath) {
            return false
        }
        // Per cmt above: prefer the runtime assembly's PDB when the input is a refint shim.
        let probePath = RebaseRefIntPath(assemblyFilePath)
        var lease = GetOrLoadReaderLease(probePath)
        if !lease.IsValid && !string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase) {
            lease = GetOrLoadReaderLease(assemblyFilePath)
        }
        {
            using let _ = lease
            if !lease.IsValid {
                return false
            }
            return TryReadFirstSequencePoint(lease.Reader, methodMetadataToken, out location)
        }
    }

    /// Resolves a type's source location by walking its methods (constructors
    /// first, then declared methods) and returning the earliest sequence point
    /// found. The earliest declaration is the best proxy for "where the type
    /// is defined": even if the methods live in a partial across multiple
    /// files, the first sequence point of the first non-synthetic method
    /// reliably lands at or just inside the type's body.
    /// @param assemblyFilePath Absolute path to the imported assembly.
    /// @param typeMetadataToken A 0x02xxxxxx-typed `Type.MetadataToken`.
    /// @param location The resolved source location on success.
    /// @returns True when at least one sequence point was found for the type.
    func TryGetTypeSourceLocation(assemblyFilePath string, typeMetadataToken int32, out location SourceLocation) bool {
        location = default(SourceLocation)
        if string.IsNullOrEmpty(assemblyFilePath) {
            return false
        }
        let probePath = RebaseRefIntPath(assemblyFilePath)
        var lease = GetOrLoadReaderLease(probePath)
        if !lease.IsValid && !string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase) {
            lease = GetOrLoadReaderLease(assemblyFilePath)
        }
        {
            using let _ = lease
            if !lease.IsValid {
                return false
            }
            // The PDB MethodDebugInformation table is parallel to the PE
            // MethodDef table; we don't need the PE here because the supplied
            // method tokens are already resolved by the caller from
            // typeDef.GetMethods(). Resolve them via the PE alongside the PDB.
            if !TryReadTypeMethodTokens(probePath, typeMetadataToken, out var methodTokens) {
                if !string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase) {
                    if !TryReadTypeMethodTokens(assemblyFilePath, typeMetadataToken, out methodTokens) {
                        return false
                    }
                } else {
                    return false
                }
            }
            var best SourceLocation? = nil
            for methodToken in methodTokens {
                if TryReadFirstSequencePoint(lease.Reader, methodToken, out var candidate) {
                    if best == nil || IsEarlier(candidate, best!!) {
                        best = candidate
                    }
                }
            }
            if best == nil {
                return false
            }
            location = best
            return true
        }
    }

    private func IsEarlier(a SourceLocation, b SourceLocation) bool {
        let cmp = string.Compare(a.FilePath, b.FilePath, StringComparison.OrdinalIgnoreCase)
        if cmp != 0 {
            return cmp < 0
        }
        if a.StartLine != b.StartLine {
            return a.StartLine < b.StartLine
        }
        return a.StartColumn < b.StartColumn
    }

    private func TryReadTypeMethodTokens(
        assemblyFilePath string,
        typeMetadataToken int32,
        out methodTokens IReadOnlyList[int32]
    ) bool {
        methodTokens = Array.Empty[int32]()
        if !File.Exists(assemblyFilePath) {
            return false
        }
        try {
            using let stream = FileStream(
                assemblyFilePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete
            )
            using let peReader = PEReader(stream)
            if !peReader.HasMetadata {
                return false
            }
            let mdReader = peReader.GetMetadataReader()
            let handle = MetadataTokens.EntityHandle(typeMetadataToken)
            if handle.Kind != HandleKind.TypeDefinition {
                return false
            }
            let typeDef = mdReader.GetTypeDefinition(TypeDefinitionHandle(handle))
            let collected = List[int32]()
            for methodHandle in typeDef.GetMethods() {
                collected.Add(MetadataTokens.GetToken(methodHandle))
            }
            methodTokens = collected
            return collected.Count > 0
        } catch (IOException) {
            return false
        } catch (BadImageFormatException) {
            return false
        } catch (UnauthorizedAccessException) {
            return false
        }
    }

    private func TryReadFirstSequencePoint(
        reader MetadataReader,
        methodMetadataToken int32,
        out location SourceLocation
    ) bool {
        location = default(SourceLocation)
        try {
            let entityHandle = MetadataTokens.EntityHandle(methodMetadataToken)
            if entityHandle.Kind != HandleKind.MethodDefinition {
                return false
            }
            let debugInfoHandle = (MethodDefinitionHandle(entityHandle)).ToDebugInformationHandle()
            let debugInfo = reader.GetMethodDebugInformation(debugInfoHandle)
            if debugInfo.SequencePointsBlob.IsNil {
                return false
            }
            for sp in debugInfo.GetSequencePoints() {
                if sp.IsHidden {
                    continue
                }
                let doc = reader.GetDocument(sp.Document)
                let filePath = reader.GetString(doc.Name)
                location = SourceLocation(filePath, sp.StartLine, sp.StartColumn, sp.EndLine, sp.EndColumn)
                return true
            }
            return false
        } catch (BadImageFormatException) {
            return false
        } catch (ArgumentOutOfRangeException) {
            return false
        }
    }

    /// Acquires the per-path lock, ensures the cached reader for
    /// [`assemblyFilePath`](paramref) is up to date with the file's
    /// current write time (disposing and replacing a stale
    /// (cref:MetadataReaderProvider) if needed), and returns a lease
    /// that holds the lock until disposed. The caller must use the reader
    /// only while the lease is held (e.g. inside a `using` block) and
    /// must check (cref:ReaderLease.IsValid) before use.
    /// @remarks Every path out of this method (normal return, invalid-lease return,
    /// or an exception) releases `pathLock` exactly once: the lock is
    /// only handed off to the returned (cref:ReaderLease) on success,
    /// and the local reference is cleared as soon as ownership transfers, so
    /// the `finally` block only releases the lock when this method is
    /// still holding it itself. This keeps a thrown exception (e.g. a
    /// (cref:BadImageFormatException) from a partially-written PDB)
    /// from leaving the lock held forever, which would otherwise deadlock
    /// every future lookup for the same assembly path. A freshly loaded
    /// (cref:MetadataReaderProvider) that has not yet been installed
    /// into the cache is disposed on the exception path so it does not leak
    /// its native or managed buffer.
    private func GetOrLoadReaderLease(assemblyFilePath string) ReaderLease {
        var pathLock object? = PathLocks.GetOrAdd(assemblyFilePath, (_ string) -> SystemObject())
        Monitor.Enter(pathLock!!)
        var loadedProvider MetadataReaderProvider? = nil
        try {
            if !File.Exists(assemblyFilePath) {
                return ReaderLease.Invalid
            }
            var mtimeUtc DateTime
            try {
                mtimeUtc = File.GetLastWriteTimeUtc(assemblyFilePath)
            } catch (IOException) {
                return ReaderLease.Invalid
            }
            if ReaderCache.TryGetValue(assemblyFilePath, out var cached) && cached.MtimeUtc == mtimeUtc {
                let hitLease = ReaderLease(pathLock!!, cached.Reader)
                pathLock = nil // Ownership transferred to the lease; do not release in finally.
                return hitLease
            }
            loadedProvider = LoadReaderProvider(assemblyFilePath)
            if loadedProvider == nil {
                return ReaderLease.Invalid
            }
            let loadedReader = loadedProvider.GetMetadataReader()
            ReaderCache[assemblyFilePath] = CachedReader(loadedProvider, loadedReader, mtimeUtc)
            loadedProvider = nil // Now owned by the cache; do not dispose it below.
            // The stale entry's reader is no longer reachable from the cache and no
            // other thread can be reading it: we hold this path's lock, and every
            // reader is only ever used while that lock is held.
            cached.Provider?.Dispose()
            let missLease = ReaderLease(pathLock!!, loadedReader)
            pathLock = nil // Ownership transferred to the lease; do not release in finally.
            return missLease
        } catch {
            // A provider that was loaded but never installed into the cache
            // would otherwise leak its underlying buffer.
            loadedProvider?.Dispose()
            rethrow
        } finally {
            if pathLock != nil {
                Monitor.Exit(pathLock)
            }
        }
    }

    private func LoadReaderProvider(assemblyFilePath string) MetadataReaderProvider? {
        try {
            let sidecar = Path.ChangeExtension(assemblyFilePath, ".pdb")
            if File.Exists(sidecar) {
                // Read the file into memory so MetadataReaderProvider keeps the
                // bytes alive after the underlying file handle is closed
                // (FromPortablePdbImage stores the buffer directly).
                let bytes = File.ReadAllBytes(sidecar)
                return MetadataReaderProvider.FromPortablePdbImage(ImmutableArray.Create(bytes))
            }
            // Probe the PE for an embedded PDB.
            using let stream = FileStream(
                assemblyFilePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete
            )
            using let peReader = PEReader(stream)
            if !peReader.HasMetadata {
                return nil
            }
            let debugDirectory = peReader.ReadDebugDirectory()
            let embedded = debugDirectory.FirstOrDefault(
                (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb
            )
            if embedded.DataSize == 0 {
                return nil
            }
            // The embedded-PDB provider owns a native-heap buffer that is
            // released by its finalizer; it must be cached (not just the
            // reader it hands out) so the buffer stays alive for as long as
            // the reader is used.
            return peReader.ReadEmbeddedPortablePdbDebugDirectoryData(embedded)
        } catch (IOException) {
            return nil
        } catch (BadImageFormatException) {
            return nil
        } catch (UnauthorizedAccessException) {
            return nil
        }
    }

    /// Rewrites a path ending in `obj/.../refint/{Name}.dll` to the
    /// sibling runtime DLL `obj/.../{Name}.dll`. Returns the input
    /// unchanged when the segment `refint` is not present.
    private func RebaseRefIntPath(path string) string {
        if string.IsNullOrEmpty(path) {
            return path
        }
        let directory = Path.GetDirectoryName(path)
        if string.IsNullOrEmpty(directory) {
            return path
        }
        let leaf = Path.GetFileName(directory)
        if !string.Equals(leaf, "refint", StringComparison.OrdinalIgnoreCase) && !string.Equals(
            leaf,
            "ref",
            StringComparison.OrdinalIgnoreCase
        ) {
            return path
        }
        let parent = Path.GetDirectoryName(directory)
        if string.IsNullOrEmpty(parent) {
            return path
        }
        let candidate = Path.Combine(parent, Path.GetFileName(path))
        return if File.Exists(candidate) {
            candidate
        } else {
            path
        }
    }
}
