// <copyright file="CSharpTestOracle.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.Json
import System.Text.Json.Serialization

/// Issue #4633: the per-test-name oracle for a mirrored test project — the set
/// of test-case display names the ORIGINAL C# project's xUnit discovery
/// reports, captured once per run before validation (see
/// `cs2gs capture-test-oracle`) and compared name-for-name against the
/// migrated run's TRX by (cref:TestNameParity).
///
/// Before this oracle the repo-app parity check was "exit 0 and at least as
/// many cases as the C# original has `[Fact]` methods": `[Theory]`
/// rows were not counted at all and no name was ever compared, so a migrated
/// suite could lose thousands of cases (2,371 in `test/Core.Tests`) and
/// stay green.
///
/// Discovery, not execution, is the C# side on purpose: listing a suite costs
/// seconds, running the C# originals again would roughly double the nightly.
/// Both sides run with (cref:RunSettingsArgument), which overrides the
/// repository's `methodDisplay: method` so every display name is fully
/// qualified (`Namespace.Class.Method(args)`); with bare method names,
/// two classes' `Works` tests would be indistinguishable.
class CSharpTestOracle {
    /// Gets or sets the corpus app id this oracle describes.
    @JsonPropertyName("appId")
    @JsonPropertyOrder(int32(0))
    prop AppId string

    /// Gets or sets the number of discovered test cases.
    @JsonPropertyName("testCount")
    @JsonPropertyOrder(int32(1))
    prop TestCount int32

    /// Gets or sets the discovered test-case display names, sorted ordinally.
    private var _tests List[string]? = List[string]()

    @JsonPropertyName("tests")
    @JsonPropertyOrder(int32(2))
    prop Tests List[string]? {
        get {
            return _tests
        }
        set {
            _tests = value
        }
    }

