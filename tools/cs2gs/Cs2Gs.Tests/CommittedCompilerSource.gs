// <copyright file="CommittedCompilerSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Issue #4656: the compiler's committed sources are C# until the G# cut-over
/// and G# after it. The self-migration inventories translate the C# today;
/// once the committed tree is G# there is nothing to translate, and the same
/// "no retired synthesized names" rule is checked as a counter over the
/// committed `.gs` files instead.
internal shared class CommittedCompilerSource {
    private let ParserWithoutExtension string = Path.Combine("src", "Core", "CodeAnalysis", "Syntax", "Parser")

    /// Whether the compiler sources under [`root`](paramref) are G#.
    /// Exactly one of `Parser.cs` and `Parser.gs` must exist; a tree
    /// with both or neither cannot say which language its inventories should read.
    /// @param root The source root.
    /// @returns `true` for a G# tree.
    internal func IsGSharp(root string) bool {
        let csharp = File.Exists(Path.Combine(root, ParserWithoutExtension + ".cs"))
        let gsharp = File.Exists(Path.Combine(root, ParserWithoutExtension + ".gs"))
        if csharp == gsharp {
            throw InvalidOperationException(
                "'$root' must hold the compiler parser in exactly one language: " +
                    "$ParserWithoutExtension.cs ${(if csharp { "found" } else { "missing" })}, " +
                    "$ParserWithoutExtension.gs ${(if gsharp { "found" } else { "missing" })}."
            )
        }
        return gsharp
    }

    /// The committed `.gs` files under the given repository-relative
    /// directories, skipping build output. Fails on a missing directory or an
    /// empty result: an inventory over nothing would report zero and pass.
    /// @param root The source root.
    /// @param relativeDirectories Repository-relative directories.
    /// @returns The file paths, sorted.
    internal func GSharpFiles(root string, relativeDirectories ...string) IReadOnlyList[string] {
        // A set: overlapping directories ("src" and "src/Core") must not count
        // a file twice.
        // Path case is folded only on Windows; elsewhere (including
        // case-sensitive macOS volumes) two spellings may be two files.
        let pathComparer = if OperatingSystem.IsWindows() {
            StringComparer.OrdinalIgnoreCase
        } else {
            StringComparer.Ordinal
        }
        let files = HashSet[string](pathComparer)
        for relative in relativeDirectories {
            let directory = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar))
            if !Directory.Exists(directory) {
                throw DirectoryNotFoundException("Inventory directory '$relative' does not exist under '$root'.")
            }
            files.UnionWith(
                Directory
                    .EnumerateFiles(directory, "*.gs", SearchOption.AllDirectories)
                    .Select(Path.GetFullPath)
                    .Where((path string) -> !IsBuildOutput(root, path))
            )
        }
        if files.Count == 0 {
            throw InvalidOperationException(
                "The inventory found no committed .gs files under ${string.Join(", ", relativeDirectories)}; " +
                    "a count over nothing proves nothing (#4656)."
            )
        }
        return files.OrderBy((path string) -> path, pathComparer).ToList()
    }

    /// Whether [`path`](paramref) lies in build output (an `obj` or
    /// `bin` segment) BELOW [`root`](paramref); the root itself may
    /// sit under a bin/ directory.
    /// @param root The scanned root.
    /// @param path A file under it.
    /// @returns `true` for build output.
    internal func IsBuildOutput(root string, path string) bool -> Path
        .GetRelativePath(root, path)
        .Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
        .Any(
        (segment string) -> string.Equals(segment, "obj", StringComparison.OrdinalIgnoreCase) || string.Equals(
            segment,
            "bin",
            StringComparison.OrdinalIgnoreCase
        )
    )
}
