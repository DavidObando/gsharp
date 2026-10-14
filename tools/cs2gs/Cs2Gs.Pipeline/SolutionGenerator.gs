// <copyright file="SolutionGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Xml.Linq

/// Generates target .slnx files with migrated project paths rewritten.
internal shared class SolutionGenerator {
    private let SlnProjectPattern Regex = Regex(
        "^Project\\(\"[^\"]+\"\\) = \"[^\"]+\", \"(?<path>[^\"]+)\",",
        RegexOptions.Compiled | RegexOptions.CultureInvariant
    )

    internal func Generate(
        sourceRoot string?,
        targetRoot string,
        generatedProjectPaths IReadOnlyDictionary[string, string]?
    ) IReadOnlyList[string] {
        if string.IsNullOrEmpty(targetRoot) || generatedProjectPaths == nil || generatedProjectPaths.Count == 0 {
            return Array.Empty[string]()
        }
        Directory.CreateDirectory(targetRoot)
        let fullSourceRoot string? = if string.IsNullOrEmpty(sourceRoot) {
            CommonDirectory(generatedProjectPaths.Keys)
        } else {
            Path.GetFullPath(sourceRoot!!)
        }
        let sourceSolutions IReadOnlyList[string] = if Directory.Exists(fullSourceRoot) {
            cast[IReadOnlyList[string]](
                Directory
                    .EnumerateFiles(fullSourceRoot!!, "*.sln", SearchOption.TopDirectoryOnly)
                    .Concat(Directory.EnumerateFiles(fullSourceRoot!!, "*.slnx", SearchOption.TopDirectoryOnly))
                    .OrderBy((path string) -> path, StringComparer.Ordinal)
                    .ToList()
            )
        } else {
            cast[IReadOnlyList[string]](Array.Empty[string]())
        }
        let written = List[string]()
        let usedNames = HashSet[string](StringComparer.OrdinalIgnoreCase)
        if sourceSolutions.Count == 0 {
            let name = DirectoryInfo(fullSourceRoot!!).Name
            written.Add(
                WriteSolution(Path.Combine(targetRoot, name + ".slnx"), generatedProjectPaths.Values, targetRoot)
            )
            return written
        }
        for sourceSolution in sourceSolutions {
            let targetProjects = List[string]()
            for sourceProject in ReadProjects(sourceSolution) {
                let canonical = Path.GetFullPath(sourceProject)
                targetProjects.Add(
                    if generatedProjectPaths.TryGetValue(canonical, out var generated) {
                        generated
                    } else {
                        canonical
                    }
                )
            }
            if !targetProjects.Any(
                (project string) -> generatedProjectPaths.Values.Contains(project, StringComparer.OrdinalIgnoreCase)
            ) {
                continue
            }
            let baseName = Path.GetFileNameWithoutExtension(sourceSolution)
            var fileName = baseName + ".slnx"
            for var suffix = 2; !usedNames.Add(fileName); suffix++ {
                fileName = baseName + "." + suffix.ToString() + ".slnx"
            }
            written.Add(WriteSolution(Path.Combine(targetRoot, fileName), targetProjects, targetRoot))
        }
        return written
    }

    internal func ReadProjects(solutionPath string) IReadOnlyList[string] {
        let directory string? = Path.GetDirectoryName(Path.GetFullPath(solutionPath))
        if Path.GetExtension(solutionPath).Equals(".slnx", StringComparison.OrdinalIgnoreCase) {
            return XDocument
                .Load(solutionPath)
                .Descendants()
                .Where(
                (element XElement) -> element.Name.LocalName.Equals("Project", StringComparison.OrdinalIgnoreCase)
            )
                .Select((element XElement) -> element.Attribute(XName?("Path")!!)?.Value)
                .Where((path string) -> !string.IsNullOrEmpty(path))
                .Select((path string) -> Path.GetFullPath(Path.Combine(directory!!, path)))
                .ToList()
        }
        return File
            .ReadLines(solutionPath)
            .Select((line string) -> SlnProjectPattern.Match(line))
            .Where((match Match) -> match.Success)
            .Select((match Match) -> match.Groups["path"].Value)
            .Where((path string) -> Path.GetExtension(path).EndsWith("proj", StringComparison.OrdinalIgnoreCase))
            .Select(
            (path string) -> Path.GetFullPath(
                Path.Combine(directory!!, path.Replace('\\', Path.DirectorySeparatorChar))
            )
        )
            .ToList()
    }

    private func WriteSolution(path string, projects IEnumerable[string], targetRoot string) string {
        let solution = XElement(
            XName?("Solution")!!,
            projects.Distinct(StringComparer.OrdinalIgnoreCase).Select(
                (project string) -> {
                    let element = XElement(
                        XName?("Project")!!,
                        XAttribute(XName?("Path")!!, Path.GetRelativePath(targetRoot, project).Replace('\\', '/'))
                    )
                    if Path.GetExtension(project).Equals(".gsproj", StringComparison.OrdinalIgnoreCase) {
                        element.SetAttributeValue(XName?("Type")!!, "C#")
                    }
                    return element
                }
            )
        )
        File.WriteAllText(path, solution.ToString() + Environment.NewLine)
        return path
    }

    private func CommonDirectory(paths IEnumerable[string]) string? {
        let fullPaths = paths.Select(Path.GetFullPath).ToArray()
        var common string? = Path.GetDirectoryName(fullPaths[0])
        while fullPaths.Any(
            (path string) -> !path.StartsWith(common + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
        ) {
            common = Path.GetDirectoryName(common)
        }
        return common
    }
}
