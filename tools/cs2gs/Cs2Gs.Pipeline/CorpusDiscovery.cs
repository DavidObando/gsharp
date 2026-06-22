// <copyright file="CorpusDiscovery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Discovers <see cref="CorpusApp"/> descriptors from a corpus directory
/// (ADR-0115 §E). Each app is one <c>.csproj</c>; the target kind is read from
/// the project's <c>OutputType</c> (<c>Exe</c> → executable, otherwise library),
/// and a sibling <c>baseline.stdout.golden</c> becomes the optional stdout
/// golden. Test projects (<c>*.Tests</c>) are excluded — stage 4 will own them.
/// </summary>
public static class CorpusDiscovery
{
    /// <summary>
    /// Discovers the non-test corpus apps under <paramref name="corpusDirectory"/>,
    /// ordered by id so the simplest app is migrated first.
    /// </summary>
    /// <param name="corpusDirectory">The corpus root directory.</param>
    /// <returns>The discovered corpus apps.</returns>
    /// <exception cref="DirectoryNotFoundException">The corpus directory does not exist.</exception>
    public static IReadOnlyList<CorpusApp> Discover(string corpusDirectory)
    {
        if (corpusDirectory is null)
        {
            throw new ArgumentNullException(nameof(corpusDirectory));
        }

        string fullCorpus = Path.GetFullPath(corpusDirectory);
        if (!Directory.Exists(fullCorpus))
        {
            throw new DirectoryNotFoundException($"Corpus directory not found: {fullCorpus}");
        }

        var apps = new List<CorpusApp>();
        foreach (string projectPath in Directory
            .EnumerateFiles(fullCorpus, "*.csproj", SearchOption.AllDirectories)
            .Where(p => !IsUnderBinOrObj(p))
            .OrderBy(p => p, StringComparer.Ordinal))
        {
            string projectDir = Path.GetDirectoryName(projectPath);
            string folderName = new DirectoryInfo(projectDir).Name;
            if (folderName.EndsWith(".Tests", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string id = "corpus/" + folderName;
            TargetKind target = ReadTargetKind(projectPath);

            string golden = Path.Combine(projectDir, "baseline.stdout.golden");
            string stdoutGolden = File.Exists(golden) ? golden : null;

            (string testsProject, string testsBaseline) = FindSiblingTestOracle(fullCorpus, folderName);

            apps.Add(new CorpusApp(
                id,
                projectPath,
                target,
                stdoutGolden,
                referencedAssemblies: null,
                testsProjectPath: testsProject,
                testsBaselinePath: testsBaseline));
        }

        return apps;
    }

    /// <summary>
    /// Builds a single <see cref="CorpusApp"/> from an explicit id, locating its
    /// <c>.csproj</c> by folder name under the corpus directory.
    /// </summary>
    /// <param name="corpusDirectory">The corpus root directory.</param>
    /// <param name="id">The app id (e.g. <c>corpus/L1-Console</c> or <c>L1-Console</c>).</param>
    /// <returns>The corpus app, or <see langword="null"/> if not found.</returns>
    public static CorpusApp FindById(string corpusDirectory, string id)
    {
        string folderName = id.StartsWith("corpus/", StringComparison.Ordinal)
            ? id.Substring("corpus/".Length)
            : id;

        return Discover(corpusDirectory)
            .FirstOrDefault(a => string.Equals(
                a.Id,
                "corpus/" + folderName,
                StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsUnderBinOrObj(string path)
    {
        string normalized = path.Replace('\\', '/');
        return normalized.Contains("/bin/", StringComparison.Ordinal) ||
            normalized.Contains("/obj/", StringComparison.Ordinal);
    }

    private static (string TestsProject, string TestsBaseline) FindSiblingTestOracle(
        string corpusRoot,
        string folderName)
    {
        // A library app `<X>` is verified by stage 4 against a sibling
        // `<X>.Tests` project plus its committed `baseline.tests.json` oracle.
        string testsFolder = Path.Combine(corpusRoot, folderName + ".Tests");
        if (!Directory.Exists(testsFolder))
        {
            return (null, null);
        }

        string baseline = Path.Combine(testsFolder, "baseline.tests.json");
        string testsProject = Directory
            .EnumerateFiles(testsFolder, "*.csproj", SearchOption.TopDirectoryOnly)
            .Where(p => !IsUnderBinOrObj(p))
            .OrderBy(p => p, StringComparer.Ordinal)
            .FirstOrDefault();

        return (
            testsProject,
            File.Exists(baseline) ? baseline : null);
    }

    private static TargetKind ReadTargetKind(string projectPath)
    {
        try
        {
            string text = File.ReadAllText(projectPath);
            return text.Contains("<OutputType>Exe</OutputType>", StringComparison.OrdinalIgnoreCase)
                ? TargetKind.Exe
                : TargetKind.Library;
        }
        catch (IOException)
        {
            return TargetKind.Library;
        }
    }
}
