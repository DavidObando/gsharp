// <copyright file="TestSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Locates the compiler's own source tree for the guards that read it.
///
/// Issue #4656: that tree is C# today and becomes G# when the compiler is
/// migrated, so a root is valid when it holds the parser in exactly one of the
/// two languages, and (cref:SourceExtension) tells a guard which one it
/// is reading. Guards enumerate through (cref:SourceFiles), which fails
/// when a scan finds nothing: a guard that reads zero files must fail, never
/// pass.
internal shared class TestSource {
    // Same stage-4 contract as GsharpTestProjectRunner.
    internal const SourceRootEnvironmentVariable string = "CS2GS_TEST_SOURCE_ROOT"

    internal const CSharpExtension string = ".cs"
    internal const GSharpExtension string = ".gs"
    private let ParserWithoutExtension string = Path.Combine("src", "Core", "CodeAnalysis", "Syntax", "Parser")

    // Resolved once per test run: the environment and the tree do not change
    // under a running suite, and every guard asks.
    private let CachedRoot Lazy[string] = Lazy[string](
        () -> FindRoot(Environment.GetEnvironmentVariable(SourceRootEnvironmentVariable), AppContext.BaseDirectory)
    )

    private let CachedExtension Lazy[string] = Lazy[string](() -> SourceExtensionOf(CachedRoot.Value))
    internal prop Root string -> CachedRoot.Value

    /// Gets the extension of the compiler's sources under (cref:Root):
    /// (cref:CSharpExtension) before the G# cut-over,
    /// (cref:GSharpExtension) after it.
    internal prop SourceExtension string -> CachedExtension.Value

    /// Gets a value indicating whether (cref:Root) holds G# sources.
    internal prop IsGSharp bool -> SourceExtension == GSharpExtension

    internal func FindRoot(configuredRoot string?, startDirectory string) string {
        if !string.IsNullOrWhiteSpace(configuredRoot) {
            let root = Path.GetFullPath(configuredRoot)
            if HasSolution(root) && HasParserInOneLanguage(root) {
                return root
            }
            throw DirectoryNotFoundException(
                "$SourceRootEnvironmentVariable must name the compiler's source tree (C# or G#): '$root'."
            )
        }
        for var directory DirectoryInfo? = DirectoryInfo(startDirectory);
            directory != nil;
            directory = directory!!
            .Parent {
            if HasSolution(directory.FullName) {
                if HasParserInOneLanguage(directory.FullName) {
                    return directory.FullName
                }
                break
            }
        }
        throw DirectoryNotFoundException(
            "Could not find the compiler's source tree. Set $SourceRootEnvironmentVariable."
        )
    }

    /// The language of the tree at [`root`](paramref), decided by which
    /// parser file it holds.
    /// @param root A source root.
    /// @returns The source extension, including the dot.
    internal func SourceExtensionOf(root string) string {
        let csharp = File.Exists(Path.Combine(root, ParserWithoutExtension + CSharpExtension))
        let gsharp = File.Exists(Path.Combine(root, ParserWithoutExtension + GSharpExtension))
        if csharp == gsharp {
            throw DirectoryNotFoundException(
                "'$root' must hold the parser in exactly one language (Parser.cs or Parser.gs)."
            )
        }
        return if csharp {
            CSharpExtension
        } else {
            GSharpExtension
        }
    }

    /// The absolute path of one compiler source file, given its
    /// repository-relative path WITHOUT an extension.
    /// @param relativePathWithoutExtension For example `src/Core/CodeAnalysis/Emit/SlotPlanner`.
    /// @returns The path in the tree's language.
    internal func SourcePath(relativePathWithoutExtension string) string {
        RequireNoExtension(relativePathWithoutExtension)
        return Path.Combine(TestSource.Root, NormalizeRelative(relativePathWithoutExtension) + SourceExtension)
    }

    /// Every compiler source file under the given repository-relative
    /// directories, in the tree's language, skipping build output.
    /// @param option Whether to recurse.
    /// @param relativeDirectories Repository-relative directories, each of which must exist.
    /// @returns The absolute paths, sorted.
    /// @exception DirectoryNotFoundException A directory is missing.
    /// @exception InvalidOperationException The scan found no files.
    internal func SourceFiles(option SearchOption, relativeDirectories ...string) IReadOnlyList[
        string
    ] -> SourceFilesMatching("*", option, relativeDirectories)

    /// As (cref:SourceFiles), restricted to file names matching
    /// [`stemPattern`](paramref) (a wildcard pattern without extension).
    /// @param stemPattern For example `Parser*`.
    /// @param option Whether to recurse.
    /// @param relativeDirectories Repository-relative directories, each of which must exist.
    /// @returns The absolute paths, sorted.
    internal func SourceFilesMatching(
        stemPattern string,
        option SearchOption,
        relativeDirectories ...string
    ) IReadOnlyList[string] {
        RequireNoExtension(stemPattern)
        let root = TestSource.Root
        let extension = SourceExtension
        // A set: overlapping directories must not count a file twice. Paths are
        // folded only on Windows; elsewhere (including case-sensitive macOS
        // volumes) two spellings may be two files.
        let files = HashSet[string](
            if OperatingSystem.IsWindows() {
                StringComparer.OrdinalIgnoreCase
            } else {
                StringComparer.Ordinal
            }
        )
        for relative in relativeDirectories {
            let directory = Path.Combine(root, NormalizeRelative(relative))
            if !Directory.Exists(directory) {
                throw DirectoryNotFoundException(
                    "Source guard directory '$relative' does not exist under '$root'. A guard over a moved " +
                        "directory must be updated, not allowed to scan nothing."
                )
            }
            files.UnionWith(EnumerateSkippingBuildOutput(directory, stemPattern + extension, option))
        }
        if files.Count == 0 {
            throw InvalidOperationException(
                "Source guard scanned zero '$stemPattern$extension' files under ${string.Join(", ", relativeDirectories)}; " +
                    "a guard that reads nothing proves nothing (#4656)."
            )
        }
        return files.OrderBy((path string) -> path, StringComparer.Ordinal).ToList()
    }

    /// The repository-relative path of a source file without its extension, so
    /// allow-lists and inventories name a file the same way in both languages.
    /// @param absolutePath A path under (cref:Root).
    /// @returns For example `src/Core/CodeAnalysis/Lowering/Lowerer`.
    internal func RelativeStem(absolutePath string) string {
        let relative = Path.GetRelativePath(TestSource.Root, absolutePath).Replace('\\', '/')
        return relative.Substring(0, relative.Length - Path.GetExtension(relative).Length)
    }

    /// Issue #4656: the C# text of a fixture under `test/Core.Tests/Fixtures`
    /// that a test compiles with Roslyn as a C#-authored reference. The
    /// migration translates those fixtures to G# with the rest of the project,
    /// so each one used this way is also kept verbatim as
    /// `test/Core.Tests/TestData/CSharpFixtureSources/<fixture file name>.txt`,
    /// the full file name including `.cs` plus `.txt` (for example
    /// `InterpolatedStringHandlerFixtures.cs.txt`).
    /// While the live C# file exists it is returned and must equal the
    /// snapshot (no drift); after the cut-over the snapshot is returned.
    /// @param fileName For example `InterpolatedStringHandlerFixtures.cs`.
    /// @returns The fixture's C# source.
    internal func CSharpFixtureSource(fileName string) string -> CSharpFixtureSource(TestSource.Root, fileName)

    /// As (cref:CSharpFixtureSource(string)), under an explicit source root.
    /// @param root The source root.
    /// @param fileName The fixture file name.
    /// @returns The fixture's C# source.
    internal func CSharpFixtureSource(root string, fileName string) string {
        if string.IsNullOrEmpty(fileName) || fileName != Path.GetFileName(fileName) || !fileName.EndsWith(
            CSharpExtension,
            StringComparison.OrdinalIgnoreCase
        ) {
            throw ArgumentException("'$fileName' must be a bare C# fixture file name.", "fileName")
        }
        let snapshotPath = Path.Combine(
            root,
            "test",
            "Core.Tests",
            "TestData",
            "CSharpFixtureSources",
            fileName + ".txt"
        )
        if !File.Exists(snapshotPath) {
            throw FileNotFoundException("The C# fixture snapshot is missing.", snapshotPath)
        }
        let snapshot = File.ReadAllText(snapshotPath)
        let livePath = Path.Combine(root, "test", "Core.Tests", "Fixtures", fileName)
        if File.Exists(livePath) {
            let live = File.ReadAllText(livePath)
            if !string.Equals(live, snapshot, StringComparison.Ordinal) {
                throw InvalidOperationException(
                    "$snapshotPath is out of date with $livePath. Copy the fixture over the snapshot: the " +
                        "snapshot is what this test compiles once the fixtures are G#."
                )
            }
            return live
        }
        // The snapshot must be THIS fixture: its header names the file, and it
        // declares the fixtures namespace.
        if !snapshot.Contains("file=\"$fileName\"", StringComparison.Ordinal) || !snapshot.Contains(
            "namespace GSharp.Core.Tests.Fixtures",
            StringComparison.Ordinal
        ) {
            throw InvalidOperationException("$snapshotPath does not hold the C# fixture $fileName.")
        }
        return snapshot
    }

    // Walks the tree without descending into obj/ or bin/, which can be far
    // larger than the sources they sit beside.
    private func EnumerateSkippingBuildOutput(directory string, pattern string, option SearchOption) sequence[string] {
        for file in Directory.EnumerateFiles(directory, pattern, SearchOption.TopDirectoryOnly) {
            yield file
        }
        if option != SearchOption.AllDirectories {
            yield break
        }
        for child in Directory.EnumerateDirectories(directory) {
            let name = Path.GetFileName(child)
            if string.Equals(name, "obj", StringComparison.OrdinalIgnoreCase) || string.Equals(
                name,
                "bin",
                StringComparison.OrdinalIgnoreCase
            ) {
                continue
            }
            for file in EnumerateSkippingBuildOutput(child, pattern, option) {
                yield file
            }
        }
    }

    // The helpers add the tree's extension themselves; a caller passing one
    // would otherwise build `X.cs.cs` and fail confusingly.
    private func RequireNoExtension(pathOrPattern string) {
        let extension = Path.GetExtension(pathOrPattern)
        if extension.Equals(CSharpExtension, StringComparison.OrdinalIgnoreCase) || extension.Equals(
            GSharpExtension,
            StringComparison.OrdinalIgnoreCase
        ) {
            throw ArgumentException(
                "'$pathOrPattern' must not carry a source extension; the tree's own is added.",
                "pathOrPattern"
            )
        }
    }

    // Repository-relative paths may be written with either separator.
    private func NormalizeRelative(relative string) string -> relative.Replace('\\', '/').Replace(
        '/',
        Path.DirectorySeparatorChar
    )

    private func HasSolution(directory string) bool -> RepositoryRootMarker.IsRoot(directory)

    // Callers have already established that `root` holds a solution file.
    private func HasParserInOneLanguage(root string) bool {
        let csharp = File.Exists(Path.Combine(root, ParserWithoutExtension + CSharpExtension))
        let gsharp = File.Exists(Path.Combine(root, ParserWithoutExtension + GSharpExtension))
        return csharp != gsharp
    }
}
