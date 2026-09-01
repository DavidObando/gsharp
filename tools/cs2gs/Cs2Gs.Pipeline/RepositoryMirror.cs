// <copyright file="RepositoryMirror.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Cs2Gs.Translator.Loading;

namespace Cs2Gs.Pipeline;

/// <summary>Creates the non-source portion of an exact repository mirror.</summary>
internal static class RepositoryMirror
{
    internal static IReadOnlyList<string> Prepare(string sourceRoot, string destinationRoot)
    {
        string source = Path.GetFullPath(sourceRoot);
        string destination = Path.GetFullPath(destinationRoot);
        ValidateDestination(source, destination);

        IReadOnlyList<string> files = RepositoryFileInventory.Enumerate(source);
        ValidateCollisions(files);
        Directory.CreateDirectory(destination);

        foreach (string relativePath in files)
        {
            string extension = Path.GetExtension(relativePath);
            if (extension.Equals(".cs", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".sln", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".slnx", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string target = Path.Combine(destination, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            CopyFile(Path.Combine(source, relativePath), target);
        }

        return files;
    }

    /// <summary>
    /// Issue #3772: mirrors the project files of excluded projects that have
    /// nothing to translate.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="Prepare"/> skips every <c>.csproj</c> because the translated
    /// <c>.gsproj</c> normally replaces it. For a project the run excluded
    /// there is no <c>.gsproj</c>, so the mirror ends up with the project's
    /// directory but no project — a half project. That is fine when the
    /// sources are missing too (they were <c>.cs</c> files nobody translated),
    /// but wrong when they are all still there, which is the case for a
    /// project excluded because it is ALREADY G# (<c>src/Sdk/Gsharp.Extensions</c>):
    /// the mirror carries its complete <c>.gs</c> source set and drops only the
    /// file that makes it buildable, breaking every consumer that references it.
    /// </para>
    /// <para>
    /// The rule is therefore "the mirror never contains a half project": an
    /// excluded project whose sources are all mirrored verbatim (it declares no
    /// <c>.cs</c> file under its own directory) keeps its project file, with
    /// project references retargeted to the generated projects.
    /// </para>
    /// </remarks>
    /// <param name="sourceRoot">The repository source root.</param>
    /// <param name="destinationRoot">The mirror root.</param>
    /// <param name="sourceFiles">The repository inventory, relative to <paramref name="sourceRoot"/>.</param>
    /// <param name="excludedScope">The run's excluded scope.</param>
    /// <param name="generatedProjectPaths">Source project path to generated project path.</param>
    /// <returns>The mirror-relative paths of the project files written.</returns>
    internal static IReadOnlyList<string> MirrorExcludedProjects(
        string sourceRoot,
        string destinationRoot,
        IReadOnlyList<string> sourceFiles,
        RepositoryExcludedScope excludedScope,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        excludedScope ??= RepositoryExcludedScope.None;
        string source = Path.GetFullPath(sourceRoot);
        string destination = Path.GetFullPath(destinationRoot);

        var csharpSourceDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in sourceFiles)
        {
            if (Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase))
            {
                string directory = DirectoryOf(path);
                while (directory.Length > 0)
                {
                    if (!csharpSourceDirectories.Add(directory))
                    {
                        break;
                    }

                    directory = DirectoryOf(directory);
                }
            }
        }

        var written = new List<string>();
        foreach (string path in sourceFiles)
        {
            if (!Path.GetExtension(path).Equals(".csproj", StringComparison.OrdinalIgnoreCase)
                || !excludedScope.IsExcluded(path)
                || csharpSourceDirectories.Contains(DirectoryOf(path)))
            {
                continue;
            }

            string target = Path.Combine(destination, path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            XDocument project = XDocument.Load(
                Path.Combine(source, path.Replace('/', Path.DirectorySeparatorChar)),
                LoadOptions.PreserveWhitespace);
            RetargetProjectReferences(project, source, destination, path, generatedProjectPaths);
            project.Save(target, SaveOptions.DisableFormatting);
            written.Add(path.Replace('/', Path.DirectorySeparatorChar));
        }

        return written;
    }

    internal static void ValidateCompleted(
        string sourceRoot,
        string destinationRoot,
        IReadOnlyList<string> sourceFiles,
        IEnumerable<string> additionalFiles = null,
        RepositoryExcludedScope excludedScope = null)
    {
        // Issue #3580: sources a targeted run's --exclude removed from scope
        // have no TRANSLATED mirrors by design — the completeness contract
        // applies only to in-scope files. Only the translated shapes are
        // filtered (.cs → .gs, .csproj → .gsproj); every other file was
        // copied verbatim by Prepare regardless of scope and stays expected.
        excludedScope ??= RepositoryExcludedScope.None;
        var expected = new HashSet<string>(
            sourceFiles
                .Where(path =>
                {
                    string extension = Path.GetExtension(path);
                    bool translated =
                        extension.Equals(".cs", StringComparison.OrdinalIgnoreCase)
                        || extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase);
                    return !translated || !excludedScope.IsExcluded(path);
                })
                .SelectMany(DestinationRelativePaths),
            StringComparer.OrdinalIgnoreCase);
        if (additionalFiles is not null)
        {
            expected.UnionWith(additionalFiles);
        }

        if (!sourceFiles.Any(path =>
            Path.GetExtension(path).Equals(".sln", StringComparison.OrdinalIgnoreCase) ||
            Path.GetExtension(path).Equals(".slnx", StringComparison.OrdinalIgnoreCase)))
        {
            expected.Add(new DirectoryInfo(Path.GetFullPath(sourceRoot)).Name + ".slnx");
        }

        // Issue #3580: compiling the mirrored projects (the via-sdk stage
        // builds INSIDE the destination) leaves bin/obj build outputs there.
        // The source inventory never lists those directories, so the
        // destination walk must skip them by the same rule or every build
        // artifact reads as "unexpected".
        var actual = new HashSet<string>(
            Directory.EnumerateFiles(destinationRoot, "*", SearchOption.AllDirectories)
                .Select(path => Path.GetRelativePath(destinationRoot, path))
                .Where(path => !RepositoryFileInventory.HasExcludedDirectory(path)),
            StringComparer.OrdinalIgnoreCase);

        string missing = expected.Except(actual, StringComparer.OrdinalIgnoreCase).OrderBy(x => x).FirstOrDefault();
        if (missing is not null)
        {
            throw new InvalidOperationException(
                $"Repository migration did not produce expected file '{missing}'. " +
                "Ensure every checked-in C# file is included by a migrated project.");
        }

        string unexpected = actual.Except(expected, StringComparer.OrdinalIgnoreCase).OrderBy(x => x).FirstOrDefault();
        if (unexpected is not null)
        {
            throw new InvalidOperationException(
                $"Repository migration produced unexpected file '{unexpected}'.");
        }
    }

    internal static void ValidateDestination(string sourceRoot, string destinationRoot)
    {
        if (!Directory.Exists(sourceRoot))
        {
            throw new DirectoryNotFoundException($"Source directory not found: {sourceRoot}");
        }

        if (string.Equals(sourceRoot, destinationRoot, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("The migration destination must differ from the source directory.");
        }

        if (IsUnderDirectory(destinationRoot, sourceRoot) ||
            IsUnderDirectory(sourceRoot, destinationRoot))
        {
            throw new InvalidOperationException(
                "The migration source and destination must not contain one another.");
        }

        if (Directory.Exists(destinationRoot) &&
            Directory.EnumerateFileSystemEntries(destinationRoot).Any())
        {
            throw new InvalidOperationException($"Migration destination must be empty: {destinationRoot}");
        }
    }

    private static void ValidateCollisions(IEnumerable<string> files)
    {
        var destinations = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string source in files)
        {
            foreach (string destination in DestinationRelativePaths(source))
            {
                if (destinations.TryGetValue(destination, out string prior))
                {
                    throw new InvalidOperationException(
                        $"Migration output collision: '{prior}' and '{source}' both map to '{destination}'.");
                }

                destinations[destination] = source;
            }
        }
    }

    private static string DirectoryOf(string relativePath)
    {
        int separator = relativePath.LastIndexOfAny(new[] { '/', Path.DirectorySeparatorChar });
        return separator < 0 ? string.Empty : relativePath.Substring(0, separator);
    }

    private static void RetargetProjectReferences(
        XDocument project,
        string sourceRoot,
        string destinationRoot,
        string relativeProjectPath,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        if (generatedProjectPaths is null || generatedProjectPaths.Count == 0)
        {
            return;
        }

        string sourceDirectory = Path.GetDirectoryName(
            Path.Combine(sourceRoot, relativeProjectPath.Replace('/', Path.DirectorySeparatorChar)));
        string destinationDirectory = Path.GetDirectoryName(
            Path.Combine(destinationRoot, relativeProjectPath.Replace('/', Path.DirectorySeparatorChar)));

        foreach (XElement reference in project.Descendants()
            .Where(element => element.Name.LocalName.Equals("ProjectReference", StringComparison.OrdinalIgnoreCase))
            .ToList())
        {
            XAttribute include = reference.Attribute("Include");
            if (include is null || include.Value.Contains("$(", StringComparison.Ordinal))
            {
                continue;
            }

            string referenced = Path.GetFullPath(Path.Combine(
                sourceDirectory,
                include.Value.Replace('\\', Path.DirectorySeparatorChar)
                    .Replace('/', Path.DirectorySeparatorChar)));
            if (generatedProjectPaths.TryGetValue(referenced, out string generated))
            {
                include.Value = Path.GetRelativePath(destinationDirectory, generated)
                    .Replace('\\', '/');
            }
        }
    }

    private static void CopyFile(string source, string destination)
    {
        string fileName = Path.GetFileName(source);
        if (fileName.Equals("Directory.Build.props", StringComparison.OrdinalIgnoreCase) ||
            fileName.Equals("Directory.Packages.props", StringComparison.OrdinalIgnoreCase))
        {
            string content = File.ReadAllText(source);
            if (NerdbankGitVersioningPolicy.TryBumpProjectXml(content, out string bumped))
            {
                File.WriteAllText(destination, bumped);
                return;
            }
        }

        File.Copy(source, destination);
    }

    // A legacy `.sln` produces TWO mirrored files, not a rename: the solution
    // keeps its own name (issue #3772 — the repository's own sources anchor
    // the repository root by that file name, so renaming it makes the mirror
    // internally inconsistent) and the `.slnx` conversion is emitted beside it
    // because only the XML format can type-tag a `.gsproj`.
    private static IEnumerable<string> DestinationRelativePaths(string source)
    {
        string extension = Path.GetExtension(source);
        if (extension.Equals(".cs", StringComparison.OrdinalIgnoreCase))
        {
            yield return Path.ChangeExtension(source, ".gs");
            yield break;
        }

        if (extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            yield return Path.ChangeExtension(source, ".gsproj");
            yield break;
        }

        if (extension.Equals(".sln", StringComparison.OrdinalIgnoreCase))
        {
            yield return source;
            yield return Path.ChangeExtension(source, ".slnx");
            yield break;
        }

        yield return source;
    }

    private static bool IsUnderDirectory(string path, string directory)
    {
        string relative = Path.GetRelativePath(directory, path);
        return !Path.IsPathRooted(relative) &&
            !relative.Equals("..", StringComparison.Ordinal) &&
            !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
            !relative.StartsWith(".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal);
    }
}
