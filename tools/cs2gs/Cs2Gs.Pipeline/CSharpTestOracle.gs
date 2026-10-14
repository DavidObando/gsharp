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
        func ParseListTestsOutput(output string) IReadOnlyList[string] {
            let lines = (output ?? string.Empty).Replace("\r\n", "\n").Split('\n')
            let names = List[string]()
            var sawHeader = false
            var inBlock = false
            // Every listing block counts: a multi-targeted project prints one
            // header and one indented block per target framework.
            for line in lines {
                if string.Equals(line.Trim(), ListHeader, StringComparison.Ordinal) {
                    sawHeader = true
                    inBlock = true
                    continue
                }
                if !inBlock || line.Length == 0 {
                    continue
                }
                // Names are the indented lines (VSTest uses four spaces; any
                // leading whitespace is accepted); an unindented line ends the block.
                if !char.IsWhiteSpace(line[0]) {
                    inBlock = false
                    continue
                }
                let name = line.Trim()
                if name.Length > 0 {
                    names.Add(name)
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
            return names
        }

        /// Builds an oracle from discovered names, sorted ordinally.
        /// @param appId The corpus app id.
        /// @param names The discovered display names.
        /// @returns The oracle.
        func Create(appId string, names IEnumerable[string]) CSharpTestOracle {
            let sorted = (names ?? Array.Empty[string]()).ToList()
            sorted.Sort(StringComparer.Ordinal)
            return CSharpTestOracle{AppId: appId, TestCount: sorted.Count, Tests: sorted}
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
            return oracle
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