    /// Gets or sets the optional per-target-framework discovered test names (#4691).
    @JsonPropertyName("testsByFramework")
    @JsonPropertyOrder(int32(3))
    @JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)
    prop TestsByFramework Dictionary[string, List[string]]?

    /// Writes this oracle to [`directory`](paramref) under
    /// (cref:FileNameFor).
    /// @param directory The oracle directory.
    /// @returns The written path.
    func Write(directory string) string {
        Directory.CreateDirectory(directory)
        let path = Path.Combine(directory, FileNameFor(this.AppId))
        File.WriteAllText(path, JsonSerializer.Serialize(this, JsonSerializerOptions{WriteIndented: true}))
        return path
    }

    shared {
        /// The VSTest RunSettings override both sides pass after `--`. It
        /// takes precedence over `xunit.runner.json`.
        const RunSettingsArgument string = "xUnit.MethodDisplay=ClassAndMethod"

        /// The line `dotnet test --list-tests` prints before the names.
        const ListHeader string = "The following Tests are available:"

        /// The suffix of one app's oracle file in the oracle directory.
        const FileSuffix string = ".csharp-tests.json"

        /// The oracle file name for an app: the app's hashed artifact-directory
        /// name ((cref:MigrationPipeline.ArtifactDirectoryName), so two ids
        /// that sanitize alike, such as `a/b_c` and `a_b/c`, cannot share
        /// a file) plus (cref:FileSuffix).
        /// @param appId The corpus app id.
        /// @returns The file name (no directory).
        func FileNameFor(appId string) string {
            if string.IsNullOrEmpty(appId) {
                throw ArgumentException("An app id is required.", "appId")
            }
            return MigrationPipeline.ArtifactDirectoryName(appId, MigrationOutputLayout.Repository) + FileSuffix
        }

        /// Parses the output of `dotnet test --list-tests` into display names.
        /// Fails loudly rather than returning an empty list: an oracle with no
        /// names would turn the per-name check into a check of nothing, which is
        /// the exact defect this oracle exists to remove.
        /// @param output The captured stdout of the listing.
        /// @returns The discovered display names, in output order.
        /// @exception InvalidOperationException The output has no listing header, or lists no tests.
        func ParseListTestsOutput(output string) IReadOnlyList[string] -> ParseListTestsOutputCore(output, out _)

        /// Parses the output of `dotnet test --list-tests` into per-framework display names (#4691).
        /// @param output The captured stdout of the listing.
        /// @returns The discovered display names grouped by normalized target framework when available.
        func ParseListTestsOutputByFramework(output string) IReadOnlyDictionary[string, IReadOnlyList[string]] {
            ParseListTestsOutputCore(output, out var byFramework)
            return byFramework
        }

        private func ParseListTestsOutputCore(
            output string,
            out byFramework IReadOnlyDictionary[string, IReadOnlyList[string]]
        ) IReadOnlyList[string] {
            let lines = (output ?? string.Empty).Replace("\r\n", "\n").Split('\n')
            let names = List[string]()
            let frameworkGroups = Dictionary[string, List[string]](StringComparer.Ordinal)
            var currentFramework string? = nil
            var pendingFramework string? = nil
            var sawHeader = false
            var inBlock = false
            var allBlocksHaveFramework = true
            // Every listing block counts: a multi-targeted project prints one
            // header and one indented block per target framework.
            for line in lines {
                let trimmed = line.Trim()
                if !inBlock && TryParseBannerFramework(trimmed) is {} bannerFramework {
                    pendingFramework = bannerFramework
                }
                if string.Equals(trimmed, ListHeader, StringComparison.Ordinal) {
                    sawHeader = true
                    inBlock = true
                    currentFramework = pendingFramework
                    pendingFramework = nil
                    if string.IsNullOrEmpty(currentFramework) {
                        allBlocksHaveFramework = false
                    }
                    continue
                }
                if !inBlock || line.Length == 0 {
                    continue
                }
                // Names are the indented lines (VSTest uses four spaces; any
                // leading whitespace is accepted); an unindented line ends the block.
                if !char.IsWhiteSpace(line[0]) {
                    inBlock = false
                    currentFramework = nil
                    if TryParseBannerFramework(trimmed) is {} nextBannerFramework {
                        pendingFramework = nextBannerFramework
                    }
                    continue
                }
                let name = trimmed
                if name.Length > 0 {
                    names.Add(name)
                    if !string.IsNullOrEmpty(currentFramework) {
                        if !frameworkGroups.TryGetValue(currentFramework, out var bucket) {
                            bucket = List[string]()
                            frameworkGroups.Add(currentFramework, bucket)
                        }
                        bucket.Add(name)
                    }
                }
            }
            if !sawHeader {
                throw InvalidOperationException(
                    "`dotnet test --list-tests` printed no '" +
                        ListHeader +
                        "' line, so the C# " +
                        "test oracle cannot be read. Output tail:\n" +
                        Tail(output)
                )
            }
            if names.Count == 0 {
                throw InvalidOperationException(
                    "`dotnet test --list-tests` listed zero tests. A C# test project with no " +
                        "discoverable tests cannot serve as a parity oracle."
                )
            }
            byFramework = if allBlocksHaveFramework && frameworkGroups.Count > 0 {
                frameworkGroups.ToDictionary(
                    func (pair KeyValuePair[string, List[string]]) string {
                        return pair.Key
                    },
                    (pair KeyValuePair[string, List[string]]) -> cast[IReadOnlyList[string]](pair.Value),
                    StringComparer.Ordinal
                )
            } else {
                Dictionary[string, IReadOnlyList[string]](StringComparer.Ordinal)
            }
            return names
        }

        /// Builds an oracle from discovered names, sorted ordinally.
        /// @param appId The corpus app id.
        /// @param names The discovered display names.
        /// @param testsByFramework Optional per-framework discovered display names.
        /// @returns The oracle.
        func Create(
            appId string,
            names IEnumerable[string],
            testsByFramework IReadOnlyDictionary[string, IReadOnlyList[string]]? = nil
        ) CSharpTestOracle {
            let sorted = (names ?? Array.Empty[string]()).ToList()
            sorted.Sort(StringComparer.Ordinal)
            var normalizedByFramework Dictionary[string, List[string]]? = nil
            if testsByFramework != nil && testsByFramework.Count > 0 {
                normalizedByFramework = Dictionary[string, List[string]](StringComparer.Ordinal)
                for key in testsByFramework.Keys.OrderBy((k string) -> k, StringComparer.Ordinal) {
                    let frameworkSorted = (testsByFramework[key] ?? Array.Empty[string]()).ToList()
                    frameworkSorted.Sort(StringComparer.Ordinal)
                    normalizedByFramework.Add(NormalizeTargetFramework(key) ?? key, frameworkSorted)
                }
            }
            return CSharpTestOracle{
                AppId: appId,
                TestCount: sorted.Count,
                Tests: sorted,
                TestsByFramework: normalizedByFramework
            }
        }

        /// Builds an oracle directly from `dotnet test --list-tests` output, preserving per-framework groups.
        /// @param appId The corpus app id.
        /// @param output The captured stdout of the listing.
        /// @returns The oracle.
        func CreateFromListTestsOutput(appId string, output string) CSharpTestOracle {
            let names = ParseListTestsOutputCore(output, out var byFramework)
            return Create(appId, names, byFramework)
        }

        /// Loads the oracle for [`appId`](paramref) from
        /// [`directory`](paramref), or returns `null` when no
        /// file exists there. The CALLER decides what absence means; in the
        /// self-migration gate it is a failure, never a fallback.
        /// @param directory The oracle directory.
        /// @param appId The corpus app id.
        /// @returns The oracle, or `null` when absent.
        /// @exception InvalidOperationException The file exists but is malformed, names another app, or lists
        /// no tests.
        func LoadOrNull(directory string?, appId string) CSharpTestOracle? {
            let path = Path.Combine(directory!!, FileNameFor(appId))
            if !File.Exists(path) {
                return nil
            }
            var oracle CSharpTestOracle?
            try {
                oracle = JsonSerializer.Deserialize[CSharpTestOracle](File.ReadAllText(path))
            } catch (ex JsonException) {
                throw InvalidOperationException(path + ": not a valid C# test oracle: " + ex.Message, ex)
            }
            if oracle == nil || oracle.Tests == nil || oracle.Tests!!.Count == 0 {
                throw InvalidOperationException(path + ": the C# test oracle lists no tests.")
            }
            if oracle.Tests!!.Any(string.IsNullOrWhiteSpace) {
                throw InvalidOperationException(path + ": the C# test oracle contains an empty test name.")
            }
            if oracle.TestCount != oracle.Tests!!.Count {
                throw InvalidOperationException(
                    path + ": the C# test oracle says " + oracle.TestCount.ToString() +
                        " test(s) but lists " +
                        oracle.Tests!!
                        .Count
                        .ToString() + "; the file is truncated or was edited."
                )
            }
            if !string.Equals(oracle.AppId, appId, StringComparison.Ordinal) {
                throw InvalidOperationException(
                    path + ": the C# test oracle describes '" + oracle.AppId + "', not '" + appId + "'."
                )
            }
            if oracle.TestsByFramework != nil && oracle.TestsByFramework!!.Count > 0 {
                if oracle.TestsByFramework!!.Any(
                    (pair KeyValuePair[string, List[string]]) -> string.IsNullOrWhiteSpace(pair.Key) ||
                        pair.Value == nil ||
                        pair
                        .Value
                        .Count == 0 ||
                        pair
                        .Value
                        .Any(string.IsNullOrWhiteSpace)
                ) {
                    throw InvalidOperationException(
                        path + ": the C# test oracle contains an invalid per-framework test list."
                    )
                }
                let frameworkTotal = oracle.TestsByFramework!!.Values.Sum((list List[string]) -> list.Count)
                if frameworkTotal != oracle.TestCount {
                    throw InvalidOperationException(
                        path + ": the C# test oracle per-framework count " + frameworkTotal.ToString() +
                            " disagrees with testCount " +
                            oracle
                            .TestCount
                            .ToString() + "."
                    )
                }
            }
            return oracle
        }

        internal func NormalizeTargetFramework(raw string?) string? {
            if string.IsNullOrWhiteSpace(raw) {
                return nil
            }
            let text = raw.Trim()
            if text.StartsWith(".NETCoreApp,Version=v", StringComparison.OrdinalIgnoreCase) {
                let version = text.Substring(".NETCoreApp,Version=v".Length).ToLowerInvariant()
                let dotIndex = version.IndexOf('.')
                let majorText = if dotIndex >= 0 {
                    version.Substring(0, dotIndex)
                } else {
                    version
                }
                let prefix = if int32.TryParse(majorText, out var major) && major >= 5 {
                    "net"
                } else {
                    "netcoreapp"
                }
                return prefix + version
            }
            if text.StartsWith(".NETStandard,Version=v", StringComparison.OrdinalIgnoreCase) {
                return "netstandard" + text.Substring(".NETStandard,Version=v".Length).ToLowerInvariant()
            }
            if text.StartsWith(".NETFramework,Version=v", StringComparison.OrdinalIgnoreCase) {
                return "net" +
                    text
                    .Substring(".NETFramework,Version=v".Length)
                    .Replace(".", string.Empty)
                    .ToLowerInvariant()
            }
            let lower = text.ToLowerInvariant()
            if lower.StartsWith("netstandard", StringComparison.Ordinal) {
                let versionPart = lower.Substring("netstandard".Length)
                return if IsMajorMinorDigits(versionPart) {
                    lower
                } else {
                    default(string?)
                }
            }
            if lower.StartsWith("netcoreapp", StringComparison.Ordinal) {
                let versionPart = lower.Substring("netcoreapp".Length)
                return if IsMajorMinorDigits(versionPart) {
                    lower
                } else {
                    default(string?)
                }
            }
            if lower.StartsWith("net", StringComparison.Ordinal) && lower.Length > 3 && char.IsDigit(lower[3]) {
                let remainder = lower.Substring(3)
                let dashIndex = remainder.IndexOf('-')
                let versionPart = if dashIndex >= 0 {
                    remainder.Substring(0, dashIndex)
                } else {
                    remainder
                }
                let platformSuffix = if dashIndex >= 0 {
                    remainder.Substring(dashIndex + 1)
                } else {
                    default(string?)
                }
                if platformSuffix != nil && !IsValidTargetPlatformSuffix(platformSuffix) {
                    return nil
                }
                if IsAsciiDigits(versionPart) {
                    let normalizedVersion = if int32.TryParse(versionPart, out var major) && major >= 5 && major < 40 {
                        "$major.0"
                    } else {
                        versionPart
                    }
                    return if platformSuffix != nil {
                        "net$normalizedVersion-$platformSuffix"
                    } else {
                        "net$normalizedVersion"
                    }
                }
                if IsMajorMinorDigits(versionPart) {
                    return lower
                }
            }
            return nil
        }

        private func IsAsciiDigits(value string) bool {
            if value.Length == 0 {
                return false
            }
            for ch in value {
                if ch < '0' || ch > '9' {
                    return false
                }
            }
            return true
        }

        private func IsMajorMinorDigits(value string) bool {
            let dotIndex = value.IndexOf('.')
            if dotIndex <= 0 || dotIndex == value.Length - 1 || value.IndexOf('.', dotIndex + 1) >= 0 {
                return false
            }
            return IsAsciiDigits(value.Substring(0, dotIndex)) && IsAsciiDigits(value.Substring(dotIndex + 1))
        }

        private func IsValidTargetPlatformSuffix(platform string) bool {
            if platform.Length == 0 || platform[0] < 'a' || platform[0] > 'z' {
                return false
            }
            var index = 0
            while index < platform.Length && platform[index] >= 'a' && platform[index] <= 'z' {
                index++
            }
            if index == platform.Length {
                return true
            }
            if platform[index] < '0' || platform[index] > '9' || platform[platform.Length - 1] == '.' {
                return false
            }
            var previousWasDot = false
            while index < platform.Length {
                let ch = platform[index]
                if ch == '.' {
                    if previousWasDot {
                        return false
                    }
                    previousWasDot = true
                } else if ch >= '0' && ch <= '9' {
                    previousWasDot = false
                } else {
                    return false
                }
                index++
            }
            return true
        }

        internal func InferTargetFrameworkFromPath(path string?) string? {
            if string.IsNullOrWhiteSpace(path) {
                return nil
            }
            for segment in path.Split('/', '\\') {
                if NormalizeTargetFramework(segment) is {} tfm {
                    return tfm
                }
            }
            let stem = Path.GetFileNameWithoutExtension(path)
            if NormalizeTargetFramework(stem) is {} stemTfm {
                return stemTfm
            }
            for token in stem.Split('_') {
                if NormalizeTargetFramework(token) is {} tfm {
                    return tfm
                }
            }
            for token in stem.Split('-') {
                if NormalizeTargetFramework(token) is {} tfm {
                    return tfm
                }
            }
            return nil
        }

        private func TryParseBannerFramework(line string) string? {
            if !line.StartsWith("Test run for ", StringComparison.Ordinal) {
                return nil
            }
            let openParen = line.LastIndexOf('(')
            let closeParen = line.LastIndexOf(')')
            let pathPart = if openParen > "Test run for ".Length {
                line.Substring("Test run for ".Length, openParen - "Test run for ".Length).Trim()
            } else {
                line.Substring("Test run for ".Length).Trim()
            }
            if InferTargetFrameworkFromPath(pathPart) is {} pathTfm {
                return pathTfm
            }
            if openParen > 0 && closeParen > openParen {
                let inside = line.Substring(openParen + 1, closeParen - openParen - 1)
                if NormalizeTargetFramework(inside) is {} tfm {
                    return tfm
                }
            }
            return nil
        }

        private func Tail(output string) string {
            let text = (output ?? string.Empty).Trim()
            return if text.Length <= 2000 {
                text
            } else {
                text.Substring(text.Length - 2000)
            }
        }
    }
}
