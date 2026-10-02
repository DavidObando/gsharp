// <copyright file="TrxParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Parses a VSTest <c>.trx</c> result file into the same minimal
/// <c>{name, outcome}</c> shape the C# parity oracle records (ADR-0115 §E), so
/// the G# <c>dotnet test</c> run can be compared apples-to-apples against
/// <c>baseline.tests.json</c>. The parse mirrors <c>corpus/trx-to-baseline.py</c>:
/// only <c>UnitTestResult</c> elements contribute (the <c>ResultSummary</c>
/// banner is ignored), each contributes its <c>testName</c> and <c>outcome</c>
/// attributes, and the set is sorted by name. Element matching is
/// namespace-agnostic (by local name) so it is robust to TRX schema-namespace
/// drift.
/// </summary>
public static class TrxParser
{
    /// <summary>
    /// Parses a TRX file from disk.
    /// </summary>
    /// <param name="path">The absolute path to the <c>.trx</c> file.</param>
    /// <returns>The parsed test outcomes, sorted by name.</returns>
    /// <exception cref="FileNotFoundException">The TRX file does not exist.</exception>
    /// <exception cref="InvalidOperationException">The TRX file is malformed.</exception>
    public static IReadOnlyList<TestCaseOutcome> ParseFile(string path) => ParseFile(path, requireNames: false);

    /// <summary>
    /// Parses a TRX file from disk; with <paramref name="requireNames"/>, a
    /// result without a test name or outcome is an error rather than skipped
    /// (issue #4633: per-name parity must not compare a silently shrunk set).
    /// </summary>
    /// <param name="path">The absolute path to the <c>.trx</c> file.</param>
    /// <param name="requireNames">Whether a nameless result is an error.</param>
    /// <returns>The parsed test outcomes, sorted by name.</returns>
    public static IReadOnlyList<TestCaseOutcome> ParseFile(string path, bool requireNames)
    {
        if (path is null)
        {
            throw new ArgumentNullException(nameof(path));
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"TRX result file not found: {path}", path);
        }

        return Parse(File.ReadAllText(path), requireNames);
    }

    /// <summary>
    /// Parses TRX XML text into the per-test name/outcome set.
    /// </summary>
    /// <param name="trxXml">The TRX XML text.</param>
    /// <returns>The parsed test outcomes, sorted by name.</returns>
    /// <exception cref="InvalidOperationException">The TRX XML is malformed.</exception>
    public static IReadOnlyList<TestCaseOutcome> Parse(string trxXml) => Parse(trxXml, requireNames: false);

    /// <summary>Parses TRX XML text; see <see cref="ParseFile(string, bool)"/>.</summary>
    /// <param name="trxXml">The TRX XML text.</param>
    /// <param name="requireNames">Whether a nameless result is an error.</param>
    /// <returns>The parsed test outcomes, sorted by name.</returns>
    public static IReadOnlyList<TestCaseOutcome> Parse(string trxXml, bool requireNames)
    {
        if (string.IsNullOrEmpty(trxXml))
        {
            return Array.Empty<TestCaseOutcome>();
        }

        XDocument document;
        try
        {
            document = XDocument.Parse(trxXml);
        }
        catch (System.Xml.XmlException ex)
        {
            throw new InvalidOperationException("Malformed TRX XML: " + ex.Message, ex);
        }

        var results = new List<TestCaseOutcome>();
        foreach (XElement element in document.Descendants()
            .Where(e => string.Equals(e.Name.LocalName, "UnitTestResult", StringComparison.Ordinal)))
        {
            string name = (string)element.Attribute("testName");
            string outcome = (string)element.Attribute("outcome");
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(outcome))
            {
                if (requireNames)
                {
                    throw new InvalidOperationException("TRX holds a UnitTestResult without a testName or outcome.");
                }

                continue;
            }

            results.Add(new TestCaseOutcome(name, outcome));
        }

        results.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
        return results;
    }
}
