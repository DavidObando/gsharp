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
    public static IReadOnlyList<TestCaseOutcome> ParseFile(string path)
    {
        if (path is null)
        {
            throw new ArgumentNullException(nameof(path));
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"TRX result file not found: {path}", path);
        }

        return Parse(File.ReadAllText(path));
    }

    /// <summary>
    /// Parses TRX XML text into the per-test name/outcome set.
    /// </summary>
    /// <param name="trxXml">The TRX XML text.</param>
    /// <returns>The parsed test outcomes, sorted by name.</returns>
    /// <exception cref="InvalidOperationException">The TRX XML is malformed.</exception>
    public static IReadOnlyList<TestCaseOutcome> Parse(string trxXml)
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
            if (name is null || outcome is null)
            {
                continue;
            }

            results.Add(new TestCaseOutcome(name, outcome));
        }

        results.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
        return results;
    }
}
