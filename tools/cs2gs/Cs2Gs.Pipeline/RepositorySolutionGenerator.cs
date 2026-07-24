// <copyright file="RepositorySolutionGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Mirrors repository solutions into a generated tree and rewrites their
/// project paths to the generated projects.
/// </summary>
public static class RepositorySolutionGenerator
{
    private static readonly HashSet<string> ExcludedDirectoryNames = new HashSet<string>(
        new[] { "bin", "obj", "TestResults", ".git" },
        StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Converts and mirrors all solutions below <paramref name="sourceRoot"/>.
    /// </summary>
    /// <param name="sourceRoot">The repository source root to search recursively.</param>
    /// <param name="destinationRoot">The root under which generated solutions are written.</param>
    /// <param name="projectMapping">
    /// A source-project to generated-project path mapping. Relative source paths
    /// are resolved from <paramref name="sourceRoot"/> and relative generated
    /// paths are resolved from <paramref name="destinationRoot"/>.
    /// </param>
    /// <param name="sourceFiles">
    /// The repository inventory relative to <paramref name="sourceRoot"/>, or
    /// <see langword="null"/> to enumerate the filesystem.
    /// </param>
    /// <returns>The full paths of the generated <c>.slnx</c> files.</returns>
    /// <exception cref="ArgumentException">A root path is empty or a mapping entry has an empty path.</exception>
    /// <exception cref="ArgumentNullException"><paramref name="projectMapping"/> is <see langword="null"/>.</exception>
    /// <exception cref="DirectoryNotFoundException"><paramref name="sourceRoot"/> does not exist.</exception>
    /// <exception cref="InvalidOperationException">
    /// Multiple source solutions map to the same destination or <c>dotnet sln migrate</c> fails.
    /// </exception>
    public static IReadOnlyList<string> Generate(
        string sourceRoot,
        string destinationRoot,
        IReadOnlyDictionary<string, string> projectMapping,
        IReadOnlyList<string> sourceFiles = null)
    {
        if (string.IsNullOrWhiteSpace(sourceRoot))
        {
            throw new ArgumentException("A source root must be supplied.", nameof(sourceRoot));
        }

        if (string.IsNullOrWhiteSpace(destinationRoot))
        {
            throw new ArgumentException("A destination root must be supplied.", nameof(destinationRoot));
        }

        if (projectMapping is null)
        {
            throw new ArgumentNullException(nameof(projectMapping));
        }

        string fullSourceRoot = Path.GetFullPath(sourceRoot);
        string fullDestinationRoot = Path.GetFullPath(destinationRoot);
        if (!Directory.Exists(fullSourceRoot))
        {
            throw new DirectoryNotFoundException($"Source root '{fullSourceRoot}' does not exist.");
        }

        IReadOnlyDictionary<string, string> canonicalMapping = CanonicalizeMapping(
            projectMapping,
            fullSourceRoot,
            fullDestinationRoot);
        List<(string SourcePath, string RelativeDestinationPath)> plans =
            DiscoverSolutions(fullSourceRoot, sourceFiles)
                .Select(sourcePath =>
                {
                    string relativePath = Path.GetRelativePath(fullSourceRoot, sourcePath);
                    string relativeDestinationPath =
                        Path.GetExtension(sourcePath).Equals(".sln", StringComparison.OrdinalIgnoreCase)
                            ? Path.ChangeExtension(relativePath, ".slnx")
                            : relativePath;
                    return (sourcePath, relativeDestinationPath);
                })
                .ToList();

        DetectDestinationCollisions(plans);

        if (plans.Count == 0)
        {
            Directory.CreateDirectory(fullDestinationRoot);
            string repositoryName = new DirectoryInfo(fullSourceRoot).Name;
            if (string.IsNullOrEmpty(repositoryName))
            {
                repositoryName = "repository";
            }

            string syntheticPath = Path.Combine(fullDestinationRoot, repositoryName + ".slnx");
            WriteSyntheticSolution(syntheticPath, canonicalMapping.Values);
            return new[] { syntheticPath };
        }

        var writtenPaths = new List<string>(plans.Count);
        foreach ((string sourcePath, string relativeDestinationPath) in plans)
        {
            string destinationPath = Path.GetFullPath(
                Path.Combine(fullDestinationRoot, relativeDestinationPath));
            string destinationDirectory = Path.GetDirectoryName(destinationPath);
            Directory.CreateDirectory(destinationDirectory);

            if (Path.GetExtension(sourcePath).Equals(".sln", StringComparison.OrdinalIgnoreCase))
            {
                ConvertLegacySolution(sourcePath, destinationPath, canonicalMapping);
            }
            else
            {
                RewriteSolution(sourcePath, destinationPath, sourcePath, canonicalMapping);
            }

            writtenPaths.Add(destinationPath);
        }

        return writtenPaths;
    }

    private static IReadOnlyDictionary<string, string> CanonicalizeMapping(
        IReadOnlyDictionary<string, string> projectMapping,
        string sourceRoot,
        string destinationRoot)
    {
        var canonical = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, string> pair in projectMapping)
        {
            if (string.IsNullOrWhiteSpace(pair.Key) || string.IsNullOrWhiteSpace(pair.Value))
            {
                throw new ArgumentException("Project mapping paths must not be empty.", nameof(projectMapping));
            }

            string sourcePath = CanonicalizePath(pair.Key, sourceRoot);
            string generatedPath = CanonicalizePath(pair.Value, destinationRoot);
            if (!canonical.TryAdd(sourcePath, generatedPath))
            {
                throw new ArgumentException(
                    $"The project mapping contains more than one entry for '{sourcePath}'.",
                    nameof(projectMapping));
            }
        }

        return canonical;
    }

