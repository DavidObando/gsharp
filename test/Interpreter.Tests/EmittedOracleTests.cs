// <copyright file="EmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Execution;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Witness coverage for emitted-oracle value capture, diagnostics, console output, exceptions, and lifetime handling.
/// </summary>
[Collection("ConsoleIo")]
public class EmittedOracleTests
{
    [Fact]
    public void TrailingExpression_PrimitiveValue()
    {
        var result = EmittedOracle.Evaluate("1 + 2");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
        Assert.Equal(0, result.ExitCode);
        Assert.Null(result.UnhandledException);
    }

    [Fact]
    public void TrailingExpression_FlowsThroughVariablesAndFunctions()
    {
        var result = EmittedOracle.Evaluate("""
            func Double(n int32) int32 -> n * 2
            var seed = 21
            Double(seed)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TrailingExpression_StringAndBoolUnifyWithTestTypes()
    {
        Assert.Equal("ab", EmittedOracle.Evaluate("""
            let a = "a"
            a + "b"
            """).Value);
        Assert.Equal(true, EmittedOracle.Evaluate("2 > 1").Value);
    }

    [Fact]
    public void TrailingDeclaration_ValueIsCaptured()
    {
        var result = EmittedOracle.Evaluate("var answer = 40 + 2");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConsoleOutput_IsCaptured()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            Console.WriteLine("first-11")
            Console.WriteLine("second-22")
            "done"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("done", result.Value);
        Assert.Equal("first-11" + Environment.NewLine + "second-22" + Environment.NewLine, result.Output);
        Assert.Equal(string.Empty, result.ErrorOutput);
    }

    [Fact]
    public void CompileError_ShortCircuitsWithoutExecuting()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            Console.WriteLine("must-not-run")
            undefinedIdentifier
            """);

        Assert.Contains(result.Diagnostics, d => d.IsError);
        Assert.Null(result.Value);
        Assert.Equal(string.Empty, result.Output);
        Assert.Equal(1, result.ExitCode);
        Assert.Null(result.UnhandledException);
    }

