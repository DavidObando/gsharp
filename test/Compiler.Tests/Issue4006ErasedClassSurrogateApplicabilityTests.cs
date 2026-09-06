// <copyright file="Issue4006ErasedClassSurrogateApplicabilityTests.cs" company="GSharp">
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
/// Issue #4006: a same-compilation CLASS erases to its IMPORTED BASE, so
/// <c>List[Derived]</c> bound to a parameter that genuinely is
/// <c>List&lt;ImportedBase&gt;</c> and emitted IL ILVerify rejects
/// (<c>List&lt;T&gt;</c> is invariant).
/// </summary>
/// <remarks>
/// <para><b>Two routes to the same unsound bind, and one gate that now covers
/// both.</b> The issue named one mechanism and gave one repro; they turned out
/// to be different paths.</para>
/// <list type="number">
/// <item><b>The reported repro (<c>List[Derived]</c>).</b> The argument's CLR
/// projection is the ADR-0004 <c>List&lt;object&gt;</c>, so
/// <c>ClassifyImplicit(List&lt;ImportedBase&gt;, List&lt;object&gt;)</c> is
/// <c>None</c> and the candidate is not applicable by CLR shape — which is why
/// #3989's gate never saw it (that gate is consulted only where the CLR
/// comparison already matched). It was admitted by the <c>conv == None</c>
/// fallback instead: the ADR-0148 <c>structuralProjectionArgumentCheck</c> asks
/// <c>StructuralProjectionPlanner.CanProject</c> DIRECTLY, and the planner —
/// which only asks "can the target be built from the source's public member
/// surface?" — said yes, because <c>List&lt;Derived&gt;</c> and
/// <c>List&lt;ImportedBase&gt;</c> both have a public parameterless constructor
/// and a settable <c>Capacity</c>. <c>Conversion</c> refuses that pair outright
/// (at the #2735/#3962 symbolic-type-argument identity gate, before its own
/// projection arm is reached), so the layer that EMITS projections produced no
/// node and the raw <c>List&lt;Derived&gt;</c> was pushed at an INVARIANT slot.
/// <c>ClrOverloadResolution</c> now asks the erased-argument question on that
/// arm too.</item>
/// <item><b>The map spelling (<c>map[string, Derived]</c>).</b> Found while
/// checking the fix above. Here the argument's CLR projection is
/// <c>Dictionary&lt;string, ImportedBase&gt;</c> — the imported base surrogate,
/// not <c>object</c> — so the CLR comparison reports IDENTITY against a
/// parameter that genuinely is <c>Dictionary&lt;string, ImportedBase&gt;</c>,
/// #3989's gate IS consulted, and it declined because its
/// <c>ContainsNestedObject</c> test found no <c>object</c> anywhere. That test
/// is now surrogate-aware, deriving the set from the ARGUMENT.</item>
/// </list>
/// <para><b>A narrowing that was tried and reverted.</b> Making the ADR-0148
/// callback itself require <c>Conversion.Classify(...).Exists</c> before
/// trusting the planner also closed the first case — and refused
/// <c>enumAction(List[Mode]{…})</c> at a <c>System.Action[List[Mode]]</c>,
/// whose <c>Invoke</c> parameter erases to <c>List&lt;int&gt;</c>
/// (<c>Issue2889LambdaThunkNestedGenericTests</c>). That slot's <c>int</c> DID
/// come from erasure, which is precisely what
/// <c>IsErasedGenericParameterSlot</c> exists to exempt — so the verdict has to
/// be asked per SLOT, where that exemption is in scope, not inside a callback
/// that cannot see the candidate.</para>
/// <para><b>The enum surrogate has no hole, and is deliberately not in the
/// set.</b> A <c>List[MyEnum]</c> at a genuine <c>List&lt;int&gt;</c> parameter
/// is refused with <c>GS0159</c> both before and after this change —
/// <c>MemberLookup.ExcludeErasureOnlyEnumCandidates</c> pre-filters it, a
/// dedicated defence the class surrogate never had. Adding <c>int</c> to the
/// surrogate set would make every nested <c>int</c> position suspect for any
/// argument carrying a user enum, and buy nothing. It is a red row on both
/// sides on purpose: the asymmetry between surrogates is the thing this issue
/// says not to assume.</para>
/// <para><b>The green rows are the point.</b> A fix that only stops accepting
/// things is not a fix. Covariance still binds — both the
/// <c>IEnumerable&lt;ImportedBase&gt;</c> sequence and, for
/// <c>[]Derived</c> at an <c>ImportedBase[]</c> parameter, real CLR array
/// covariance, which trips the same surrogate suspicion and is saved by the
/// verdict. A genuine <c>List[ImportedBase]</c> or
/// <c>Dictionary[string, ImportedBase]</c> still binds, an inferred generic
/// slot is never second-guessed, a real ADR-0148 projection at an imported
/// method parameter still binds AND emits, and
/// <c>Task.ContinueWith[TResult](Func[Task, TResult])</c> — one concrete nested
/// position beside one open one, the counterexample that reverted #4004's
/// attempted per-position redesign — stays green.</para>
/// </remarks>
public class Issue4006ErasedClassSurrogateApplicabilityTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The C# library every fixture case links against.</summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace Interop;

        public class ImportedBase
        {
            public string Name { get; set; } = "base";
        }

        public sealed class Point
        {
            public Point(int x, int y)
            {
                this.X = x;
                this.Y = y;
            }

            public int X { get; }

            public int Y { get; }
        }

        public static class Probes
        {
            // The reported slot: genuinely `List<ImportedBase>`, invariant.
            public static string CountBaseList(List<ImportedBase> items)
                => "baselist:" + items.Count;

            // The covariant sibling: genuinely valid for a `List[Derived]`.
            public static string CountBaseSeq(IEnumerable<ImportedBase> items)
            {
                var n = 0;
                foreach (var unused in items)
                {
                    n++;
                }

                return "baseseq:" + n;
            }

            // The map spelling of the same slot, one level in.
            public static string CountBaseMap(Dictionary<string, ImportedBase> entries)
                => "basemap:" + entries.Count;

            // The array spelling. CLR arrays ARE covariant, so this one is a
            // legal reference conversion and must keep binding.
            public static string TakeBaseArray(ImportedBase[] items)
                => "basearray:" + items.Length;

            // An inferred generic slot: exactly what the erasure exists to
            // serve, and never second-guessed.
            public static string CountAny<T>(List<T> items) => "any:" + items.Count;

            // The enum surrogate's slot.
            public static string CountIntList(List<int> items) => "intlist:" + items.Count;

            // A genuine ADR-0148 projection target at an imported METHOD
            // PARAMETER — the exact path this change edits.
            public static string DescribePoint(Point p) => "point:" + p.X + "," + p.Y;
        }
        """;

    /// <summary>The rejection cases: the unsound binds that used to compile.</summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The issue's own repro. Compiled on `main`, printed `baselist:1`, and
        // ilverify reported StackUnexpected
        // [found List`1<P.Derived>] [expected List`1<Interop.ImportedBase>].
        yield return new object[]
        {
            "the-reported-repro-is-rejected",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let derived = List[Derived]()
            derived.Add(Derived{})
            Console.WriteLine(Probes.CountBaseList(derived))
            """,
            "GS0159",
        };

        // The map spelling: a DIFFERENT path (the argument erases to the
        // imported base, not to `object`, so the CLR comparison reports
        // identity and #3989's gate is the one that has to refuse it).
        yield return new object[]
        {
            "the-map-spelling-of-the-same-hole-is-rejected",
            """
            package P
            import System
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[string, Derived]{}
            entries["k"] = Derived{}
            Console.WriteLine(Probes.CountBaseMap(entries))
            """,
            "GS0159",
        };

        // The same unsound bind reached from inside a G# function rather than
        // from a local: the argument's type is spelled by a parameter, so the
        // refusal cannot depend on how the value was introduced.
        yield return new object[]
        {
            "a-derived-list-does-not-reach-a-genuine-base-list-through-a-generic-function",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            func hand(items List[Derived]) string {
                return Probes.CountBaseList(items)
            }

            Console.WriteLine(hand(List[Derived]()))
            """,
            "GS0159",
        };

        // The enum surrogate control. Refused BEFORE this change too, by
        // `ExcludeErasureOnlyEnumCandidates` — pinned so the asymmetry between
        // surrogates stays measured rather than assumed.
        yield return new object[]
        {
            "the-enum-surrogate-was-and-remains-refused",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            enum MyEnum {
                A
                B
            }

            let values = List[MyEnum]()
            values.Add(MyEnum.A)
            Console.WriteLine(Probes.CountIntList(values))
            """,
            "GS0159",
        };
    }

    /// <summary>Every legitimate neighbour that must keep binding.</summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> LegitimateCases()
    {
        // The covariant sibling: `IEnumerable<T>` IS covariant and `Derived`
        // IS an `ImportedBase`, so this conversion is real and must survive.
        // A genuine `List[ImportedBase]` at the invariant slot must too, and an
        // inferred generic slot is never second-guessed.
        yield return new object[]
        {
            "covariance-a-genuine-argument-and-an-inferred-slot-all-still-bind",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let derived = List[Derived]()
            derived.Add(Derived{})
            Console.WriteLine(Probes.CountBaseSeq(derived))

            let bases = List[ImportedBase]()
            bases.Add(ImportedBase{})
            Console.WriteLine(Probes.CountBaseList(bases))

            Console.WriteLine(Probes.CountAny[Derived](derived))
            """,
            new[] { "baseseq:1", "baselist:1", "any:1" },
        };

        // The genuine neighbour of the refused map row: a dictionary that
        // really holds imported bases reaches the genuine slot untouched. The
        // widened surrogate test is derived from the ARGUMENT, and this
        // argument erased nothing, so it never reaches the test at all.
        //
        // Spelled `Dictionary[string, ImportedBase]` rather than
        // `map[string, ImportedBase]{}` because the map LITERAL over an
        // imported element hits an unrelated emit failure (GS9998,
        // "TypeBuilder generic instantiation does not support resolving
        // members"), measured identical on `main` and filed as #4015.
        // ADR-0104: the two spellings are one type, so the binding under test
        // is the same.
        //
        // The inferred-slot neighbour is carried by the `List` spelling in the
        // row above (`CountAny[Derived]`). The `map` spelling of it did not
        // bind when this fixture was written, for a reason of its own — #4016,
        // the explicit type-argument placeholder disagreeing with the argument
        // erasure — which is now fixed. That row, and the slice and array
        // spellings that failed with it, live in
        // `Issue4016ExplicitTypeArgumentErasureTests` rather than being
        // duplicated here; the rejections below are what THIS issue pins.
        yield return new object[]
        {
            "a-genuine-imported-base-dictionary-still-binds",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            let genuine = Dictionary[string, ImportedBase]()
            genuine["k"] = ImportedBase{}
            Console.WriteLine(Probes.CountBaseMap(genuine))
            """,
            new[] { "basemap:1" },
        };

        // The ADR-0148 projection doing its real job, at an imported METHOD
        // PARAMETER — the exact callback this change edits. Without this row
        // the fix would only have been shown to say no.
        yield return new object[]
        {
            "a-genuine-structural-projection-at-an-imported-parameter-still-binds",
            """
            package P
            import System
            import Interop

            class PtSource {
                var x int32
                var y int32
            }

            Console.WriteLine(Probes.DescribePoint(PtSource{x: 3, y: 4}))
            """,
            new[] { "point:3,4" },
        };

        // The ARRAY spelling of the same surrogate — and the row that shows
        // the widened suspicion is only a suspicion. A `[]Derived` erases to
        // `ImportedBase[]` exactly as the map erased to
        // `Dictionary<string, ImportedBase>`, so it trips the same test; but
        // CLR arrays are COVARIANT, so `Conversion` reports a real conversion
        // and the verdict lets it through. Invariance is what made the map row
        // unsound, not the erasure.
        yield return new object[]
        {
            "the-covariant-array-spelling-still-binds",
            """
            package P
            import System
            import Interop

            class Derived : ImportedBase {
            }

            Console.WriteLine(Probes.TakeBaseArray([]Derived{Derived{}}))
            Console.WriteLine(Probes.TakeBaseArray([]ImportedBase{ImportedBase{}}))
            """,
            new[] { "basearray:1", "basearray:1" },
        };

        // ADR-0148 projection at an ASSIGNMENT, onto an imported CLR target
        // built through its public member surface. This is the arm of
        // `Conversion.Classify` that reports `StructuralProjection` — the
        // conversion layer performing the projection the row above only asks
        // applicability about, and the reason the erased-argument gate takes
        // `Conversion.Classify(...).Exists` as its verdict rather than
        // second-guessing the planner: a real projection EXISTS, so the gate
        // lets it through.
        yield return new object[]
        {
            "a-genuine-projection-onto-an-imported-clr-target-still-lowers",
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

        // The SECOND counterexample, and the one that reverted this issue's
        // first attempted fix. An imported delegate's `Invoke` parameter is the
        // open `!0` of `Action<T>`, so a `System.Action[List[Mode]]` over a
        // same-compilation enum presents it as `List<int>` — a slot whose `int`
        // DID come from erasure, exempted by `IsErasedGenericParameterSlot`.
        // Narrowing the ADR-0148 callback itself (requiring
        // `Conversion.Classify(...).Exists` before trusting the planner) closed
        // the `List[Derived]` case and broke this one, because a callback
        // cannot see the candidate and so cannot apply that exemption. Asking
        // the erased-argument question at the SLOT instead is what keeps both
        // right. Also in `Issue2889LambdaThunkNestedGenericTests`; kept here
        // because it is this change's counterexample, not that one's.
        yield return new object[]
        {
            "an-imported-delegates-erased-invoke-slot-still-accepts-a-user-enum-list",
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

        // THE counterexample. `Task.ContinueWith[TResult](Func[Task, TResult])`
        // has one concrete nested position (`Task`) beside one open one
        // (`TResult`) — position for position the same shape as
        // `Dictionary[T, List[object]]`. #4004 implemented a per-position
        // version of #3989's gate, this broke, and it was reverted. Kept green
        // here so any future per-position attempt trips over it immediately.
        yield return new object[]
        {
            "task-continuewith-keeps-its-one-concrete-and-one-open-position",
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
    }

    /// <summary>
    /// An erased class surrogate that reached a genuine imported-base slot is
    /// now refused, rather than emitting IL that does not verify.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AnErasedClassSurrogateAtAGenuineImportedSlot_IsRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4006_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

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
    /// Every legitimate neighbour of the refused bind still compiles,
    /// IL-verifies, runs, and prints what it always did.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(LegitimateCases))]
    public void ALegitimateNeighbour_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4006_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

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