    private static string CanonicalizePath(string path, string relativeTo)
    {
        string normalized = path
            .Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar);
        return Path.GetFullPath(Path.IsPathRooted(normalized)
            ? normalized
            : Path.Combine(relativeTo, normalized));
    }

    private static List<string> DiscoverSolutions(
        string sourceRoot,
        IReadOnlyList<string> sourceFiles)
    {
        if (sourceFiles is not null)
        {
            return sourceFiles
                .Where(path =>
                    Path.GetExtension(path).Equals(".sln", StringComparison.OrdinalIgnoreCase) ||
                    Path.GetExtension(path).Equals(".slnx", StringComparison.OrdinalIgnoreCase))
                .Select(path => Path.GetFullPath(Path.Combine(sourceRoot, path)))
                .OrderBy(path => path, StringComparer.Ordinal)
                .ToList();
        }

        var solutions = new List<string>();
        var directories = new Stack<string>();
        directories.Push(sourceRoot);

        while (directories.Count > 0)
        {
            string directory = directories.Pop();
            foreach (string file in Directory.EnumerateFiles(directory))
            {
                string extension = Path.GetExtension(file);
                if (extension.Equals(".sln", StringComparison.OrdinalIgnoreCase) ||
                    extension.Equals(".slnx", StringComparison.OrdinalIgnoreCase))
                {
                    solutions.Add(Path.GetFullPath(file));
                }
            }

            foreach (string child in Directory.EnumerateDirectories(directory))
            {
                var childInfo = new DirectoryInfo(child);
                if (!ExcludedDirectoryNames.Contains(childInfo.Name) &&
                    (childInfo.Attributes & FileAttributes.ReparsePoint) == 0)
                {
                    directories.Push(child);
                }
            }
        }

        solutions.Sort(StringComparer.Ordinal);
        return solutions;
    }

    private static void DetectDestinationCollisions(
        IReadOnlyList<(string SourcePath, string RelativeDestinationPath)> plans)
    {
        var destinations = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach ((string sourcePath, string relativeDestinationPath) in plans)
        {
            if (destinations.TryGetValue(relativeDestinationPath, out string previousSource))
            {
                throw new InvalidOperationException(
                    $"Source solutions '{previousSource}' and '{sourcePath}' both map to " +
                    $"destination '{relativeDestinationPath}'.");
            }

            destinations.Add(relativeDestinationPath, sourcePath);
        }
    }

    private static void ConvertLegacySolution(
        string sourceSolutionPath,
        string destinationPath,
        IReadOnlyDictionary<string, string> projectMapping)
    {
        string destinationDirectory = Path.GetDirectoryName(destinationPath);
        string migrationBaseName =
            $".{Path.GetFileNameWithoutExtension(destinationPath)}.{Guid.NewGuid():N}";
        string stagedSolutionPath = Path.Combine(destinationDirectory, migrationBaseName + ".sln");
        string migratedSolutionPath = Path.Combine(destinationDirectory, migrationBaseName + ".slnx");

        try
        {
            File.Copy(sourceSolutionPath, stagedSolutionPath);
            ProcessRunResult result = ProcessRunner.Run(
                "dotnet",
                new[] { "sln", stagedSolutionPath, "migrate" },
                destinationDirectory);
            if (result.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    $"dotnet sln migrate failed for '{sourceSolutionPath}' with exit code " +
                    $"{result.ExitCode}.{Environment.NewLine}{result.Output}");
            }

            if (!File.Exists(migratedSolutionPath))
            {
                throw new InvalidOperationException(
                    $"dotnet sln migrate reported success for '{sourceSolutionPath}' but did not " +
                    $"create the expected file '{migratedSolutionPath}'.{Environment.NewLine}{result.Output}");
            }

            RewriteSolution(
                migratedSolutionPath,
                destinationPath,
                sourceSolutionPath,
                projectMapping);
        }
        finally
        {
            File.Delete(stagedSolutionPath);
            File.Delete(migratedSolutionPath);
        }
    }

    private static void RewriteSolution(
        string xmlPath,
        string destinationPath,
        string sourceSolutionPath,
        IReadOnlyDictionary<string, string> projectMapping)
    {
        XDocument solution = XDocument.Load(xmlPath, LoadOptions.PreserveWhitespace);
        string sourceSolutionDirectory = Path.GetDirectoryName(Path.GetFullPath(sourceSolutionPath));
        string destinationDirectory = Path.GetDirectoryName(Path.GetFullPath(destinationPath));

        foreach (XElement project in solution.Descendants()
            .Where(element => element.Name.LocalName.Equals("Project", StringComparison.OrdinalIgnoreCase)))
        {
            XAttribute pathAttribute = project.Attributes()
                .FirstOrDefault(attribute =>
                    attribute.Name.LocalName.Equals("Path", StringComparison.OrdinalIgnoreCase));
            if (pathAttribute is null)
            {
                continue;
            }

            string canonicalSourceProject = CanonicalizePath(
                pathAttribute.Value,
                sourceSolutionDirectory);
            if (projectMapping.TryGetValue(canonicalSourceProject, out string generatedProject))
            {
                pathAttribute.Value = Path.GetRelativePath(destinationDirectory, generatedProject)
                    .Replace('\\', '/');
                if (Path.GetExtension(generatedProject).Equals(".gsproj", StringComparison.OrdinalIgnoreCase))
                {
                    project.SetAttributeValue("Type", "C#");
                }
            }
        }

        solution.Save(destinationPath, SaveOptions.DisableFormatting);
    }

    private static void WriteSyntheticSolution(string path, IEnumerable<string> generatedProjects)
    {
        string solutionDirectory = Path.GetDirectoryName(Path.GetFullPath(path));
        var solution = new XDocument(
            new XElement(
                "Solution",
                generatedProjects
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(project => project, StringComparer.Ordinal)
                    .Select(project =>
                    {
                        string relativePath =
                            Path.GetRelativePath(solutionDirectory, project).Replace('\\', '/');
                        XAttribute projectType =
                            Path.GetExtension(project).Equals(".gsproj", StringComparison.OrdinalIgnoreCase)
                                ? new XAttribute("Type", "C#")
                                : null;
                        return new XElement(
                            "Project",
                            new XAttribute("Path", relativePath),
                            projectType);
                    })));
        solution.Save(path, SaveOptions.DisableFormatting);
    }
}
