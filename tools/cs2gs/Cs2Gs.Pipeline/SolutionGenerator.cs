// <copyright file="SolutionGenerator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>Generates target .slnx files with migrated project paths rewritten.</summary>
internal static class SolutionGenerator
{
    private static readonly Regex SlnProjectPattern = new Regex(
        "^Project\\(\"[^\"]+\"\\) = \"[^\"]+\", \"(?<path>[^\"]+)\",",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    internal static IReadOnlyList<string> Generate(
        string sourceRoot,
        string targetRoot,
        IReadOnlyDictionary<string, string> generatedProjectPaths)
    {
        if (string.IsNullOrEmpty(targetRoot) || generatedProjectPaths is null || generatedProjectPaths.Count == 0)
        {
            return Array.Empty<string>();
        }

        Directory.CreateDirectory(targetRoot);
        string fullSourceRoot = string.IsNullOrEmpty(sourceRoot)
            ? CommonDirectory(generatedProjectPaths.Keys)
            : Path.GetFullPath(sourceRoot);
        IReadOnlyList<string> sourceSolutions = Directory.Exists(fullSourceRoot)
            ? Directory.EnumerateFiles(fullSourceRoot, "*.sln", SearchOption.TopDirectoryOnly)
                .Concat(Directory.EnumerateFiles(fullSourceRoot, "*.slnx", SearchOption.TopDirectoryOnly))
                .OrderBy(path => path, StringComparer.Ordinal)
                .ToList()
            : Array.Empty<string>();

        var written = new List<string>();
        var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (sourceSolutions.Count == 0)
        {
            string name = new DirectoryInfo(fullSourceRoot).Name;
            written.Add(WriteSolution(
                Path.Combine(targetRoot, name + ".slnx"),
                generatedProjectPaths.Values,
                targetRoot));
            return written;
        }

        foreach (string sourceSolution in sourceSolutions)
        {
            var targetProjects = new List<string>();
            foreach (string sourceProject in ReadProjects(sourceSolution))
            {
                string canonical = Path.GetFullPath(sourceProject);
                targetProjects.Add(
                    generatedProjectPaths.TryGetValue(canonical, out string generated)
                        ? generated
                        : canonical);
            }

            if (!targetProjects.Any(project =>
                generatedProjectPaths.Values.Contains(project, StringComparer.OrdinalIgnoreCase)))
            {
                continue;
            }

            string baseName = Path.GetFileNameWithoutExtension(sourceSolution);
            string fileName = baseName + ".slnx";
            for (int suffix = 2; !usedNames.Add(fileName); suffix++)
            {
                fileName = baseName + "." + suffix + ".slnx";
            }

            written.Add(WriteSolution(Path.Combine(targetRoot, fileName), targetProjects, targetRoot));
        }

        return written;
    }

    internal static IReadOnlyList<string> ReadProjects(string solutionPath)
    {
        string directory = Path.GetDirectoryName(Path.GetFullPath(solutionPath));
        if (Path.GetExtension(solutionPath).Equals(".slnx", StringComparison.OrdinalIgnoreCase))
        {
            return XDocument.Load(solutionPath)
                .Descendants()
                .Where(element => element.Name.LocalName.Equals("Project", StringComparison.OrdinalIgnoreCase))
                .Select(element => element.Attribute("Path")?.Value)
                .Where(path => !string.IsNullOrEmpty(path))
                .Select(path => Path.GetFullPath(Path.Combine(directory, path)))
                .ToList();
        }

        return File.ReadLines(solutionPath)
            .Select(line => SlnProjectPattern.Match(line))
            .Where(match => match.Success)
            .Select(match => match.Groups["path"].Value)
            .Where(path => Path.GetExtension(path).EndsWith("proj", StringComparison.OrdinalIgnoreCase))
            .Select(path => Path.GetFullPath(Path.Combine(
                directory,
                path.Replace('\\', Path.DirectorySeparatorChar))))
            .ToList();
    }

    private static string WriteSolution(string path, IEnumerable<string> projects, string targetRoot)
    {
        var solution = new XElement(
            "Solution",
            projects
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(project =>
                {
                    var element = new XElement(
                        "Project",
                        new XAttribute(
                            "Path",
                            Path.GetRelativePath(targetRoot, project).Replace('\\', '/')));
                    if (Path.GetExtension(project).Equals(".gsproj", StringComparison.OrdinalIgnoreCase))
                    {
                        element.SetAttributeValue("Type", "C#");
                    }

                    return element;
                }));
        File.WriteAllText(path, solution.ToString() + Environment.NewLine);
        return path;
    }

    private static string CommonDirectory(IEnumerable<string> paths)
    {
        string[] fullPaths = paths.Select(Path.GetFullPath).ToArray();
        string common = Path.GetDirectoryName(fullPaths[0]);
        while (fullPaths.Any(path =>
            !path.StartsWith(common + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))
        {
            common = Path.GetDirectoryName(common);
        }

        return common;
    }
}
