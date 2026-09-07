// <copyright file="Issue4063BareImportedDependentBoundTests.cs" company="GSharp">
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
/// Issue #4063: a BARE IMPORTED dependent constraint
/// (<c>where TDerived : TBase</c>) over two erased same-compilation classes.
/// </summary>
/// <remarks>
/// <para><b>The repro, re-measured on <c>origin/main</c> @ <c>7708be7d</c>
/// before anything was written.</b> Against the imported
/// <c>Chain&lt;TBase, TDerived&gt; where TDerived : TBase</c>, the program
/// <c>var c Chain[ChA, ChB]</c> — with <c>ChA</c> and <c>ChB</c> unrelated
/// classes declared in the same compilation — compiled with no diagnostic and
/// threw <c>TypeLoadException: GenericArguments[1], 'P.ChB', on
/// 'HelperLib3.Chain`2[TBase,TDerived]' violates the constraint of type
/// parameter 'TDerived'</c> the first time the program touched the type.</para>
/// <para><b>Root cause.</b> #4041 taught the imported constraint check to
/// answer a DEPENDENT bound on the SYMBOLIC vector, because the erased CLR
/// vector cannot tell two same-compilation classes apart — both project to a
/// <c>System.Object</c> placeholder. But the relation it implemented is
/// INVARIANT IDENTITY, which is correct at a generic ARGUMENT position
/// (<c>where U : IList&lt;T&gt;</c>, where <c>IList</c> is invariant in
/// <c>T</c>) and WRONG at the TOP of a bound, where the relation is
/// ASSIGNABILITY. Rather than answer with the wrong relation,
/// <c>MatchDependentShape</c> declined at depth 0 and handed the question back
/// to the erased CLR comparison — which substitutes the bound to
/// <c>object</c> and accepts everything. So this is a RELATION error on a path
/// that exists, not a missing check: the guard was load-bearing and correct
/// about identity, and only wrong to conclude that no answer was available.
/// </para>
/// <para><b>The repair, and why it is a call rather than a copy.</b> At the top
/// of the bound the question is now put to the symbols through
/// <c>Binder.SatisfiesDependentBound</c> — the very predicate #4043 wrote for
/// the G#-DECLARED spelling of this same bound
/// (<c>func take[TBase, TDerived TBase]()</c>). Reimplementing assignability
/// inside <c>ClrOverloadResolution</c> would let the imported and G#-declared
/// spellings of one rule drift apart, and it is drift, not the relation, that
/// manufactures a false <c>GS0152</c>. <c>SatisfiesDependentBound</c> already
/// accepts on every indeterminate answer, so a <see langword="false"/> from it
/// is a definitive "no"; a <see langword="true"/> is mapped back to
/// INDETERMINATE rather than to "matches", because it may equally mean "cannot
/// tell", and the CLR fallback accepts an erased vector anyway.</para>
/// <para><b>Two guards keep the answer honest.</b> The relation is not asked
/// at all when either side still mentions a type parameter — an open
/// instantiation has no closed answer, and it is exactly there that
/// <c>SatisfiesDependentBound</c>'s self-substitution would need the bounded
/// parameter's own symbol, which the imported path does not have (it passes
/// <see langword="null"/>). And the whole symbolic arm is still gated on
/// <c>AnyDependentPositionIsErased</c>, so a fully imported vector keeps its
/// pre-#4041 answer.</para>
/// <para><b>The message names the bound the author wrote.</b> The SUBSTITUTED
/// bound at a bare dependent position is the erasure — <c>System.Object</c> —
/// and "does not satisfy the 'System.Object' constraint" names the compiler's
/// internals rather than the program. The UNSUBSTITUTED bound is the generic
/// parameter itself, whose name is <c>TBase</c>, and that is what is reported.
/// </para>
/// <para><b>There was no asserting row to move.</b> #4063 was filed with prose
/// only: <c>Issue4041DependentConstraintOverErasedClassesTests</c>' remarks
/// record the gap, and its green control
/// <c>a-bare-dependent-bound-that-holds-over-erased-classes</c> is the row that
/// forced the decline. That control is unchanged and still green; the remarks
/// and the <c>atTopOfBound</c> documentation are updated to describe the answer
/// rather than the decline.</para>
/// <para><b>Blast radius.</b> This turns previously-compiling code into an
/// error. The whole <c>.gs</c> corpus was swept before and after: 197 files,
/// 170 of which emit an assembly under the sweep's reference set,
/// <b>0 occurrences of GS0152</b>.</para>
/// </remarks>
public class Issue4063BareImportedDependentBoundTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The issue's own C# library, verbatim, plus the generic METHOD spelling
    /// of the same bare bound.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib3;

        // The issue's own library, verbatim. A BARE dependent bound: the whole
        // bound is a type parameter, so the relation at its top is
        // assignability rather than the identity that is right at an argument
        // position.
        public class Chain<TBase, TDerived>
            where TDerived : TBase
        {
            public string Tag { get; set; } = "chain";
        }

        public static class Picker
        {
            public static string Pick<TBase, TDerived>()
                where TDerived : TBase
                => "picked";
        }
        """;

    /// <summary>
    /// The G# declarations every row shares: a base/derived pair, two unrelated
    /// classes, an interface with an implementor, and a source class deriving
    /// from an IMPORTED base.
    /// </summary>
    private const string Prelude = """
        package P
        import System
        import HelperLib3

        open class ChBase {
            public var N int32
        }

        class ChDerived : ChBase {
            public var M int32
        }

        class ChA {
            public var P int32
        }

        class ChB {
            public var Q int32
        }

        interface IFoo {
            func Ping() int32;
        }

        class ChImpl : IFoo {
            public func Ping() int32 { return 1 }
        }

        class MyErr : Exception {
        }

        """;

    /// <summary>
    /// Every instantiation whose BARE dependent bound is violated once the
    /// symbols are consulted. Each of these compiled with no diagnostic on the
    /// parent and threw <c>TypeLoadException</c> at run time.
    /// </summary>
    /// <returns>Case name, the G# body appended to the prelude, expected diagnostic id.</returns>
    public static IEnumerable<object[]> BareBoundViolations()
    {
        // The issue's own repro, verbatim.
        yield return new object[]
        {
            "the-issues-own-repro",
            """
            var c Chain[ChA, ChB]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // The constructor spelling, which additionally emitted IL that
        // ILVerify refuses with UnsatisfiedMethodParentInst.
        yield return new object[]
        {
            "the-constructor-spelling-of-the-same-instantiation",
            """
            let c = Chain[ChA, ChB]()
            Console.WriteLine(c.Tag)
            """,
            "GS0152",
        };

        // Only ONE side erased is enough: an IMPORTED `string` at TDerived
        // against a same-compilation `ChA` at TBase. `string` is sealed and
        // derives from nothing the program declares.
        yield return new object[]
        {
            "an-imported-derived-against-an-erased-base",
            """
            var c Chain[ChA, string]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // A VALUE TYPE at a class-typed bound. The CLR admits a value type at
        // a dependent bound only when the bound is `object` (measured against
        // the runtime, see the green row below); `ChBase` is not.
        yield return new object[]
        {
            "a-value-type-at-a-class-typed-bound",
            """
            var c Chain[ChBase, int32]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // The bound is a same-compilation INTERFACE the argument does not
        // implement. The relation is implementation, not derivation, and both
        // arms belong to assignability.
        yield return new object[]
        {
            "an-interface-bound-the-argument-does-not-implement",
            """
            var c Chain[IFoo, ChA]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // Assignability is DIRECTED, and getting the direction wrong is the
        // most likely way to reintroduce the defect: `ChBase` does not derive
        // from `ChDerived`, so the reversed spelling of the green control must
        // be refused.
        yield return new object[]
        {
            "the-reversed-derivation",
            """
            var c Chain[ChDerived, ChBase]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };
    }

    /// <summary>
    /// Every shape the repair must NOT reject. A wrong "no" on any of these is
    /// a worse defect than the one being fixed, which is why an indeterminate
    /// symbolic answer falls back to the CLR comparison rather than to a
    /// rejection.
    /// </summary>
    /// <returns>Case name, the G# body appended to the prelude, expected stdout lines.</returns>
    public static IEnumerable<object[]> BareBoundControls()
    {
        // THE row that forced #4041 to decline here, and the reason closing
        // #4063 with identity would have been the worse failure. It is a green
        // row in `Issue4041DependentConstraintOverErasedClassesTests` too, and
        // it stays green there.
        yield return new object[]
        {
            "a-bare-dependent-bound-that-holds-over-erased-classes",
            """
            var c Chain[ChBase, ChDerived]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // Identity is one arm of assignability, not a violation of it.
        yield return new object[]
        {
            "the-identical-erased-class-on-both-sides",
            """
            var c Chain[ChBase, ChBase]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // The interface arm, satisfied. A same-compilation class has no CLR
        // type while binding, so this is answered off the symbol's declared
        // interface list.
        yield return new object[]
        {
            "a-source-class-implementing-the-bound-interface",
            """
            var c Chain[IFoo, ChImpl]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // Fully IMPORTED: nothing is erased, the symbolic arm never fires, and
        // the pre-#4041 path answers exactly as before.
        yield return new object[]
        {
            "the-issues-own-fully-imported-control",
            """
            var c Chain[object, string]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // `where TDerived : TBase` with TBase = object is the UNIVERSAL bound:
        // a value type satisfies it. Measured against the runtime —
        // `typeof(Chain<,>).MakeGenericType(typeof(object), typeof(int))`
        // constructs and instantiates, while the `ChBase` spelling above
        // throws ArgumentException.
        yield return new object[]
        {
            "the-universal-object-bound-admits-a-value-type",
            """
            var c Chain[object, int32]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // Two IMPORTED types related by derivation. Not erased at all, so this
        // pins that the gate on `AnyDependentPositionIsErased` still holds.
        yield return new object[]
        {
            "two-imported-types-related-by-derivation",
            """
            var c Chain[Exception, InvalidOperationException]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // A SOURCE class deriving from an IMPORTED base, checked against that
        // imported base. The symbol has no CLR type of its own, so the walk has
        // to reach `ImportedBaseType`.
        yield return new object[]
        {
            "a-source-class-deriving-from-the-imported-bound",
            """
            var c Chain[Exception, MyErr]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // OPEN: the bound is forwarded through a G# generic, so both sides
        // still mention type parameters and there is no closed answer. The
        // check must decline; the CLR only loads the instantiation once closed.
        yield return new object[]
        {
            "an-open-forwarded-instantiation-is-left-alone",
            """
            class Holder[TB, TD TB] {
                public var C Chain[TB, TD]
            }

            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // The generic METHOD spelling of the same bare bound, satisfied. The
        // imported METHOD path has had its own constraint check since
        // #750/ADR-0088 and shares this checker.
        yield return new object[]
        {
            "a-generic-method-with-a-matched-bare-bound",
            """
            Console.WriteLine(Picker.Pick[ChBase, ChDerived]())
            """,
            new[] { "picked" },
        };

        // Review finding: the row that actually EXERCISES
        // `MatchDependentTopOfBound`'s open-side guard. The generic TYPE path
        // never reaches it with an open vector — `ReportUnsatisfiedGenericTypeConstraint`
        // short-circuits an open instantiation into #4037's forwarding rule
        // before `SatisfiesGenericTypeConstraints` is called at all, so
        // `an-open-forwarded-instantiation-is-left-alone` above proves the
        // program binds but not that the guard was consulted. The imported
        // generic METHOD path DOES hand the checker unsubstituted symbols, so
        // forwarding the bare bound through a G# generic function is where a
        // guard that answered instead of declining would manufacture a
        // GS0152 on a legal program.
        yield return new object[]
        {
            "an-open-forwarded-bare-bound-at-a-generic-method",
            """
            func pick[TB, TD TB]() string {
                return Picker.Pick[TB, TD]()
            }

            Console.WriteLine(pick[ChBase, ChDerived]())
            """,
            new[] { "picked" },
        };
    }

    /// <summary>
    /// A violated BARE dependent bound reports <c>GS0152</c> at compile time —
    /// exactly once — instead of emitting an instantiation the CLR refuses.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared prelude.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(BareBoundViolations))]
    public void AViolatedBareDependentBound_IsRefused(string name, string body, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4063_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(
                tempDir, "App.gs", Prelude + body, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal);

            // Issue #4032's CI follow-up, inherited through #4041: assert the
            // COUNT, not the presence. The binder probes the same receiver
            // through several entry points before committing to a reading of
            // it, so a per-call report turns one violation into a count that is
            // a function of how many internal paths the binder happened to
            // take.
            var occurrences = appLog.Split(expectedId, StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"'{name}' must report {expectedId} exactly once, saw {occurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every legitimate neighbour compiles, IL-verifies, runs, and prints.
    /// These are the rows a false GS0152 would break.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared prelude.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(BareBoundControls))]
    public void ASatisfiedBareDependentBound_CompilesVerifiesAndRuns(
        string name,
        string body,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4063_ok_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(
                tempDir, "App.gs", Prelude + body, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);
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

    /// <summary>
    /// The <c>GS0152</c> text names the type argument, the type PARAMETER whose
    /// bound failed, and the BOUND AS WRITTEN — <c>TBase</c>, not the
    /// <c>System.Object</c> the erasure substitutes into it. Without this the
    /// message would name the compiler's placeholder and tell an author
    /// nothing.
    /// </summary>
    [Fact]
    public void TheDiagnosticNamesTheBoundingParameterRatherThanTheErasure()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4063_msg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(
                tempDir,
                "App.gs",
                Prelude + "var c Chain[ChA, ChB]\nConsole.WriteLine(\"compiled\")\n",
                appPath,
                "/target:exe",
                "/reference:" + libPath);

            Assert.Contains("GS0152", appLog, StringComparison.Ordinal);
            Assert.Contains("'ChB'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TDerived'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TBase'", appLog, StringComparison.Ordinal);
            // Quoted, because the diagnostic format quotes the constraint it
            // names: a bare `System.Object` substring would also match an
            // unrelated `System.ObjectModel` in the reference warning.
            Assert.DoesNotContain("'System.Object'", appLog, StringComparison.Ordinal);
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
            "HelperLib3",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib3.dll");
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
