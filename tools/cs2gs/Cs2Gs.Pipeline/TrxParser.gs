// <copyright file="TrxParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq
import System.Xml

/// Parses a VSTest `.trx` result file into the same minimal
/// `{name, outcome}` shape the C# parity oracle records (ADR-0115 §E), so
/// the G# `dotnet test` run can be compared apples-to-apples against
/// `baseline.tests.json`. The parse mirrors `corpus/trx-to-baseline.py`:
/// only `UnitTestResult` elements contribute (the `ResultSummary`
/// banner is ignored), each contributes its `testName` and `outcome`
/// attributes, and the set is sorted by name. Element matching is
/// namespace-agnostic (by local name) so it is robust to TRX schema-namespace
/// drift.
shared class TrxParser {
    /// Parses a TRX file from disk.
    /// @param path The absolute path to the `.trx` file.
    /// @returns The parsed test outcomes, sorted by name.
    /// @exception FileNotFoundException The TRX file does not exist.
    /// @exception InvalidOperationException The TRX file is malformed.
    func ParseFile(path string) IReadOnlyList[TestCaseOutcome] -> ParseFile(path, requireNames: false)

    /// Parses a TRX file from disk; with [`requireNames`](paramref), a
    /// result without a test name or outcome is an error rather than skipped
    /// (issue #4633: per-name parity must not compare a silently shrunk set).
    /// @param path The absolute path to the `.trx` file.
    /// @param requireNames Whether a nameless result is an error.
    /// @returns The parsed test outcomes, sorted by name.
    func ParseFile(path string?, requireNames bool) IReadOnlyList[TestCaseOutcome] {
        if path == nil {
            throw ArgumentNullException("path")
        }
        if !File.Exists(path) {
            throw FileNotFoundException("TRX result file not found: $path", path)
        }
        return Parse(File.ReadAllText(path), requireNames)
    }

    /// Parses TRX XML text into the per-test name/outcome set.
    /// @param trxXml The TRX XML text.
    /// @returns The parsed test outcomes, sorted by name.
    /// @exception InvalidOperationException The TRX XML is malformed.
    func Parse(trxXml string) IReadOnlyList[TestCaseOutcome] -> Parse(trxXml, requireNames: false)

    /// Parses TRX XML text; see (cref:ParseFile(string, bool)).
    /// @param trxXml The TRX XML text.
    /// @param requireNames Whether a nameless result is an error.
    /// @returns The parsed test outcomes, sorted by name.
    func Parse(trxXml string, requireNames bool) IReadOnlyList[TestCaseOutcome] {
        if string.IsNullOrEmpty(trxXml) {
            return Array.Empty[TestCaseOutcome]()
        }
        var document XDocument
        try {
            document = XDocument.Parse(trxXml)
        } catch (ex XmlException) {
            throw InvalidOperationException("Malformed TRX XML: " + ex.Message, ex)
        }
        let results = List[TestCaseOutcome]()
        for element in document.Descendants().Where(
            (e XElement) -> string.Equals(e.Name.LocalName, "UnitTestResult", StringComparison.Ordinal)
        ) {
            let name string? = string(element.Attribute(XName?("testName")!!))
            let outcome string? = string(element.Attribute(XName?("outcome")!!))
            if string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(outcome) {
                if requireNames {
                    throw InvalidOperationException("TRX holds a UnitTestResult without a testName or outcome.")
                }
                continue
            }
            results.Add(TestCaseOutcome(name, outcome))
        }
        results.Sort((a TestCaseOutcome, b TestCaseOutcome) -> string.CompareOrdinal(a.Name, b.Name))
        return results
    }
}
