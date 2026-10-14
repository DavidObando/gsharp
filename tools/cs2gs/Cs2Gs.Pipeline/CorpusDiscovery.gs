// <copyright file="CorpusDiscovery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml
import System.Xml.Linq

/// Discovers (cref:CorpusApp) descriptors from a corpus directory
/// (ADR-0115 §E). Each app is one `.csproj`; the target kind is read from
/// the project's `OutputType` (`Exe` → executable, otherwise library),
/// and a sibling `baseline.stdout.golden` becomes the optional stdout
/// golden. Test projects (`*.Tests`) are excluded — stage 4 will own them.
shared class CorpusDiscovery {
    /// The marker file (sibling to the `.csproj`) that opts an app into
    /// (cref:CorpusApp.AllowUnsafeIl) (issue #1933): stage 3 treats the
    /// app's known-unverifiable unsafe IL (pointer writes, `fixed`,
    /// `stackalloc`) as expected rather than gating, mirroring the
    /// always-on (cref:IlVerifyRunner.KnownIlVerifyFalsePositives)
    /// ignore bundle but opt-in per app. When the file lists fixture type
    /// names (one per line), the allowance is scoped to just those types
    /// (issue #1985) — a blank/empty marker keeps the original whole-app
    /// allowance for apps that are unsafe-by-design throughout (e.g. G12).
    const AllowUnsafeIlMarkerFileName string = "ilverify.allow-unsafe"

    /// Discovers the non-test corpus apps under [`corpusDirectory`](paramref),
    /// ordered by id so the simplest app is migrated first.
    /// @param corpusDirectory The corpus root directory.
    /// @returns The discovered corpus apps.
    /// @exception DirectoryNotFoundException The corpus directory does not exist.
    func Discover(corpusDirectory string?) IReadOnlyList[CorpusApp] {
        if corpusDirectory == nil {
            throw ArgumentNullException("corpusDirectory")
        }
        let fullCorpus = Path.GetFullPath(corpusDirectory)
        if !Directory.Exists(fullCorpus) {
            throw DirectoryNotFoundException("Corpus directory not found: $fullCorpus")
        }
        let apps = List[CorpusApp]()
        for projectPath in Directory
            .EnumerateFiles(fullCorpus, "*.csproj", SearchOption.AllDirectories)
            .Where((p string) -> !IsUnderBinOrObj(p))
            .OrderBy((p string) -> p, StringComparer.Ordinal) {
            let projectDir string? = Path.GetDirectoryName(projectPath)
            let folderName = DirectoryInfo(projectDir!!).Name
            if folderName.EndsWith(".Tests", StringComparison.OrdinalIgnoreCase) {
                continue
            }
            let id = "corpus/" + folderName
            let target = ReadTargetKind(projectPath)
            let golden = Path.Combine(projectDir!!, "baseline.stdout.golden")
            let stdoutGolden string? = if File.Exists(golden) {
                golden
            } else {
                default(string?)
            }
            let (testsProject, testsBaseline) = FindSiblingTestOracle(fullCorpus, folderName)
            let allowUnsafeIl = File.Exists(Path.Combine(projectDir!!, AllowUnsafeIlMarkerFileName))
            let allowUnsafeIlTypes = if allowUnsafeIl {
                ReadAllowUnsafeIlTypes(Path.Combine(projectDir!!, AllowUnsafeIlMarkerFileName))
            } else {
                cast[IReadOnlyList[string]](Array.Empty[string]())
            }
            apps.Add(
                CorpusApp(
                    id,
                    projectPath,
                    target,
                    stdoutGolden,
                    referencedAssemblies: nil,
                    testsProjectPath: testsProject,
                    testsBaselinePath: testsBaseline,
                    allowUnsafeIl: allowUnsafeIl,
                    allowUnsafeIlTypes: allowUnsafeIlTypes
                )
            )
        }
        return apps
    }

    /// Builds a single (cref:CorpusApp) from an explicit id, locating its
    /// `.csproj` by folder name under the corpus directory.
    /// @param corpusDirectory The corpus root directory.
    /// @param id The app id (e.g. `corpus/L1-Console` or `L1-Console`).
    /// @returns The corpus app, or `null` if not found.
    func FindById(corpusDirectory string, id string) CorpusApp? {
        let folderName = if id.StartsWith("corpus/", StringComparison.Ordinal) {
            id.Substring("corpus/".Length)
        } else {
            id
        }
        return Discover(corpusDirectory).FirstOrDefault(
            (a CorpusApp) -> string.Equals(a.Id, "corpus/" + folderName, StringComparison.OrdinalIgnoreCase)
        )
    }

    /// Reads the marker file's non-blank, non-comment (`#`-prefixed)
    /// lines as fixture type names (issue #1985 per-fixture scoping). An
    /// empty/blank-only marker keeps the original whole-app allowance.
    /// @param markerPath The marker file path.
    /// @returns The scoped fixture type names.
    internal func ReadAllowUnsafeIlTypes(markerPath string) IReadOnlyList[string] {
        return File
            .ReadAllLines(markerPath)
            .Select((line string) -> line.Trim())
            .Where((line string) -> line.Length > 0 && !line.StartsWith("#", StringComparison.Ordinal))
            .ToList()
    }

    /// Reads the effective `<OutputType>` or executable SDK default
    /// from an SDK-style project.
    /// @param projectPath The project file path.
    /// @returns The effective target kind.
    internal func ReadTargetKind(projectPath string) TargetKind {
        try {
            let doc = XDocument.Load(projectPath)
            let outputType string? = doc
                .Descendants()
                .Where(
                (e XElement) -> string.Equals(e.Name.LocalName, "OutputType", StringComparison.OrdinalIgnoreCase)
            )
                .Select((e XElement) -> e.Value?.Trim())
                .LastOrDefault((v string) -> !string.IsNullOrEmpty(v))
            let executableSdk = doc.Root != nil && SdkPin.ProjectSdkNames(doc.Root).Any(
                (value string) -> value.Equals("Microsoft.NET.Sdk.Worker", StringComparison.OrdinalIgnoreCase) ||
                    value.Equals("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase)
            )
            return if string.Equals(outputType, "Exe", StringComparison.OrdinalIgnoreCase) || string.Equals(
                outputType,
                "WinExe",
                StringComparison.OrdinalIgnoreCase
            ) ||
                (string.IsNullOrEmpty(outputType) && executableSdk) {
                TargetKind.Exe
            } else {
                TargetKind.Library
            }
        } catch (IOException) {
            return TargetKind.Library
        } catch (XmlException) {
            return TargetKind.Library
        }
    }

    private func IsUnderBinOrObj(path string) bool {
        let normalized = path.Replace('\\', '/')
        return normalized.Contains("/bin/", StringComparison.Ordinal) || normalized.Contains(
            "/obj/",
            StringComparison.Ordinal
        )
    }

    private func FindSiblingTestOracle(corpusRoot string, folderName string)(
        TestsProject string?,
        TestsBaseline string?
    ) {
        // A library app `<X>` is verified by stage 4 against a sibling
        // `<X>.Tests` project plus its committed `baseline.tests.json` oracle.
        let testsFolder = Path.Combine(corpusRoot, folderName + ".Tests")
        if !Directory.Exists(testsFolder) {
            return (nil, nil)
        }
        let baseline = Path.Combine(testsFolder, "baseline.tests.json")
        let testsProject string? = Directory
            .EnumerateFiles(testsFolder, "*.csproj", SearchOption.TopDirectoryOnly)
            .Where((p string) -> !IsUnderBinOrObj(p))
            .OrderBy((p string) -> p, StringComparer.Ordinal)
            .FirstOrDefault()
        return (
            testsProject,
            if File.Exists(baseline) {
                baseline
            } else {
                default(string?)
            }
        )
    }
}
