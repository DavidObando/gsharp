// <copyright file="RepositorySolutionGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq

/// Mirrors repository solutions into a generated tree and rewrites their
/// project paths to the generated projects.
shared class RepositorySolutionGenerator {
    private let ExcludedDirectoryNames HashSet[string] = HashSet[string](
        []string{"bin", "obj", "TestResults", ".git"},
        StringComparer.OrdinalIgnoreCase
    )

    /// Converts and mirrors all solutions below [`sourceRoot`](paramref).
    /// @param sourceRoot The repository source root to search recursively.
    /// @param destinationRoot The root under which generated solutions are written.
    /// @param projectMapping A source-project to generated-project path mapping. Relative source paths
    /// are resolved from [`sourceRoot`](paramref) and relative generated
    /// paths are resolved from [`destinationRoot`](paramref).
    /// @param sourceFiles The repository inventory relative to [`sourceRoot`](paramref), or
    /// `null` to enumerate the filesystem.
    /// @returns The full paths of the generated `.slnx` files.
    /// @exception ArgumentException A root path is empty or a mapping entry has an empty path.
    /// @exception ArgumentNullException [`projectMapping`](paramref) is `null`.
    /// @exception DirectoryNotFoundException [`sourceRoot`](paramref) does not exist.
    /// @exception InvalidOperationException Multiple source solutions map to the same destination or
    /// `dotnet sln migrate` fails.
    func Generate(
        sourceRoot string?,
        destinationRoot string?,
        projectMapping IReadOnlyDictionary[string, string]?,
        sourceFiles IReadOnlyList[string]? = nil
    ) IReadOnlyList[string] {
        if string.IsNullOrWhiteSpace(sourceRoot) {
            throw ArgumentException("A source root must be supplied.", "sourceRoot")
        }
        if string.IsNullOrWhiteSpace(destinationRoot) {
            throw ArgumentException("A destination root must be supplied.", "destinationRoot")
        }
        if projectMapping == nil {
            throw ArgumentNullException("projectMapping")
        }
        let fullSourceRoot = Path.GetFullPath(sourceRoot)
        let fullDestinationRoot = Path.GetFullPath(destinationRoot)
        if !Directory.Exists(fullSourceRoot) {
            throw DirectoryNotFoundException("Source root '$fullSourceRoot' does not exist.")
        }
        let canonicalMapping = CanonicalizeMapping(projectMapping, fullSourceRoot, fullDestinationRoot)
        // Issue #3772: a legacy `.sln` is MIRRORED as well as converted. The
        // repository's own sources anchor the repository root by the solution's
        // file name, so a mirror that renames GSharp.sln to GSharp.slnx is not
        // the same repository; the `.slnx` conversion is emitted beside it
        // because only the XML format can type-tag a `.gsproj`.
        let plans = List[(SourcePath string, RelativeDestinationPath string)]()
        for sourcePath in DiscoverSolutions(fullSourceRoot, sourceFiles) {
            let relativePath = Path.GetRelativePath(fullSourceRoot, sourcePath)
            if Path.GetExtension(sourcePath).Equals(".sln", StringComparison.OrdinalIgnoreCase) {
                plans.Add((sourcePath, relativePath))
                plans.Add((sourcePath, Path.ChangeExtension(relativePath, ".slnx")))
            } else {
                plans.Add((sourcePath, relativePath))
            }
        }
        DetectDestinationCollisions(plans)
        if plans.Count == 0 {
            Directory.CreateDirectory(fullDestinationRoot)
            var repositoryName = DirectoryInfo(fullSourceRoot).Name
            if string.IsNullOrEmpty(repositoryName) {
                repositoryName = "repository"
            }
            let syntheticPath = Path.Combine(fullDestinationRoot, repositoryName + ".slnx")
            WriteSyntheticSolution(syntheticPath, canonicalMapping.Values)
            return []string{syntheticPath}
        }
        let writtenPaths = List[string](plans.Count)
        for (sourcePath, relativeDestinationPath) in plans {
            let destinationPath = Path.GetFullPath(Path.Combine(fullDestinationRoot, relativeDestinationPath))
            let destinationDirectory string? = Path.GetDirectoryName(destinationPath)
            Directory.CreateDirectory(destinationDirectory!!)
            if Path.GetExtension(destinationPath).Equals(".sln", StringComparison.OrdinalIgnoreCase) {
                MirrorLegacySolution(sourcePath, destinationPath, canonicalMapping)
            } else if Path.GetExtension(sourcePath).Equals(".sln", StringComparison.OrdinalIgnoreCase) {
                ConvertLegacySolution(sourcePath, destinationPath, canonicalMapping)
            } else {
                RewriteSolution(sourcePath, destinationPath, sourcePath, canonicalMapping)
            }
            writtenPaths.Add(destinationPath)
        }
        return writtenPaths
    }

    private func CanonicalizeMapping(
        projectMapping IReadOnlyDictionary[string, string],
        sourceRoot string,
        destinationRoot string
    ) IReadOnlyDictionary[string, string] {
        let canonical = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        for pair in projectMapping {
            if string.IsNullOrWhiteSpace(pair.Key) || string.IsNullOrWhiteSpace(pair.Value) {
                throw ArgumentException("Project mapping paths must not be empty.", "projectMapping")
            }
            let sourcePath = CanonicalizePath(pair.Key, sourceRoot)
            let generatedPath = CanonicalizePath(pair.Value, destinationRoot)
            if !canonical.TryAdd(sourcePath, generatedPath) {
                throw ArgumentException(
                    "The project mapping contains more than one entry for '$sourcePath'.",
                    "projectMapping"
                )
            }
        }
        return canonical
    }

    private func CanonicalizePath(path string?, relativeTo string?) string {
        let normalized = path!!
            .Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar)
        return Path.GetFullPath(
            if Path.IsPathRooted(normalized) {
                normalized
            } else {
                Path.Combine(relativeTo!!, normalized)
            }
        )
    }

    private func DiscoverSolutions(sourceRoot string, sourceFiles IReadOnlyList[string]?) List[string] {
        if sourceFiles != nil {
            return sourceFiles
                .Where(
                (path string) -> Path.GetExtension(path).Equals(".sln", StringComparison.OrdinalIgnoreCase) ||
                    Path
                    .GetExtension(path).Equals(".slnx", StringComparison.OrdinalIgnoreCase)
            )
                .Select((path string) -> Path.GetFullPath(Path.Combine(sourceRoot, path)))
                .OrderBy((path string) -> path, StringComparer.Ordinal)
                .ToList()
        }
        let solutions = List[string]()
        let directories = Stack[string]()
        directories.Push(sourceRoot)
        while directories.Count > 0 {
            let directory = directories.Pop()
            for file in Directory.EnumerateFiles(directory) {
                let extension = Path.GetExtension(file)
                if extension.Equals(".sln", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                    ".slnx",
                    StringComparison.OrdinalIgnoreCase
                ) {
                    solutions.Add(Path.GetFullPath(file))
                }
            }
            for child in Directory.EnumerateDirectories(directory) {
                let childInfo = DirectoryInfo(child)
                if !ExcludedDirectoryNames.Contains(childInfo.Name) &&
                    (childInfo.Attributes & FileAttributes.ReparsePoint) == 0 {
                    directories.Push(child)
                }
            }
        }
        solutions.Sort(StringComparer.Ordinal)
        return solutions
    }

    private func DetectDestinationCollisions(plans IReadOnlyList[(SourcePath string, RelativeDestinationPath string)]) {
        let destinations = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        for (sourcePath, relativeDestinationPath) in plans {
            if destinations.TryGetValue(relativeDestinationPath, out var previousSource) {
                throw InvalidOperationException(
                    "Source solutions '$previousSource' and '$sourcePath' both map to " +
                        "destination '$relativeDestinationPath'."
                )
            }
            destinations.Add(relativeDestinationPath, sourcePath)
        }
    }

    /// Copies a legacy `.sln` to the mirror under its own name, retargeting
    /// its project paths at the generated projects and leaving every other byte —
    /// GUIDs, folders, configuration blocks — exactly as authored.
    private func MirrorLegacySolution(
        sourceSolutionPath string,
        destinationPath string,
        projectMapping IReadOnlyDictionary[string, string]
    ) {
        let sourceSolutionDirectory string? = Path.GetDirectoryName(Path.GetFullPath(sourceSolutionPath))
        let destinationDirectory string? = Path.GetDirectoryName(Path.GetFullPath(destinationPath))
        let lines = File.ReadAllLines(sourceSolutionPath)
        for var index = 0; index < lines.Length; index++ {
            let line = lines[index]
            if !line.StartsWith("Project(", StringComparison.Ordinal) {
                continue
            }
            // Project("{type-guid}") = "Name", "relative\path.csproj", "{guid}"
            // The path is the fourth quoted field; solution folders name a
            // folder there instead of a file, and simply never match the map.
            let quotes = List[int32]()
            for var position = 0; position < line.Length; position++ {
                if line[position] == '"' {
                    quotes.Add(position)
                }
            }
            if quotes.Count < 6 {
                continue
            }
            let start = quotes[4] + 1
            let length = quotes[5] - start
            let projectPath = line.Substring(start, length)
            let canonicalSourceProject = CanonicalizePath(projectPath, sourceSolutionDirectory)
            if !projectMapping.TryGetValue(canonicalSourceProject, out var generatedProject) {
                continue
            }
            let mirrored = Path.GetRelativePath(destinationDirectory!!, generatedProject).Replace('/', '\\')
            lines[index] = line.Substring(0, start) + mirrored + line.Substring(quotes[5])
        }
        File.WriteAllLines(destinationPath, lines)
    }

    private func ConvertLegacySolution(
        sourceSolutionPath string,
        destinationPath string,
        projectMapping IReadOnlyDictionary[string, string]
    ) {
        let destinationDirectory string? = Path.GetDirectoryName(destinationPath)
        let migrationBaseName = ".${Path.GetFileNameWithoutExtension(destinationPath)}.${Guid.NewGuid():N}"
        let stagedSolutionPath = Path.Combine(destinationDirectory!!, migrationBaseName + ".sln")
        let migratedSolutionPath = Path.Combine(destinationDirectory!!, migrationBaseName + ".slnx")
        try {
            File.Copy(sourceSolutionPath, stagedSolutionPath)
            let result = ProcessRunner.Run(
                "dotnet",
                []string{"sln", stagedSolutionPath, "migrate"},
                destinationDirectory
            )
            if result.ExitCode != 0 {
                throw InvalidOperationException(
                    "dotnet sln migrate failed for '$sourceSolutionPath' with exit code " +
                        "${result.ExitCode}.${Environment.NewLine}${result.Output}"
                )
            }
            if !File.Exists(migratedSolutionPath) {
                throw InvalidOperationException(
                    "dotnet sln migrate reported success for '$sourceSolutionPath' but did not " +
                        "create the expected file '$migratedSolutionPath'.${Environment.NewLine}${result.Output}"
                )
            }
            RewriteSolution(migratedSolutionPath, destinationPath, sourceSolutionPath, projectMapping)
        } finally {
            File.Delete(stagedSolutionPath)
            File.Delete(migratedSolutionPath)
        }
    }

    private func RewriteSolution(
        xmlPath string,
        destinationPath string,
        sourceSolutionPath string,
        projectMapping IReadOnlyDictionary[string, string]
    ) {
        let solution = XDocument.Load(xmlPath, LoadOptions.PreserveWhitespace)
        let sourceSolutionDirectory string? = Path.GetDirectoryName(Path.GetFullPath(sourceSolutionPath))
        let destinationDirectory string? = Path.GetDirectoryName(Path.GetFullPath(destinationPath))
        for project in solution.Descendants().Where(
            (element XElement) -> element.Name.LocalName.Equals("Project", StringComparison.OrdinalIgnoreCase)
        ) {
            let pathAttribute XAttribute? = project.Attributes().FirstOrDefault(
                (attribute XAttribute) -> attribute.Name.LocalName.Equals("Path", StringComparison.OrdinalIgnoreCase)
            )
            if pathAttribute == nil {
                continue
            }
            let canonicalSourceProject = CanonicalizePath(pathAttribute.Value, sourceSolutionDirectory)
            if projectMapping.TryGetValue(canonicalSourceProject, out var generatedProject) {
                pathAttribute.Value = Path.GetRelativePath(destinationDirectory!!, generatedProject).Replace('\\', '/')
                if Path.GetExtension(generatedProject).Equals(".gsproj", StringComparison.OrdinalIgnoreCase) {
                    project.SetAttributeValue(XName?("Type")!!, "C#")
                }
            }
        }
        solution.Save(destinationPath, SaveOptions.DisableFormatting)
    }

    private func WriteSyntheticSolution(path string, generatedProjects IEnumerable[string]) {
        let solutionDirectory string? = Path.GetDirectoryName(Path.GetFullPath(path))
        let solution = XDocument(
            XElement(
                XName?("Solution")!!,
                generatedProjects
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy((project string) -> project, StringComparer.Ordinal)
                    .Select(
                    (project string) -> {
                        let relativePath = Path.GetRelativePath(solutionDirectory!!, project).Replace('\\', '/')
                        let projectType XAttribute? = if Path.GetExtension(project).Equals(
                            ".gsproj",
                            StringComparison.OrdinalIgnoreCase
                        ) {
                            XAttribute(XName?("Type")!!, "C#")
                        } else {
                            default(XAttribute?)
                        }
                        return XElement(XName?("Project")!!, XAttribute(XName?("Path")!!, relativePath), projectType)
                    }
                )
            )
        )
        solution.Save(path, SaveOptions.DisableFormatting)
    }
}
