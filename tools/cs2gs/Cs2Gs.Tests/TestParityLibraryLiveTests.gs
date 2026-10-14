// <copyright file="TestParityLibraryLiveTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import Xunit

/// A gated, live exercise of the stage-4 (ADR-0115 §C/§E) library xUnit parity
/// orchestration: it scaffolds a minimal translated G# library + G# xUnit test
/// project, builds it against the <b>locally-built</b> `Gsharp.NET.Sdk`
/// nupkg, runs real `dotnet test`, parses the produced TRX, and compares the
/// outcome set to an oracle — proving the (cref:GsharpTestProjectRunner)
/// path is real (not faked). Gated on the local SDK nupkg being present (returns
/// early otherwise), so it is a no-op on machines that have not built the SDK.
/// The minimal G# here mirrors what the translator emits for a trivial
/// calculator (`@Fact`/`@Theory`/`@InlineData`/`Assert.Equal`);
/// the full C#→G# xUnit-test translation belongs to the map-advanced step.
open class TestParityLibraryLiveTests {
    /// The live library path scaffolds, builds, and `dotnet test`s a minimal
    /// translated G# xUnit project against the local SDK, and its parsed TRX
    /// matches the oracle outcome set exactly (all `Passed`) — proving the
    /// orchestration end-to-end. Gated on the local SDK nupkg.
    @Fact
    func MinimalLibrary_BuildsRunsAndMatchesOracle() {
        let repoRoot string? = FindRepoRoot()
        if repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil {
            // No locally-built SDK nupkg: skip (the engine tests cover comparison).
            return
        }
        let project = GsharpTestProject{
            LibraryName: "CalcLib",
            LibraryRootNamespace: "CalcLib",
            LibraryFiles: List[GsharpSourceFile]{GsharpSourceFile("Calculator.gs", LibrarySource)},
            LibraryFriendAssemblies: []string{"CalcLib.Tests"},
            TestsName: "CalcLib.Tests",
            TestsRootNamespace: "CalcLib.Tests",
            TestFiles: List[GsharpSourceFile]{GsharpSourceFile("CalculatorTests.gs", TestSource)}
        }
        let workDir = Path.Combine(AppContext.BaseDirectory, "testparity-live", Guid.NewGuid().ToString("N"))
        let runner = GsharpTestProjectRunner(repoRoot)
        let run = runner.Run(project, workDir)
        Assert.True(
            run.Status == GsharpTestRunStatus.Ran,
            "Expected a live dotnet test run with a TRX. Status=" + run.Status.ToString() +
                "; output tail:\n" +
                run.Output
        )
        let library = Assembly.LoadFile(Path.Combine(workDir, "CalcLib", "bin", "Release", "net10.0", "CalcLib.dll"))
        Assert.Single(
            library.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute.AttributeType == typeof(InternalsVisibleToAttribute) &&
                cast[string](Assert.Single(attribute.ConstructorArguments).Value) == "CalcLib.Tests"
        )
        let oracle = []TestCaseOutcome{
            TestCaseOutcome("CalcLib.Tests.CalculatorTests.Add_Cases(a: 1, b: 2, expected: 3)", "Passed"),
            TestCaseOutcome("CalcLib.Tests.CalculatorTests.Add_Cases(a: 2, b: 2, expected: 4)", "Passed"),
            TestCaseOutcome("CalcLib.Tests.CalculatorTests.Add_Returns_Sum", "Passed"),
            TestCaseOutcome("CalcLib.Tests.CalculatorTests.FriendAssembly_Can_Call_Internal_Method", "Passed"),
            TestCaseOutcome("CalcLib.Tests.CalculatorTests.Subtract_Returns_Difference", "Passed")
        }
        let result = TestParityComparison.Compare(oracle, run.Results)
        Assert.True(
            result.IsMatch,
            "Live G# run did not match the oracle. Diffs: " + string.Join(
                "; ",
                Enumerable.Select(result.Differences, (d TestParityDiff) -> d.Describe())
            )
        )
    }

    shared {
        private const LibrarySource string = "package CalcLib\n" +
            "\n" +
            "class Calculator {\n" +
            "    func Add(a int, b int) int {\n" +
            "        return a + b\n" +
            "    }\n" +
            "\n" +
            "    func Subtract(a int, b int) int {\n" +
            "        return a - b\n" +
            "    }\n" +
            "\n" +
            "    shared {\n" +
            "        internal func AddInternal(a int, b int) int {\n" +
            "            return a + b\n" +
            "        }\n" +
            "    }\n" +
            "}\n"
        private const TestSource string = "package CalcLib.Tests\n" +
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
            "    @Fact\n" +
            "    func FriendAssembly_Can_Call_Internal_Method() {\n" +
            "        Assert.Equal(5, Calculator.AddInternal(2, 3))\n" +
            "    }\n" +
            "\n" +
            "    @Theory\n" +
            "    @InlineData(1, 2, 3)\n" +
            "    @InlineData(2, 2, 4)\n" +
            "    func Add_Cases(a int, b int, expected int) {\n" +
            "        var calc = Calculator()\n" +
            "        Assert.Equal(expected, calc.Add(a, b))\n" +
            "    }\n" +
            "}\n"

        private func FindRepoRoot() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                if File.Exists(Path.Combine(dir.FullName, "nuget.config")) && RepositoryRootMarker.IsRoot(
                    dir.FullName
                ) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
