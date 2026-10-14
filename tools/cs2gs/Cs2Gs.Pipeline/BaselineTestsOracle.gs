// <copyright file="BaselineTestsOracle.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.Json.Serialization

/// The C# xUnit parity oracle for stage 4 (ADR-0115 §E): the deterministic
/// per-test pass/fail set captured from the original C# corpus app and committed
/// next to it as `baseline.tests.json`. The G# port must reproduce the same
/// `{name → outcome}` set. This is the loader for that fixture; its shape
/// matches the capture pipeline's output (`corpus/trx-to-baseline.py`)
/// exactly so the comparison is apples-to-apples.
class BaselineTestsOracle {
    /// Gets or sets the schema version (always `"1.0"`).
    private var _schemaVersion string = "1.0"

    @JsonPropertyName("schemaVersion")
    @JsonPropertyOrder(int32(0))
    prop SchemaVersion string {
        get {
            return _schemaVersion
        }
        set {
            _schemaVersion = value
        }
    }

    /// Gets or sets the app id the baseline was captured for.
    @JsonPropertyName("app")
    @JsonPropertyOrder(int32(1))
    prop App string

    /// Gets or sets the test framework (always `"xunit"` today).
    @JsonPropertyName("framework")
    @JsonPropertyOrder(int32(2))
    prop Framework string

    /// Gets or sets the total number of tests.
    @JsonPropertyName("total")
    @JsonPropertyOrder(int32(3))
    prop Total int32

    /// Gets or sets the number of passing tests.
    @JsonPropertyName("passed")
    @JsonPropertyOrder(int32(4))
    prop Passed int32

    /// Gets or sets the number of failing tests.
    @JsonPropertyName("failed")
    @JsonPropertyOrder(int32(5))
    prop Failed int32

    /// Gets or sets the number of skipped tests.
    @JsonPropertyName("skipped")
    @JsonPropertyOrder(int32(6))
    prop Skipped int32

    /// Gets or sets the per-test name/outcome records.
    private var _tests List[TestCaseOutcome]? = List[TestCaseOutcome]()

    @JsonPropertyName("tests")
    @JsonPropertyOrder(int32(7))
    prop Tests List[TestCaseOutcome]? {
        get {
            return _tests
        }
        set {
            _tests = value
        }
    }

    shared {
        /// Loads and parses a `baseline.tests.json` oracle from disk.
        /// @param path The absolute path to the baseline JSON file.
        /// @returns The parsed oracle.
        /// @exception FileNotFoundException The baseline file does not exist.
        /// @exception InvalidOperationException The baseline JSON is malformed.
        func Load(path string?) BaselineTestsOracle? {
            if path == nil {
                throw ArgumentNullException("path")
            }
            if !File.Exists(path) {
                throw FileNotFoundException("Baseline tests oracle not found: $path", path)
            }
            return Parse(File.ReadAllText(path))
        }

        /// Parses a `baseline.tests.json` oracle from its JSON text.
        /// @param json The baseline JSON text.
        /// @returns The parsed oracle.
        /// @exception InvalidOperationException The baseline JSON is malformed.
        func Parse(json string?) BaselineTestsOracle? {
            if json == nil {
                throw ArgumentNullException("json")
            }
            try {
                let oracle BaselineTestsOracle? = JsonSerializer.Deserialize[BaselineTestsOracle](
                    json,
                    TriageSerialization.Options
                )
                if oracle == nil {
                    throw InvalidOperationException("Baseline tests oracle deserialized to null.")
                }
                oracle.Tests ??= List[TestCaseOutcome]()
                return oracle
            } catch (ex JsonException) {
                throw InvalidOperationException("Malformed baseline tests oracle JSON: " + ex.Message, ex)
            }
        }
    }
}

/// One test's name and outcome (ADR-0115 §E). The `name` is the fully
/// qualified test name including any xUnit theory case suffix (e.g.
/// `Ns.Class.Method(arg: 1, expected: 2)`); the `outcome` is the
/// VSTest spelling (`Passed`/`Failed`/`NotExecuted`).
class TestCaseOutcome {
    /// Initializes a new instance of the (cref:TestCaseOutcome) class.
    init() { }

    /// Initializes a new instance of the (cref:TestCaseOutcome) class.
    /// @param name The fully qualified test name.
    /// @param outcome The VSTest outcome string.
    init(name string?, outcome string?) {
        this.Name = name
        this.Outcome = outcome
    }

    /// Gets or sets the fully qualified test name.
    @JsonPropertyName("name")
    @JsonPropertyOrder(int32(0))
    prop Name string?

    /// Gets or sets the VSTest outcome string.
    @JsonPropertyName("outcome")
    @JsonPropertyOrder(int32(1))
    prop Outcome string?
}
