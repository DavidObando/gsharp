// <copyright file="RandomizedDriverConformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.LanguageConformance;

public class RandomizedDriverConformanceTests
{
    internal const int CaseCount = 32;

    public static IEnumerable<object[]> Seeds()
        => Enumerable.Range(0, CaseCount).Select(seed => new object[] { seed });

    [Theory]
    [MemberData(nameof(Seeds))]
    public async Task GeneratedProgram_ConformsAcrossAllDrivers(int seed)
    {
        string source = GenerateProgram(seed);
        string testDirectory = Path.GetDirectoryName(typeof(RandomizedDriverConformanceTests).Assembly.Location);
        Assert.NotNull(testDirectory);
        string sourceDirectory = Path.Combine(
            testDirectory,
            "randomized-driver-conformance",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sourceDirectory);
        string sourcePath = Path.Combine(sourceDirectory, $"Seed{seed:D2}.gs");
        File.WriteAllText(sourcePath, source);

        try
        {
            Exception exception = await Record.ExceptionAsync(
                () => DriverConformanceHarness.AssertSingleFileConformsAsync(
                    $"RandomizedSeed{seed:D2}",
                    sourcePath));
            Assert.True(
                exception is null,
                $"Randomized conformance seed {seed} failed.\n\n{source}\n\n{exception}");
        }
        finally
        {
            Directory.Delete(sourceDirectory, recursive: true);
        }
    }

    [Fact]
    public void GeneratedPrograms_AreDeterministicAndDiverse()
    {
        string[] programs = Enumerable.Range(0, CaseCount).Select(GenerateProgram).ToArray();

        Assert.Equal(programs, Enumerable.Range(0, CaseCount).Select(GenerateProgram));
        Assert.Equal(CaseCount, programs.Distinct(StringComparer.Ordinal).Count());
        Assert.All(programs, program =>
        {
            Assert.Contains("if ", program, StringComparison.Ordinal);
            Assert.Contains("while ", program, StringComparison.Ordinal);
        });
    }

    private static string GenerateProgram(int seed)
    {
        var random = new Random(seed);
        string initial = GenerateExpression(random, depth: 3, "a", "b", "c");
        string whenTrue = GenerateExpression(random, depth: 2, "value", "a", "b", "c");
        string whenFalse = GenerateExpression(random, depth: 2, "value", "a", "b", "c");
        string condition = GenerateCondition(random, "a", "b", "c");
        int steps = random.Next(1, 7);
        int mask = random.Next(1, 64);

        return $@"package RandomizedConformance.Seed{seed:D2}
import System

var a = {random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)}
var b = {random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)}
var c = {random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)}
var value = {initial}
if {condition} {{
    value = {whenTrue}
}} else {{
    value = {whenFalse}
}}
var index = 0
while index < {steps.ToString(CultureInfo.InvariantCulture)} {{
    value = (value + index) ^ {mask.ToString(CultureInfo.InvariantCulture)}
    index++
}}
Console.WriteLine({seed.ToString(CultureInfo.InvariantCulture)})
Console.WriteLine(value)
Console.WriteLine((value & 1) == 0)
";
    }

    private static string GenerateExpression(Random random, int depth, params string[] variables)
    {
        if (depth == 0 || random.Next(4) == 0)
        {
            return random.Next(3) == 0
                ? random.Next(-20, 21).ToString(CultureInfo.InvariantCulture)
                : variables[random.Next(variables.Length)];
        }

        string left = GenerateExpression(random, depth - 1, variables);
        if (random.Next(5) == 0)
        {
            return $"({left} % {random.Next(1, 17).ToString(CultureInfo.InvariantCulture)})";
        }

        string right = GenerateExpression(random, depth - 1, variables);
        string operation = new[] { "+", "-", "*", "^", "&", "|" }[random.Next(6)];
        return $"({left} {operation} {right})";
    }

    private static string GenerateCondition(Random random, params string[] variables)
    {
        string left = GenerateExpression(random, depth: 1, variables);
        string right = GenerateExpression(random, depth: 1, variables);
        string otherLeft = GenerateExpression(random, depth: 1, variables);
        string otherRight = GenerateExpression(random, depth: 1, variables);
        string comparison = new[] { "<", "<=", "==", "!=", ">=", ">" }[random.Next(6)];
        string otherComparison = new[] { "<", "<=", "==", "!=", ">=", ">" }[random.Next(6)];
        string junction = random.Next(2) == 0 ? "&&" : "||";
        return $"(({left} {comparison} {right}) {junction} ({otherLeft} {otherComparison} {otherRight}))";
    }
}
