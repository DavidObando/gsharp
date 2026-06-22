// <copyright file="TestParityLibraryLiveTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// A gated, live exercise of the stage-4 (ADR-0115 §C/§E) library xUnit parity
/// orchestration: it scaffolds a minimal translated G# library + G# xUnit test
/// project, builds it against the <b>locally-built</b> <c>Gsharp.NET.Sdk</c>
/// nupkg, runs real <c>dotnet test</c>, parses the produced TRX, and compares the
/// outcome set to an oracle — proving the <see cref="GsharpTestProjectRunner"/>
/// path is real (not faked). Gated on the local SDK nupkg being present (returns
/// early otherwise), so it is a no-op on machines that have not built the SDK.
/// The minimal G# here mirrors what the translator emits for a trivial
/// calculator (<c>@Fact</c>/<c>@Theory</c>/<c>@InlineData</c>/<c>Assert.Equal</c>);
/// the full C#→G# xUnit-test translation belongs to the map-advanced step.
/// </summary>
public class TestParityLibraryLiveTests
{
    private const string LibrarySource =
        "package CalcLib\n" +
        "\n" +
        "class Calculator {\n" +
        "    func Add(a int, b int) int {\n" +
        "        return a + b\n" +
        "    }\n" +
        "\n" +
        "    func Subtract(a int, b int) int {\n" +
        "        return a - b\n" +
        "    }\n" +
        "}\n";

    private const string TestSource =
        "package CalcLib.Tests\n" +
        "\n" +
        "import Xunit\n" +
        "import CalcLib\n" +
        "\n" +
        "class CalculatorTests {\n" +
        "    @Fact\n" +
        "    func Add_Returns_Sum() {\n" +
        "        var calc = Calculator()\n" +
        "        Assert.Equal(5, calc.Add(2, 3))\n" +
        "    }\n" +
        "\n" +
        "    @Fact\n" +
        "    func Subtract_Returns_Difference() {\n" +
        "        var calc = Calculator()\n" +
        "        Assert.Equal(1, calc.Subtract(3, 2))\n" +
        "    }\n" +
        "\n" +
        "    @Theory\n" +
        "    @InlineData(1, 2, 3)\n" +
        "    @InlineData(2, 2, 4)\n" +
        "    func Add_Cases(a int, b int, expected int) {\n" +
        "        var calc = Calculator()\n" +
        "        Assert.Equal(expected, calc.Add(a, b))\n" +
        "    }\n" +
        "}\n";

    /// <summary>
    /// The live library path scaffolds, builds, and <c>dotnet test</c>s a minimal
    /// translated G# xUnit project against the local SDK, and its parsed TRX
    /// matches the oracle outcome set exactly (all <c>Passed</c>) — proving the
    /// orchestration end-to-end. Gated on the local SDK nupkg.
    /// </summary>
    [Fact]
    public void MinimalLibrary_BuildsRunsAndMatchesOracle()
    {
        string repoRoot = FindRepoRoot();
        if (repoRoot is null || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            // No locally-built SDK nupkg: skip (the engine tests cover comparison).
            return;
        }

        var project = new GsharpTestProject
        {
            LibraryName = "CalcLib",
            LibraryRootNamespace = "CalcLib",
            LibraryFiles = new List<GsharpSourceFile>
            {
                new GsharpSourceFile("Calculator.gs", LibrarySource),
            },
            TestsName = "CalcLib.Tests",
            TestsRootNamespace = "CalcLib.Tests",
            TestFiles = new List<GsharpSourceFile>
            {
                new GsharpSourceFile("CalculatorTests.gs", TestSource),
            },
        };

        string workDir = Path.Combine(
            AppContext.BaseDirectory, "testparity-live", Guid.NewGuid().ToString("N"));
        var runner = new GsharpTestProjectRunner(repoRoot);
        GsharpTestRunResult run = runner.Run(project, workDir);

        Assert.True(
            run.Status == GsharpTestRunStatus.Ran,
            "Expected a live dotnet test run with a TRX. Status=" + run.Status +
                "; output tail:\n" + run.Output);

        var oracle = new[]
        {
            new TestCaseOutcome("CalcLib.Tests.CalculatorTests.Add_Cases(a: 1, b: 2, expected: 3)", "Passed"),
            new TestCaseOutcome("CalcLib.Tests.CalculatorTests.Add_Cases(a: 2, b: 2, expected: 4)", "Passed"),
            new TestCaseOutcome("CalcLib.Tests.CalculatorTests.Add_Returns_Sum", "Passed"),
            new TestCaseOutcome("CalcLib.Tests.CalculatorTests.Subtract_Returns_Difference", "Passed"),
        };

        TestParityResult result = TestParityComparison.Compare(oracle, run.Results);
        Assert.True(
            result.IsMatch,
            "Live G# run did not match the oracle. Diffs: " +
                string.Join("; ", System.Linq.Enumerable.Select(result.Differences, d => d.Describe())));
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "nuget.config")) &&
                File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