    [Fact]
    public void RuntimeException_SurfacesAsGs9999DiagnosticAndException()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            Console.WriteLine("before-33")
            throw InvalidOperationException("boom-42")
            """);

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS9999", diagnostic.Id);
        Assert.Equal("boom-42", diagnostic.Message);
        Assert.IsType<InvalidOperationException>(result.UnhandledException);
        Assert.Equal("boom-42", result.UnhandledException.Message);
        Assert.Null(result.Value);
        Assert.Equal(EmittedProgramHost.UnhandledExceptionExitCode, result.ExitCode);
        Assert.Equal("before-33" + Environment.NewLine, result.Output);
    }

    [Fact]
    public void CaughtException_DoesNotSurface()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            var caught = false
            try {
                var n = Int32.Parse("not a number")
            } catch (e FormatException) {
                caught = true
            }
            caught
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SubmissionDeclaredType_ValueTextRendersAcrossTheAlcBoundary()
    {
        var result = EmittedOracle.Evaluate("""
            struct Point {
                var X int32
                var Y int32
                override func ToString() string -> "P(3,4)-55"
            }
            Point{X: 3, Y: 4}
            """);

        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Value);

        // The value's type lives in the run's own collectible ALC: reflection
        // and rendering work; `is`-checks against test-side types cannot.
        Assert.Equal("P(3,4)-55", result.ValueText);
        Assert.Equal("Point", result.Value.GetType().Name);
    }

    [Fact]
    public void ExplicitEntryPoint_ReturnValueIsTheValueAndExitCode()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            func Main() int32 {
                Console.WriteLine("main-ran-66")
                return 7
            }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
        Assert.Equal(7, result.ExitCode);
        Assert.Equal("main-ran-66" + Environment.NewLine, result.Output);
    }

    // Pinned divergence (ADR-0156 / #3186): under emitted execution `deinit`
    // is a real CLR finalizer, so the GS0510 evaluator-boundary warning that
    // Compilation.Evaluate reported never appears. Mirrors
    // EmittedSessionEngineTests.InteractiveDeinitializerRunsWithoutBoundaryWarning.
    [Fact]
    public void Deinit_CompilesAndRunsWithoutGs0510()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            class Holder {
                deinit {
                }
            }
            var h = Holder()
            GC.KeepAlive(h)
            "alive-77"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0510");
        Assert.Equal("alive-77", result.Value);
    }

    // Pinned divergence (#3116): overridden struct Equals/GetHashCode
    // dispatch for real under emitted execution, including through boxing —
    // the tree-walking evaluator historically bypassed the overrides when the
    // BCL invoked them.
    [Fact]
    public void StructObjectOverrides_DispatchThroughBoxing()
    {
        var result = EmittedOracle.Evaluate("""
            struct Value {
                var Number int32
                override func ToString() string -> "OVERRIDDEN-88"
                override func Equals(value object) bool -> false
                override func GetHashCode() int32 -> 289611
            }
            let direct = Value{Number: 7}
            let peer object = Value{Number: 7}
            let boxed object = direct
            boxed.Equals(peer)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void ReadGlobal_ReadsTopLevelVariablesPostRun()
    {
        // The emitted stand-in for reading the evaluator's variables
        // dictionary after Compilation.Evaluate: top-level globals are
        // static fields on the submission's <Program> container.
        var result = EmittedOracle.Evaluate("""
            var counter = 40
            counter += 2
            let label = "tag-44"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobal("counter"));
        Assert.Equal("tag-44", result.ReadGlobal("label"));
        Assert.Null(result.ReadGlobal("missing"));
    }

    [Fact]
    public void Value_RemainsUsableAfterUnloadInitiated()
    {
        var result = EmittedOracle.Evaluate("""
            class Named {
                var Tag string
                override func ToString() string -> Tag
            }
            Named{Tag: "still-here-99"}
            """);

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        // Unload was initiated inside the oracle, but the held Value keeps
        // the collectible context alive — assertions stay safe.
        Assert.Equal("still-here-99", result.ValueText);
        Assert.Equal("still-here-99", result.Value.ToString());
    }

    [Fact]
    public void LoadContext_IsReclaimedOnceTheResultIsDropped()
    {
        var weakContext = RunAndDiscard();

        for (var i = 0; i < 10 && weakContext.IsAlive; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }

        Assert.False(weakContext.IsAlive);
    }

    [Fact]
    public async Task ConcurrentEvaluations_DoNotInterleaveCapturedOutput()
    {
        var tasks = new Task<EmittedOracleResult>[4];
        for (var i = 0; i < tasks.Length; i++)
        {
            var marker = "marker-" + i;
            tasks[i] = Task.Run(() => EmittedOracle.Evaluate($"""
                import System
                Console.WriteLine("{marker}")
                Console.WriteLine("{marker}")
                "{marker}"
                """));
        }

        var results = await Task.WhenAll(tasks);
        for (var i = 0; i < results.Length; i++)
        {
            var marker = "marker-" + i;
            Assert.Empty(results[i].Diagnostics);
            Assert.Equal(marker, results[i].Value);
            Assert.Equal(marker + Environment.NewLine + marker + Environment.NewLine, results[i].Output);
        }
    }

    // ─── Phase 3b.2 capability additions (issue #3176) ───────────────────

    [Fact]
    public void MultiSource_CompilesAllTreesAndRunsTrailingExpression()
    {
        // The multi-tree Compilation.Evaluate shape: declarations in one
        // tree, consuming top-level statements in another, distinct packages.
        var result = EmittedOracle.Evaluate(new[]
        {
            """
            package Geometry
            public struct Point {
                var X int32
                var Y int32
            }
            """,
            """
            package GeometryUse
            var p = Point{X: 40, Y: 2}
            p.X + p.Y
            """,
        });

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void MultiSource_DiagnosticsSurfaceFromEveryTree()
    {
        var result = EmittedOracle.Evaluate(new[]
        {
            "func Ok() int32 -> 1",
            "let broken = undefinedName3b2",
        });

        Assert.Contains(result.Diagnostics, d => d.IsError);
        Assert.Null(result.Value);
    }

    [Fact]
    public void MultiSource_CrossTreeImportAlias_ResolvesAndRuns()
    {
        var holder = """
            package Oracle3b2.Nested

            class Holder3b2 {
                prop Value int32

                shared {
                    func MakeOne() Holder3b2 {
                        var h Holder3b2 = Holder3b2{Value: 42}
                        return h
                    }
                }
            }
            """;
        var main = """
            package Oracle3b2Main

            import R = Oracle3b2.Nested.Holder3b2

            var h R = R.MakeOne()
            h.Value
            """;

        var result = EmittedOracle.Evaluate(new[] { holder, main });

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OracleRuns_DoNotShadowLaterCompilationsOfTheSamePackage()
    {
        // Issue #3235: a finished oracle run's collectible assembly must not
        // leak into later compilations' default reference scans — otherwise
        // its emitted types shadow same-named source packages.
        var first = EmittedOracle.Evaluate("""
            package Oracle3b2.Shadow
            class Probe3b2 {
                shared {
                    const Tag string = "first"
                }
            }
            var t = Probe3b2.Tag
            t
            """);
        Assert.Empty(first.Diagnostics);
        Assert.Equal("first", first.Value);

        // Same package, different shape: must bind against ITS OWN source,
        // not the still-loaded assembly of the first run (kept alive by the
        // held result above).
        var second = EmittedOracle.Evaluate("""
            package Oracle3b2.Shadow
            class Probe3b2 {
                shared {
                    func Make() int32 -> 42
                }
            }
            var r = Probe3b2.Make()
            r
            """);
        Assert.Empty(second.Diagnostics);
        Assert.Equal(42, second.Value);
    }

    [Fact]
    public void IsLibrary_EmitsWithoutExecuting()
    {
        var result = EmittedOracle.Evaluate(
            new[]
            {
                """
                package Lib3b2
                public func Answer() int32 -> 42
                """,
            },
            new EmittedOracleOptions { IsLibrary = true });

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.Value);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(string.Empty, result.Output);
    }

    [Fact]
    public void IsLibrary_TopLevelStatementsStayAnError()
    {
        // IsLibrary's contract (ADR-0066 D4): top-level statements are an
        // error, exactly as they were under Compilation.Evaluate.
        var result = EmittedOracle.Evaluate(
            new[] { "var leaked = 1" },
            new EmittedOracleOptions { IsLibrary = true });

        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void ImplicitSystemImport_CanBeDisabled()
    {
        const string Source = """
            package Gate3b2
            let t = typeof(Console)
            """;

        Assert.Empty(EmittedOracle.Evaluate(new[] { Source }).Diagnostics);

        var gated = EmittedOracle.Evaluate(
            new[] { Source },
            new EmittedOracleOptions { ImplicitSystemImport = false });
        Assert.Contains(gated.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void ReadGlobals_ReturnsEverySourceGlobalAndNoSynthesizedFields()
    {
        var result = EmittedOracle.Evaluate("""
            var counter = 40
            counter += 2
            let label = "tag-44"
            label
            """);

        Assert.Empty(result.Diagnostics);
        var globals = result.ReadGlobals();
        Assert.Equal(42, globals["counter"]);
        Assert.Equal("tag-44", globals["label"]);
        Assert.All(globals.Keys, name => Assert.DoesNotContain("<", name));
    }

    [Fact]
    public void CompileDiagnostics_BindsWithoutRunningAndKeepsBoundStateInspectable()
    {
        // The binder-inspection companion: the caller's own Compilation stays
        // inspectable (GlobalScope/BoundProgram), diagnostics come back in
        // Evaluate's pre-execution shape, and nothing ever executes.
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From("""
                struct Pair {
                    var A int32
                    var B int32
                }
                let p = Pair{A: 1, B: 2}
                """));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);

        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);

        Assert.Empty(diagnostics);
        Assert.Contains(compilation.GlobalScope.Structs, s => s.Name == "Pair");
    }

    [Fact]
    public void CompileDiagnostics_SurfacesBodyBindingErrorsWarningsFirst()
    {
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From("""
                func Broken() int32 {
                    return undefinedName3b2
                }
                """));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);

        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);

        Assert.Contains(diagnostics, d => d.IsError);
        var firstError = diagnostics.TakeWhile(d => !d.IsError).Count();
        Assert.All(diagnostics.Skip(firstError), d => Assert.True(d.IsError));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference RunAndDiscard()
    {
        var result = EmittedOracle.Evaluate("20 + 22");
        Assert.Equal(42, result.Value);
        return result.LoadContext;
    }
}
