// <copyright file="MetadataReferenceCache.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Gsgen.Cli

import GSharp.Core.CodeAnalysis.Compilation
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Security.Cryptography

/// Bounded immutable metadata images for a single generator worker.
/// Content hashes detect replacement even when assembly identity and timestamps do not change.
class MetadataReferenceCache {
    private const MaximumBytes int64 = 128 * 1024 * 1024
    private const MaximumEntries int32 = 512
    private let entries Dictionary[string, (Hash string, Reference PortableExecutableReference, Size int32)] =
    Dictionary[string, (Hash string, Reference PortableExecutableReference, Size int32)](StringComparer.Ordinal)
    private var retainedBytes int64

    /// Reads a current file snapshot and reuses only a content-identical metadata image.
    /// @param path The reference path, resolved in the current request's working directory.
    /// @returns An immutable Roslyn reference carrying the original file path.
    func GetReference(path string) MetadataReference {
        let fullPath = Path.GetFullPath(path)
        let bytes = File.ReadAllBytes(fullPath)
        CompilationMeasurements.Count("generator.metadata_bytes_read", bytes.Length)
        let hash = Convert.ToHexString(SHA256.HashData(bytes))
        if entries.TryGetValue(fullPath, out var existing) {
            if existing.Hash == hash {
                CompilationMeasurements.Count("generator.metadata_cache_hits")
                return existing.Reference
            }
            retainedBytes -= existing.Size
            entries.Remove(fullPath)
        }
        let reference = MetadataReference.CreateFromImage(ImmutableArray.CreateRange(bytes), filePath: fullPath)
        CompilationMeasurements.Count("generator.metadata_images_created")
        // Clear at a fixed ceiling rather than retaining every project closure.
        // References held by the active request remain valid after eviction.
        if entries.Count >= MaximumEntries || retainedBytes + bytes.Length > MaximumBytes {
            entries.Clear()
            retainedBytes = 0
        }
        if bytes.Length <= MaximumBytes {
            entries.Add(fullPath, (hash, reference, bytes.Length))
            retainedBytes += bytes.Length
        }
        return reference
    }
}
