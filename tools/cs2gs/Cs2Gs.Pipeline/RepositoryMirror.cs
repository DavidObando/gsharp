// <copyright file="RepositoryMirror.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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

    internal static void ValidateCompleted(
        string sourceRoot,
        string destinationRoot,
        IReadOnlyList<string> sourceFiles,
        IEnumerable<string> additionalFiles = null)
    {
        var expected = new HashSet<string>(
            sourceFiles.Select(DestinationRelativePath),
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

        var actual = new HashSet<string>(
            Directory.EnumerateFiles(destinationRoot, "*", SearchOption.AllDirectories)
                .Select(path => Path.GetRelativePath(destinationRoot, path)),
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
            string destination = DestinationRelativePath(source);
            if (destinations.TryGetValue(destination, out string prior))
            {
                throw new InvalidOperationException(
                    $"Migration output collision: '{prior}' and '{source}' both map to '{destination}'.");
            }

            destinations[destination] = source;
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

    private static string DestinationRelativePath(string source)
    {
        string extension = Path.GetExtension(source);
        if (extension.Equals(".cs", StringComparison.OrdinalIgnoreCase))
        {
            return Path.ChangeExtension(source, ".gs");
        }

        if (extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            return Path.ChangeExtension(source, ".gsproj");
        }

        if (extension.Equals(".sln", StringComparison.OrdinalIgnoreCase))
        {
            return Path.ChangeExtension(source, ".slnx");
        }

        return source;
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
