// <copyright file="BaselineTestsOracle.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The C# xUnit parity oracle for stage 4 (ADR-0115 §E): the deterministic
/// per-test pass/fail set captured from the original C# corpus app and committed
/// next to it as <c>baseline.tests.json</c>. The G# port must reproduce the same
/// <c>{name → outcome}</c> set. This is the loader for that fixture; its shape
/// matches the capture pipeline's output (<c>corpus/trx-to-baseline.py</c>)
/// exactly so the comparison is apples-to-apples.
/// </summary>
public sealed class BaselineTestsOracle
{
    /// <summary>Gets or sets the schema version (always <c>"1.0"</c>).</summary>
    [JsonPropertyName("schemaVersion")]
    [JsonPropertyOrder(0)]
    public string SchemaVersion { get; set; } = "1.0";

    /// <summary>Gets or sets the app id the baseline was captured for.</summary>
    [JsonPropertyName("app")]
    [JsonPropertyOrder(1)]
    public string App { get; set; }

    /// <summary>Gets or sets the test framework (always <c>"xunit"</c> today).</summary>
    [JsonPropertyName("framework")]
    [JsonPropertyOrder(2)]
    public string Framework { get; set; }

    /// <summary>Gets or sets the total number of tests.</summary>
    [JsonPropertyName("total")]
    [JsonPropertyOrder(3)]
    public int Total { get; set; }

    /// <summary>Gets or sets the number of passing tests.</summary>
    [JsonPropertyName("passed")]
    [JsonPropertyOrder(4)]
    public int Passed { get; set; }

    /// <summary>Gets or sets the number of failing tests.</summary>
    [JsonPropertyName("failed")]
    [JsonPropertyOrder(5)]
    public int Failed { get; set; }

    /// <summary>Gets or sets the number of skipped tests.</summary>
    [JsonPropertyName("skipped")]
    [JsonPropertyOrder(6)]
    public int Skipped { get; set; }

    /// <summary>Gets or sets the per-test name/outcome records.</summary>
    [JsonPropertyName("tests")]
    [JsonPropertyOrder(7)]
    public List<TestCaseOutcome> Tests { get; set; } = new List<TestCaseOutcome>();

    /// <summary>
    /// Loads and parses a <c>baseline.tests.json</c> oracle from disk.
    /// </summary>
    /// <param name="path">The absolute path to the baseline JSON file.</param>
    /// <returns>The parsed oracle.</returns>
    /// <exception cref="FileNotFoundException">The baseline file does not exist.</exception>
    /// <exception cref="InvalidOperationException">The baseline JSON is malformed.</exception>
    public static BaselineTestsOracle Load(string path)
    {
        if (path is null)
        {
            throw new ArgumentNullException(nameof(path));
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"Baseline tests oracle not found: {path}", path);
        }

        return Parse(File.ReadAllText(path));
    }

    /// <summary>
    /// Parses a <c>baseline.tests.json</c> oracle from its JSON text.
    /// </summary>
    /// <param name="json">The baseline JSON text.</param>
    /// <returns>The parsed oracle.</returns>
    /// <exception cref="InvalidOperationException">The baseline JSON is malformed.</exception>
    public static BaselineTestsOracle Parse(string json)
    {
        if (json is null)
        {
            throw new ArgumentNullException(nameof(json));
        }

        try
        {
            BaselineTestsOracle oracle = JsonSerializer.Deserialize<BaselineTestsOracle>(
                json, TriageSerialization.Options);
            if (oracle is null)
            {
                throw new InvalidOperationException("Baseline tests oracle deserialized to null.");
            }

            oracle.Tests ??= new List<TestCaseOutcome>();
            return oracle;
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException("Malformed baseline tests oracle JSON: " + ex.Message, ex);
        }
    }
}

/// <summary>
/// One test's name and outcome (ADR-0115 §E). The <c>name</c> is the fully
/// qualified test name including any xUnit theory case suffix (e.g.
/// <c>Ns.Class.Method(arg: 1, expected: 2)</c>); the <c>outcome</c> is the
/// VSTest spelling (<c>Passed</c>/<c>Failed</c>/<c>NotExecuted</c>).
/// </summary>
public sealed class TestCaseOutcome
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TestCaseOutcome"/> class.
    /// </summary>
    public TestCaseOutcome()
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="TestCaseOutcome"/> class.
    /// </summary>
    /// <param name="name">The fully qualified test name.</param>
    /// <param name="outcome">The VSTest outcome string.</param>
    public TestCaseOutcome(string name, string outcome)
    {
        this.Name = name;
        this.Outcome = outcome;
    }

    /// <summary>Gets or sets the fully qualified test name.</summary>
    [JsonPropertyName("name")]
    [JsonPropertyOrder(0)]
    public string Name { get; set; }

    /// <summary>Gets or sets the VSTest outcome string.</summary>
    [JsonPropertyName("outcome")]
    [JsonPropertyOrder(1)]
    public string Outcome { get; set; }
}
