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
/// lookup. <see cref="MetadataReaderProvider"/> instances are intentionally not
/// disposed: the LSP holds them open for as long as the workspace lives.
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
        var reader = GetOrLoadReader(probePath);
        if (reader == null && !string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase))
        {
            reader = GetOrLoadReader(assemblyFilePath);
        }

        if (reader == null)
        {
            return false;
        }

        return TryReadFirstSequencePoint(reader, methodMetadataToken, out location);
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
        var reader = GetOrLoadReader(probePath);
        if (reader == null && !string.Equals(probePath, assemblyFilePath, StringComparison.OrdinalIgnoreCase))
        {
            reader = GetOrLoadReader(assemblyFilePath);
        }

        if (reader == null)
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
            if (TryReadFirstSequencePoint(reader, methodToken, out var candidate))
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
            using var stream = new FileStream(assemblyFilePath, FileMode.Open, FileAccess.Read, FileShare.Read);
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

    private static MetadataReader GetOrLoadReader(string assemblyFilePath)
    {
        if (!File.Exists(assemblyFilePath))
        {
            return null;
        }

        DateTime mtimeUtc;
        try
        {
            mtimeUtc = File.GetLastWriteTimeUtc(assemblyFilePath);
        }
        catch (IOException)
        {
            return null;
        }

        if (ReaderCache.TryGetValue(assemblyFilePath, out var cached) && cached.MtimeUtc == mtimeUtc)
        {
            return cached.Reader;
        }

        var loaded = LoadReader(assemblyFilePath);
        if (loaded == null)
        {
            return null;
        }

        ReaderCache[assemblyFilePath] = new CachedReader(loaded, mtimeUtc);
        return loaded;
    }

    private static MetadataReader LoadReader(string assemblyFilePath)
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
                var provider = MetadataReaderProvider.FromPortablePdbImage(System.Collections.Immutable.ImmutableArray.Create(bytes));
                return provider.GetMetadataReader();
            }

            // Probe the PE for an embedded PDB.
            using var stream = new FileStream(assemblyFilePath, FileMode.Open, FileAccess.Read, FileShare.Read);
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

            var embeddedProvider = peReader.ReadEmbeddedPortablePdbDebugDirectoryData(embedded);
            return embeddedProvider.GetMetadataReader();
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

    private readonly record struct CachedReader(MetadataReader Reader, DateTime MtimeUtc);
}
