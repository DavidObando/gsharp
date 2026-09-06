// <copyright file="Issue4014SameGenericStructuralProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4014: a closed <c>List[int32]</c> silently structurally-projected to
/// a <c>List[string]</c>, losing every element.
/// </summary>
/// <remarks>
/// <para><b>The measured defect.</b> On the parent, <c>let zs List[string] =
/// xs</c> for an <c>xs List[int32]</c> holding one element compiled with NO
/// diagnostic, IL-verified (<c>dotnet ilverify</c>: <i>All Classes and Methods
/// … Verified</i>, run on the parent's own output), ran, and printed
/// <c>0</c>. The argument position of the same pair behaved identically. A
/// <c>List&lt;int&gt;</c> was silently replaced by a NEW, EMPTY
/// <c>List&lt;string&gt;</c>.</para>
/// <para><b>Cause.</b> ADR-0148's <c>StructuralProjectionPlanner</c> only asks
/// "can the target be constructed from the source's public member surface?".
/// For two constructions of one generic that question answers yes for a reason
/// unrelated to the values: the two share a member surface BY CONSTRUCTION, and
/// the members that actually differ (the ones mentioning the type argument) are
/// exactly the ones a member-by-member copy cannot carry. For <c>List</c> the
/// incidental overlap is a parameterless constructor plus a settable
/// <c>Capacity</c>, so the plan copied a capacity and dropped the elements.
/// With both sides CLOSED the verdict reached <c>Conversion.ClassifyCore</c>'s
/// projection arm itself and <c>ConversionClassifier.BindConversion</c>
/// materialised the plan.</para>
/// <para><b>Where the verdict lives, and why.</b> In
/// <c>StructuralProjectionPlanner.TryCreate</c> — not in <c>Conversion</c>'s
/// projection arm. TWO callers ask the planner directly: <c>Conversion</c>, and
/// applicability's ADR-0148 <c>structuralProjectionArgumentCheck</c> (the
/// second half of #4006). Closing only the conversion arm would leave the
/// argument position open, which is literally the #4006 shape. The rule is a
/// pure SHAPE test on the two CLR types — it does NOT call
/// <c>Conversion.Classify</c>, because #4006 measured that narrowing a
/// projection callback with <c>Conversion.Classify(...).Exists</c> breaks
/// <c>Issue2889</c>.</para>
/// <para><b>The two exclusions are load-bearing, and both are green rows
/// here.</b></para>
/// <list type="number">
/// <item><b>Identical closed types are untouched.</b> #2889's
/// <c>enumAction(List[Mode]{…})</c> at a <c>System.Action[List[Mode]]</c> whose
/// <c>Invoke</c> erases to <c>List&lt;int&gt;</c> is the same GENERIC
/// DEFINITION on both sides; comparing symbolic type ARGUMENTS would refuse it.
/// Comparing the CLOSED CLR types does not, because there they are the same
/// type.</item>
/// <item><b>A same-compilation G# generic is untouched</b> — it carries a null
/// <c>ClrType</c> while binding. Measured on the parent AND here: a user
/// <c>class Box[T]</c> projects <c>Box[int32]</c> to <c>Box[int64]</c> and
/// CARRIES the value (prints <c>7</c>), because a G# class's public fields ARE
/// its state. That is a faithful conversion with no soundness defect, so
/// refusing it would be a regression bought for nothing.</item>
/// </list>
/// <para><b>The green rows are the point.</b> A fix that only stops accepting
/// things is not a fix. The ADR-0148 arm this change guards still lowers a
/// genuine projection onto an imported CLR target (<c>CapSource -&gt;
/// StringBuilder</c>), a user class still projects INTO a generic CLR target
/// when the definitions differ (<c>CapOnly -&gt; List[string]</c> — the row that
/// shows the rule is about SAME-definition pairs, not about generics), identity
/// still assigns, and both of #4006's counterexamples stay green.</para>
/// </remarks>
public class Issue4014SameGenericStructuralProjectionTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The pairs that must no longer project.</summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The issue's own repro. On the parent this compiled, IL-verified, ran,
        // and printed `0` — one element in, zero out.
        yield return new object[]
        {
            "the-reported-repro-a-list-of-int32-does-not-project-to-a-list-of-string",
            """
            package P
            import System
            import System.Collections.Generic

            let xs = List[int32]()
            xs.Add(7)
            let zs List[string] = xs
            Console.WriteLine(zs.Count.ToString())
            """,
            "GS0490",
        };

        // The ARGUMENT position of the identical pair — the route the issue
        // predicted was "presumably reachable the same way". It is, and it is
        // the route the conversion arm alone would not have closed. Measured on
        // the parent: compiled, ran, printed `0`.
        yield return new object[]
        {
            "the-argument-position-of-the-same-pair-is-rejected",
            """
            package P
            import System
            import System.Collections.Generic

            func take(zs List[string]) int32 { return zs.Count }

            let xs = List[int32]()
            xs.Add(7)
            Console.WriteLine(take(xs).ToString())
            """,
            "GS0154",
        };

        // A two-parameter definition, differing only in the SECOND argument:
        // the rule covers a definition of any arity, at any position.
        //
        // NOT a soundness row, and the difference is instructive. This pair was
        // ALREADY refused on the parent — with `GS0155: Cannot convert type
        // 'Dictionary[string, int32]' to 'Dictionary[string, int64]'` — because
        // `Dictionary` happens to expose no settable member a plan could be
        // built from, where `List` exposes `Capacity`. The soundness of the
        // pre-fix compiler therefore rested on an accident of the BCL's
        // property surface. The row records the resulting DIAGNOSTIC-ID CHANGE:
        // `GS0155` becomes `GS0490`, which carries the explanation.
        yield return new object[]
        {
            "a-dictionary-differing-only-in-its-value-type-is-rejected",
            """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d["k"] = 7
            let e Dictionary[string, int64] = d
            Console.WriteLine(e.Count.ToString())
            """,
            "GS0490",
        };

        // The same pair reached through a G# function parameter rather than a
        // local, so the refusal cannot depend on how the value was introduced.
        yield return new object[]
        {
            "the-same-pair-is-rejected-when-the-source-is-a-parameter",
            """
            package P
            import System
            import System.Collections.Generic

            func hand(xs List[int32]) int32 {
                let zs List[string] = xs
                return zs.Count
            }

            Console.WriteLine(hand(List[int32]()).ToString())
            """,
            "GS0490",
        };
    }

    /// <summary>Every legitimate neighbour that must keep binding.</summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> LegitimateCases()
    {
        // Identity is not a projection and must be untouched: same generic
        // definition, SAME closed type. This is also the shape of #2889's
        // erased slot, stated at its simplest.
        yield return new object[]
        {
            "control-identity-between-two-constructions-of-the-same-type-still-assigns",
            """
            package P
            import System
            import System.Collections.Generic

            let a = List[int32]()
            a.Add(7)
            let b List[int32] = a
            Console.WriteLine(b.Count.ToString())
            """,
            new[] { "1" },
        };

        // The ADR-0148 arm this change guards, doing its real job: a G# class
        // projected onto an imported CLR target through its public settable
        // member surface. Without this row the fix would only be shown to say
        // no.
        yield return new object[]
        {
            "control-a-genuine-projection-onto-an-imported-clr-target-still-lowers",
            """
            package P
            import System
            import System.Text

            class CapSource {
                var Capacity int32
                var Length int32
            }

            let builder StringBuilder = CapSource{Capacity: 24, Length: 0}
            Console.WriteLine(builder.Capacity.ToString())
            """,
            new[] { "24" },
        };

        // The row that pins the rule's SCOPE. The target is the very
        // `List[string]` the repro was refused at, and the very `Capacity` slot
        // that made the repro's plan nonsense — but the SOURCE is a different
        // type, so this is an ordinary ADR-0148 projection and stays legal.
        // The new rule is about two constructions of ONE definition, not about
        // generic targets and not about `Capacity`.
        yield return new object[]
        {
            "control-a-user-class-still-projects-into-a-generic-clr-target",
            """
            package P
            import System
            import System.Collections.Generic

            class CapOnly {
                var Capacity int32
            }

            let lst List[string] = CapOnly{Capacity: 8}
            Console.WriteLine(lst.Capacity.ToString())
            """,
            new[] { "8" },
        };

        // The user-generic exclusion, measured rather than assumed. A
        // same-compilation `Box[T]` carries a null `ClrType` while binding, so
        // the rule cannot fire — and it must not, because here the projection
        // is FAITHFUL: a G# class's public fields ARE its state, so the value
        // arrives. Green on the parent and green here.
        yield return new object[]
        {
            "control-a-user-generic-class-projects-between-constructions-and-carries-the-value",
            """
            package P
            import System

            class Box[T] {
                public var Value T
            }

            let b = Box[int32]{ Value: 7 }
            let c Box[int64] = b
            Console.WriteLine(c.Value.ToString())
            """,
            new[] { "7" },
        };

        // #4006's counterexample, and the reason the verdict is a shape test
        // rather than a `Conversion.Classify` call. `System.Action[List[Mode]]`
        // over a same-compilation enum presents its `Invoke` parameter as
        // `List<int>`, so both sides are constructions of `List<>` — but the
        // CLOSED types are identical, which is exactly what the rule requires
        // to be different. Comparing the SYMBOLIC arguments (`Mode` vs `int32`)
        // would have refused this. Also in
        // `Issue2889LambdaThunkNestedGenericTests`; kept here because it is
        // this change's counterexample too.
        yield return new object[]
        {
            "control-issue-2889-an-erased-invoke-slot-still-accepts-a-user-enum-list",
            """
            package P
            import System
            import System.Collections.Generic

            enum Mode { First, Second }

            let enumAction System.Action[List[Mode]] =
                (items List[Mode]) -> Console.WriteLine(items.Count.ToString())
            enumAction(List[Mode]{ Mode.Second })
            """,
            new[] { "1" },
        };

        // #4004's counterexample, kept green so any future attempt to decide
        // this per type-argument POSITION trips over it immediately.
        yield return new object[]
        {
            "control-task-continuewith-keeps-its-one-concrete-and-one-open-position",
            """
            package P
            import System
            import System.Threading.Tasks

            let t = Task.CompletedTask
            let c = t.ContinueWith[string](func(prev Task) string { return "cw" })
            Console.WriteLine(c.Result)
            """,
            new[] { "cw" },
        };

        // The remedy the diagnostic leaves the author: build the target and
        // move the elements yourself. It must remain expressible.
        yield return new object[]
        {
            "control-the-explicit-remedy-still-moves-every-element",
            """
            package P
            import System
            import System.Collections.Generic

            let xs = List[int32]()
            xs.Add(7)
            xs.Add(8)

            let zs = List[string]()
            for v in xs {
                zs.Add(v.ToString())
            }

            Console.WriteLine(zs.Count.ToString())
            Console.WriteLine(zs[1])
            """,
            new[] { "2", "8" },
        };
    }

    /// <summary>
    /// The IMPORTED-parameter position of the same pair. This is the third
    /// caller of the planner (<c>ClrOverloadResolution</c>'s ADR-0148
    /// argument check), and the row records a diagnostic-id change rather than
    /// a soundness fix: on the parent the planner admitted the candidate and
    /// the conversion then refused it with <c>GS0155</c>; now the candidate is
    /// never applicable, so the call reports <c>GS0159</c>. Both reject. The
    /// row exists so that change is visible rather than discovered.
    /// </summary>
    [Fact]
    public void TheSamePairAtAnImportedParameter_IsStillRejected()
    {
        const string Source = """
            package P
            import System
            import System.Collections.Generic
            import Interop

            let xs = List[int32]()
            xs.Add(7)
            Console.WriteLine(Probes.TakeStringList(xs))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4014_clr_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "ImportedParameter.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"the pair must not reach an imported parameter. Log:\n{appLog}");
            Assert.Contains("GS0159", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The legitimate neighbour of the row above: a genuine
    /// <c>List[string]</c> still reaches the same imported parameter, so the
    /// candidate was not simply removed from the overload set.
    /// </summary>
    [Fact]
    public void AGenuineArgumentStillReachesTheSameImportedParameter()
    {
        const string Source = """
            package P
            import System
            import System.Collections.Generic
            import Interop

            let xs = List[string]()
            xs.Add("a")
            Console.WriteLine(Probes.TakeStringList(xs))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4014_clrok_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "GenuineImportedParameter.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.True(File.Exists(appPath), $"a genuine argument must still bind. Log:\n{appLog}");
            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the case must run to completion. Exit {exit}:\n{output}");
            Assert.Equal("stringlist:1", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Two constructions of one generic definition no longer structurally
    /// project, at an assignment and at an argument alike.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void TwoConstructionsOfOneGeneric_DoNotProject(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4014_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every legitimate neighbour still compiles, IL-verifies, runs, and prints
    /// what it always did.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(LegitimateCases))]
    public void ALegitimateNeighbour_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4014_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, Array.Empty<string>());

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        const string LibrarySource = """
            using System.Collections.Generic;

            namespace Interop;

            public static class Probes
            {
                public static string TakeStringList(List<string> items) => "stringlist:" + items.Count;
            }
            """;

        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "Interop",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "Interop.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
