// <copyright file="CorpusDiscovery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

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
    /// The marker file (sibling to the <c>.csproj</c>) that opts an app into
    /// <see cref="CorpusApp.AllowUnsafeIl"/> (issue #1933): stage 3 treats the
    /// app's known-unverifiable unsafe IL (pointer writes, <c>fixed</c>,
    /// <c>stackalloc</c>) as expected rather than gating, mirroring the
    /// always-on <see cref="IlVerifyRunner.KnownIlVerifyFalsePositives"/>
    /// ignore bundle but opt-in per app. When the file lists fixture type
    /// names (one per line), the allowance is scoped to just those types
    /// (issue #1985) — a blank/empty marker keeps the original whole-app
    /// allowance for apps that are unsafe-by-design throughout (e.g. G12).
    /// </summary>
    public const string AllowUnsafeIlMarkerFileName = "ilverify.allow-unsafe";

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

            bool allowUnsafeIl = File.Exists(Path.Combine(projectDir, AllowUnsafeIlMarkerFileName));
            IReadOnlyList<string> allowUnsafeIlTypes = allowUnsafeIl
                ? ReadAllowUnsafeIlTypes(Path.Combine(projectDir, AllowUnsafeIlMarkerFileName))
                : Array.Empty<string>();

            apps.Add(new CorpusApp(
                id,
                projectPath,
                target,
                stdoutGolden,
                referencedAssemblies: null,
                testsProjectPath: testsProject,
                testsBaselinePath: testsBaseline,
                allowUnsafeIl: allowUnsafeIl,
                allowUnsafeIlTypes: allowUnsafeIlTypes));
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

    /// <summary>
    /// Reads the marker file's non-blank, non-comment (<c>#</c>-prefixed)
    /// lines as fixture type names (issue #1985 per-fixture scoping). An
    /// empty/blank-only marker keeps the original whole-app allowance.
    /// </summary>
    /// <param name="markerPath">The marker file path.</param>
    /// <returns>The scoped fixture type names.</returns>
    internal static IReadOnlyList<string> ReadAllowUnsafeIlTypes(string markerPath)
    {
        return File.ReadAllLines(markerPath)
            .Select(line => line.Trim())
            .Where(line => line.Length > 0 && !line.StartsWith("#", StringComparison.Ordinal))
            .ToList();
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

    /// <summary>
    /// Reads the effective <c>&lt;OutputType&gt;</c> from an SDK-style csproj by
    /// parsing it as XML (issue #1749 mode 3): a substring match on the literal
    /// text <c>&lt;OutputType&gt;Exe&lt;/OutputType&gt;</c> silently
    /// misclassifies any benign reformat (added whitespace/attributes,
    /// <c>WinExe</c>) as <c>Library</c>, which flips <c>gsc</c> to
    /// <c>/target:library</c> and drops stdout-parity verification entirely. A
    /// project can declare <c>&lt;OutputType&gt;</c> in more than one (possibly
    /// conditioned) <c>PropertyGroup</c>; the last element in document order
    /// wins, approximating MSBuild's last-one-wins evaluation.
    /// </summary>
    /// <param name="projectPath">The <c>.csproj</c> path.</param>
    /// <returns>
    /// <see cref="TargetKind.Exe"/> for <c>Exe</c>/<c>WinExe</c> (both produce a
    /// runnable executable); <see cref="TargetKind.Library"/> for
    /// <c>Library</c> or a missing/unrecognized value.
    /// </returns>
    private static TargetKind ReadTargetKind(string projectPath)
    {
        try
        {
            XDocument doc = XDocument.Load(projectPath);
            string outputType = doc.Descendants()
                .Where(e => string.Equals(e.Name.LocalName, "OutputType", StringComparison.OrdinalIgnoreCase))
                .Select(e => e.Value?.Trim())
                .LastOrDefault(v => !string.IsNullOrEmpty(v));

            return string.Equals(outputType, "Exe", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(outputType, "WinExe", StringComparison.OrdinalIgnoreCase)
                ? TargetKind.Exe
                : TargetKind.Library;
        }
        catch (IOException)
        {
            return TargetKind.Library;
        }
        catch (XmlException)
        {
            return TargetKind.Library;
        }
    }
}
