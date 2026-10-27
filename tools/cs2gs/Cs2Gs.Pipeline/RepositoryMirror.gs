// <copyright file="RepositoryMirror.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq
import Cs2Gs.Translator.Loading

/// Creates the non-source portion of an exact repository mirror.
internal shared class RepositoryMirror {
    internal func Prepare(
        sourceRoot string?,
        destinationRoot string?,
        generatedProjectPaths IReadOnlyDictionary[string, string]? = nil
    ) IReadOnlyList[string] {
        let source = Path.GetFullPath(sourceRoot!!)
        let destination = Path.GetFullPath(destinationRoot!!)
        ValidateDestination(source, destination)
        let files = RepositoryFileInventory.Enumerate(source)
        let verbatim = RepositoryVerbatimSources.Compute(source, files)
        ValidateCollisions(files, verbatim)
        RepositoryGitMetadata.Prepare(source, destination)
        for relativePath in files {
            let extension = Path.GetExtension(relativePath)
            if (extension.Equals(".cs", StringComparison.OrdinalIgnoreCase) && !verbatim.Contains(relativePath)) ||
                extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                ".sln",
                StringComparison.OrdinalIgnoreCase
            ) ||
                extension.Equals(".slnx", StringComparison.OrdinalIgnoreCase) {
                continue
            }
            let target = Path.Combine(destination, relativePath)
            Directory.CreateDirectory(Path.GetDirectoryName(target)!!)
            CopyFile(Path.Combine(source, relativePath), target, source, destination, generatedProjectPaths)
        }
        return files
    }

    /// Issue #3772: mirrors the project files of excluded projects that have
    /// nothing to translate.
    /// @remarks (cref:Prepare) skips every `.csproj` because the translated
    /// `.gsproj` normally replaces it. For a project the run excluded
    /// there is no `.gsproj`, so the mirror ends up with the project's
    /// directory but no project — a half project. That is fine when the
    /// sources are missing too (they were `.cs` files nobody translated),
    /// but wrong when they are all still there, which is the case for a
    /// project excluded because it is ALREADY G# (`src/Sdk/Gsharp.Extensions`):
    /// the mirror carries its complete `.gs` source set and drops only the
    /// file that makes it buildable, breaking every consumer that references it.
    ///
    /// The rule is therefore "the mirror never contains a half project": an
    /// excluded project whose sources are all mirrored verbatim (it declares no
    /// `.cs` file under its own directory) keeps its project file, with
    /// project references retargeted to the generated projects.
    /// @param sourceRoot The repository source root.
    /// @param destinationRoot The mirror root.
    /// @param sourceFiles The repository inventory, relative to [`sourceRoot`](paramref).
    /// @param excludedScope The run's excluded scope.
    /// @param generatedProjectPaths Source project path to generated project path.
    /// @param sdkMoniker The pinned `Gsharp.NET.Sdk` moniker every mirrored project builds with.
    /// @returns The mirror-relative paths of the project files written.
    internal func MirrorExcludedProjects(
        sourceRoot string?,
        destinationRoot string?,
        sourceFiles IReadOnlyList[string]?,
        excludedScope RepositoryExcludedScope?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?,
        sdkMoniker string
    ) IReadOnlyList[string] {
        var excludedScope = excludedScope
        excludedScope ??= RepositoryExcludedScope.None
        let source = Path.GetFullPath(sourceRoot!!)
        let destination = Path.GetFullPath(destinationRoot!!)
        let csharpSourceDirectories = HashSet[string](StringComparer.OrdinalIgnoreCase)
        for path in sourceFiles!! {
            if Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase) {
                var directory = DirectoryOf(path)
                while directory.Length > 0 {
                    if !csharpSourceDirectories.Add(directory) {
                        break
                    }
                    directory = DirectoryOf(directory)
                }
            }
        }
        let written = List[string]()
        for path in sourceFiles!! {
            let extension = Path.GetExtension(path)
            if !extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase) || !excludedScope!!.IsExcluded(path) ||
                csharpSourceDirectories.Contains(DirectoryOf(path)) {
                continue
            }
            let target = Path.Combine(destination, path.Replace('/', Path.DirectorySeparatorChar))
            Directory.CreateDirectory(Path.GetDirectoryName(target)!!)
            let project = XDocument.Load(
                Path.Combine(source, path.Replace('/', Path.DirectorySeparatorChar)),
                LoadOptions.PreserveWhitespace
            )
            RetargetProjectReferences(project, source, destination, path, generatedProjectPaths)
            RebindToPinnedSdk(project, sdkMoniker)
            project.Save(target, SaveOptions.DisableFormatting)
            written.Add(path.Replace('/', Path.DirectorySeparatorChar))
        }
        return written
    }

    /// Issue #4350: copies explicitly-passthrough C# projects and sources into
    /// the migrated repository without translating them.
    /// @param sourceRoot The repository source root.
    /// @param destinationRoot The migrated repository root.
    /// @param sourceFiles The repository inventory.
    /// @param passthroughScope The projects and sources selected for passthrough.
    /// @param generatedProjectPaths Source project path to generated project path.
    /// @returns The mirror-relative project and source paths written.
    internal func MirrorPassthroughProjects(
        sourceRoot string?,
        destinationRoot string?,
        sourceFiles IReadOnlyList[string]?,
        passthroughScope RepositoryExcludedScope?,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) IReadOnlyList[string] {
        var passthroughScope = passthroughScope
        passthroughScope ??= RepositoryExcludedScope.None
        let source = Path.GetFullPath(sourceRoot!!)
        let destination = Path.GetFullPath(destinationRoot!!)
        let written = List[string]()
        for path in sourceFiles!! {
            if !passthroughScope!!.IsExcluded(path) {
                continue
            }
            let extension = Path.GetExtension(path)
            if !extension.Equals(".cs", StringComparison.OrdinalIgnoreCase) && !extension.Equals(
                ".csproj",
                StringComparison.OrdinalIgnoreCase
            ) {
                continue
            }
            let sourcePath = Path.Combine(source, path.Replace('/', Path.DirectorySeparatorChar))
            let targetPath = Path.Combine(destination, path.Replace('/', Path.DirectorySeparatorChar))
            Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!!)
            if extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase) {
                let project = XDocument.Load(sourcePath, LoadOptions.PreserveWhitespace)
                RetargetProjectReferences(project, source, destination, path, generatedProjectPaths)
                project.Save(targetPath, SaveOptions.DisableFormatting)
            } else {
                File.Copy(sourcePath, targetPath, overwrite: true)
            }
            written.Add(path.Replace('/', Path.DirectorySeparatorChar))
        }
        return written
    }

    /// Rebinds mirrored G# SDK declarations in projects and shared MSBuild files.
    /// @param destinationRoot The mirrored repository root.
    /// @param sdkMoniker The run's SDK moniker.
    internal func RebindMirroredSdkFiles(destinationRoot string?, sdkMoniker string) {
        for path in SdkPin.BuildableSdkFilePaths(destinationRoot) {
            let project = XDocument.Load(path, LoadOptions.PreserveWhitespace)
            if project.Root == nil || !SdkPin.ProjectSdkNames(project.Root).Any(
                (name string) -> string.Equals(name, SdkPin.PackageId, StringComparison.OrdinalIgnoreCase)
            ) {
                continue
            }
            SdkPin.RebindProjectSdk(project.Root, sdkMoniker)
            project.Save(path, SaveOptions.DisableFormatting)
        }
    }

    internal func ValidateCompleted(
        sourceRoot string?,
        destinationRoot string?,
        sourceFiles IReadOnlyList[string]?,
        additionalFiles IEnumerable[string]? = nil,
        excludedScope RepositoryExcludedScope? = nil,
        translatedSourceFiles IEnumerable[string]? = nil
    ) {
        var excludedScope = excludedScope
        // Issue #3580: sources a targeted run's --exclude removed from scope
        // have no TRANSLATED mirrors by design — the completeness contract
        // applies only to in-scope files. Only the translated shapes are
        // filtered (.cs → .gs, .csproj → .gsproj); every other file was
        // copied verbatim by Prepare regardless of scope and stays expected.
        excludedScope ??= RepositoryExcludedScope.None
        let verbatim = RepositoryVerbatimSources.Compute(sourceRoot, sourceFiles)
        let expected = HashSet[string](
            sourceFiles!!.Where(
                (path string) -> {
                    let extension = Path.GetExtension(path)
                    let translated = (
                        extension.Equals(".cs", StringComparison.OrdinalIgnoreCase) && !verbatim.Contains(path)
                    ) ||
                        extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase)
                    return !translated || !excludedScope!!.IsExcluded(path)
                }
            )
                .SelectMany(
                func (path string) IEnumerable[string] {
                    return DestinationRelativePaths(path, verbatim)
                }
            ),
            StringComparer.OrdinalIgnoreCase
        )
        if additionalFiles != nil {
            expected.UnionWith(additionalFiles)
        }
        // Issue #3993: an excluded project may link a shared source that an
        // included project also evaluates. The exclusion scope alone cannot
        // decide ownership; the repository-wide translation manifest can.
        if translatedSourceFiles != nil {
            let source = Path.GetFullPath(sourceRoot!!)
            expected.UnionWith(
                translatedSourceFiles
                    .Select((path string) -> Path.GetRelativePath(source, Path.GetFullPath(path)))
                    .Where((path string) -> !RepositoryFileInventory.HasExcludedDirectory(path))
                    .SelectMany(
                    func (path string) IEnumerable[string] {
                        return DestinationRelativePaths(path, nil)
                    }
                )
            )
        }
        if !sourceFiles!!.Any(
            (path string) -> Path.GetExtension(path).Equals(".sln", StringComparison.OrdinalIgnoreCase) ||
                Path
                .GetExtension(path).Equals(".slnx", StringComparison.OrdinalIgnoreCase)
        ) {
            expected.Add(DirectoryInfo(Path.GetFullPath(sourceRoot!!)).Name + ".slnx")
        }
        // Issue #3580: compiling the mirrored projects (the via-sdk stage
        // builds INSIDE the destination) leaves bin/obj build outputs there.
        // The source inventory never lists those directories, so the
        // destination walk must skip them by the same rule or every build
        // artifact reads as "unexpected".
        let actual = HashSet[string](
            Directory
                .EnumerateFiles(destinationRoot!!, "*", SearchOption.AllDirectories)
                .Select((path string) -> Path.GetRelativePath(destinationRoot!!, path))
                .Where((path string) -> !RepositoryFileInventory.HasExcludedDirectory(path)),
            StringComparer.OrdinalIgnoreCase
        )
        let missing string? = expected
            .Except(actual, StringComparer.OrdinalIgnoreCase)
            .OrderBy((x string) -> x)
            .FirstOrDefault()
        if missing != nil {
            throw InvalidOperationException(
                "Repository migration did not produce expected file '$missing'. " +
                    "Ensure every checked-in C# file is included by a migrated project."
            )
        }
        let unexpected string? = actual
            .Except(expected, StringComparer.OrdinalIgnoreCase)
            .OrderBy((x string) -> x)
            .FirstOrDefault()
        if unexpected != nil {
            throw InvalidOperationException("Repository migration produced unexpected file '$unexpected'.")
        }
    }

    internal func ValidateDestination(sourceRoot string, destinationRoot string) {
        if !Directory.Exists(sourceRoot) {
            throw DirectoryNotFoundException("Source directory not found: $sourceRoot")
        }
        if string.Equals(sourceRoot, destinationRoot, StringComparison.OrdinalIgnoreCase) {
            throw InvalidOperationException("The migration destination must differ from the source directory.")
        }
        if IsUnderDirectory(destinationRoot, sourceRoot) || IsUnderDirectory(sourceRoot, destinationRoot) {
            throw InvalidOperationException("The migration source and destination must not contain one another.")
        }
        if Directory.Exists(destinationRoot) && Directory.EnumerateFileSystemEntries(destinationRoot).Any() {
            throw InvalidOperationException("Migration destination must be empty: $destinationRoot")
        }
    }

    private func ValidateCollisions(files IEnumerable[string], verbatim ISet[string]) {
        let destinations = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        for source in files {
            for destination in DestinationRelativePaths(source, verbatim) {
                if destinations.TryGetValue(destination, out var prior) {
                    throw InvalidOperationException(
                        "Migration output collision: '$prior' and '$source' both map to '$destination'."
                    )
                }
                destinations[destination] = source
            }
        }
    }

    private func DirectoryOf(relativePath string) string {
        let separator = relativePath.LastIndexOfAny([]char{'/', Path.DirectorySeparatorChar})
        return if separator < 0 {
            string.Empty
        } else {
            relativePath.Substring(0, separator)
        }
    }

    private func RetargetProjectReferences(
        project XDocument,
        sourceRoot string,
        destinationRoot string,
        relativeProjectPath string,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) {
        if generatedProjectPaths == nil || generatedProjectPaths.Count == 0 {
            return
        }
        let sourceDirectory string? = Path.GetDirectoryName(
            Path.Combine(sourceRoot, relativeProjectPath.Replace('/', Path.DirectorySeparatorChar))
        )
        let destinationDirectory string? = Path.GetDirectoryName(
            Path.Combine(destinationRoot, relativeProjectPath.Replace('/', Path.DirectorySeparatorChar))
        )
        let mappedExpressions = GSharpProjectTransformer.RewriteDeclaredProjectPathExpressions(
            project,
            sourceDirectory,
            destinationDirectory,
            generatedProjectPaths
        )
        GSharpProjectTransformer.SplitMixedProjectReferencesForMirror(
            project,
            mappedExpressions,
            sourceDirectory,
            destinationDirectory,
            generatedProjectPaths
        )
        GSharpProjectTransformer.RewriteNestedProjectPathsForMirror(
            project,
            sourceDirectory,
            destinationDirectory,
            generatedProjectPaths
        )
        for reference in project
            .Descendants()
            .Where(
            (element XElement) -> element.Name.LocalName.Equals("ProjectReference", StringComparison.OrdinalIgnoreCase)
        )
            .ToList() {
            let include XAttribute? = reference.Attribute(XName?("Include")!!)
            if include == nil || GSharpProjectTransformer.TryRewriteExpression(
                include,
                mappedExpressions,
                sourceDirectory,
                destinationDirectory,
                generatedProjectPaths
            ) {
                continue
            }
            let referenced = Path.GetFullPath(
                Path.Combine(
                    sourceDirectory!!,
                    include.Value.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar)
                )
            )
            if generatedProjectPaths.TryGetValue(referenced, out var generated) {
                include.Value = Path.GetRelativePath(destinationDirectory!!, generated).Replace('\\', '/')
            }
        }
    }

    /// Rebinds a mirrored project onto the pinned `Gsharp.NET.Sdk`, the way
    /// every other project in the mirror is built.
    /// @remarks The one project this applies to today, `src/Sdk/Gsharp.Extensions`,
    /// is built in the source repository by the BOOTSTRAP SDK: it resolves
    /// `gsc.dll` and the build task out of `out/bin/<cfg>/` at
    /// project-evaluation time, which exists there only because the repo build
    /// orders the compiler first. A mirror has no such ordering — the shards
    /// build one app each on a clean runner — so the bootstrap's
    /// `UsingTask` condition is false and the build dies with MSB4036
    /// before anything is compiled. The mirror does not need the bootstrap at
    /// all: it exists to break a cycle (an assembly cannot reference itself
    /// while being built) that a PINNED SDK package does not have. Rebinding
    /// costs the toolchain-only project references, which are exactly the
    /// bootstrap's build-ordering arrows.
    private func RebindToPinnedSdk(project XDocument, sdkMoniker string) {
        if string.IsNullOrEmpty(sdkMoniker) || project.Root == nil {
            return
        }
        // Bootstrap projects can explicitly import Microsoft.NET.Sdk before
        // their bootstrap targets; both imports must still be replaced.
        let bootstrapImports = project.Root!!
            .Descendants()
            .Where(
            (element XElement) -> element
                .Name
                .LocalName
                .Equals("Import", StringComparison.OrdinalIgnoreCase) &&
                element
                .Attribute(XName?("Project")!!)
                ?.Value
                ?.Contains("Gsharp.NET.Sdk.Bootstrap", StringComparison.OrdinalIgnoreCase) == true
        )
            .ToArray()
        let bootstrapProject = bootstrapImports.Length > 0
        if !bootstrapProject && SdkPin.RebindProjectSdk(project.Root, sdkMoniker) {
            return
        }
        for import_ in project.Root!!
            .Descendants()
            .Where((element XElement) -> element.Name.LocalName.Equals("Import", StringComparison.OrdinalIgnoreCase))
            .ToList() {
            let importedSdk string? = import_.Attribute(XName?("Sdk")!!)?.Value
            if !bootstrapImports.Contains(import_) &&
                (
                string.IsNullOrWhiteSpace(importedSdk) ||
                    (
                    !SdkPin.IsGsharpSdkAttribute(importedSdk) && !string.Equals(
                        importedSdk!!.Trim(),
                        "Microsoft.NET.Sdk",
                        StringComparison.OrdinalIgnoreCase
                    )
                )
            ) {
                continue
            }
            import_.Remove()
        }
        SdkPin.RebindProjectSdk(project.Root, sdkMoniker, migrateCSharpSdk: true)
        for reference in project.Root!!
            .Descendants()
            .Where(
            (element XElement) -> element
                .Name
                .LocalName
                .Equals("ProjectReference", StringComparison.OrdinalIgnoreCase) &&
                string
                .Equals(
                element.Attribute(XName?("ReferenceOutputAssembly")!!)?.Value?.Trim(),
                "false",
                StringComparison.OrdinalIgnoreCase
            )
        )
            .ToList() {
            reference.Remove()
        }
    }

    private func CopyFile(
        source string,
        destination string,
        sourceRoot string,
        destinationRoot string,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) {
        let fileName = Path.GetFileName(source)
        let extension = Path.GetExtension(source)
        var content string? = nil
        var changed = false
        if fileName.Equals("Directory.Build.props", StringComparison.OrdinalIgnoreCase) || fileName.Equals(
            "Directory.Packages.props",
            StringComparison.OrdinalIgnoreCase
        ) {
            content = File.ReadAllText(source)
            if NerdbankGitVersioningPolicy.TryBumpProjectXml(content, out var bumped) {
                content = bumped
                changed = true
            }
        }
        if (
            extension.Equals(".props", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                ".targets",
                StringComparison.OrdinalIgnoreCase
            )
        ) &&
            generatedProjectPaths != nil &&
            generatedProjectPaths.Count != 0 {
            content ??= File.ReadAllText(source)
            let document = XDocument.Parse(content!!, LoadOptions.PreserveWhitespace)
            if GSharpProjectTransformer.RewriteProjectItemPaths(
                document,
                Path.GetDirectoryName(source),
                Path.GetDirectoryName(destination),
                sourceRoot,
                destinationRoot,
                generatedProjectPaths
            ) {
                document.Save(destination, SaveOptions.DisableFormatting)
                return
            }
        }
        if changed {
            File.WriteAllText(destination, content)
            return
        }
        File.Copy(source, destination)
    }

    // A legacy `.sln` produces TWO mirrored files, not a rename: the solution
    // keeps its own name (issue #3772 — the repository's own sources anchor
    // the repository root by that file name, so renaming it makes the mirror
    // internally inconsistent) and the `.slnx` conversion is emitted beside it
    // because only the XML format can type-tag a `.gsproj`.
    //
    // Issue #4850: a `.cs` file in `verbatim` (RepositoryVerbatimSources) is
    // copied as itself, not translated to `.gs`.
    private func DestinationRelativePaths(source string, verbatim ISet[string]?) sequence[string] {
        let extension = Path.GetExtension(source)
        if extension.Equals(".cs", StringComparison.OrdinalIgnoreCase) && verbatim != nil && verbatim.Contains(source) {
            yield source
            yield break
        }
        if extension.Equals(".cs", StringComparison.OrdinalIgnoreCase) {
            yield Path.ChangeExtension(source, ".gs")
            yield break
        }
        if extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase) {
            yield Path.ChangeExtension(source, ".gsproj")
            yield break
        }
        if extension.Equals(".sln", StringComparison.OrdinalIgnoreCase) {
            yield source
            yield Path.ChangeExtension(source, ".slnx")
            yield break
        }
        yield source
    }

    private func IsUnderDirectory(path string, directory string) bool {
        let relative = Path.GetRelativePath(directory, path)
        return !Path.IsPathRooted(relative) && !relative.Equals("..", StringComparison.Ordinal) && !relative.StartsWith(
            ".." + Path.DirectorySeparatorChar,
            StringComparison.Ordinal
        ) &&
            !relative.StartsWith(".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal)
    }
}
