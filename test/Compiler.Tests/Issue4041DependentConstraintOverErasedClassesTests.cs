// <copyright file="Issue4041DependentConstraintOverErasedClassesTests.cs" company="GSharp">
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
/// Issue #4041: a DEPENDENT generic constraint checked after erasure has
/// collapsed two distinct same-compilation classes.
/// </summary>
/// <remarks>
/// <para><b>The repro, re-measured on <c>origin/main</c> @ <c>3e5103de</c>
/// before anything was written.</b> Against the imported
/// <c>Coupled&lt;T, U&gt; where U : IList&lt;T&gt;</c>, the program
/// <c>var c Coupled[A, List[Bee]]</c> — with <c>A</c> and <c>Bee</c> unrelated
/// classes declared in the same compilation — compiled with no diagnostic and
/// threw <c>TypeLoadException: GenericArguments[1],
/// 'System.Collections.Generic.List`1[P.Bee]', on 'HelperLib3.Coupled`2[T,U]'
/// violates the constraint of type parameter 'U'</c> the first time the program
/// touched the type.</para>
/// <para><b>Root cause.</b> A same-compilation class has no CLR type while
/// binding, so it projects to a <c>System.Object</c> placeholder. Both <c>A</c>
/// and <c>Bee</c> therefore arrive as <c>object</c>, and the vector handed to
/// the constraint check is <c>Coupled&lt;object, List&lt;object&gt;&gt;</c>.
/// <c>SatisfiesDeclaredConstraints</c> substitutes that vector into each bound
/// before testing it, so <c>U : IList&lt;T&gt;</c> becomes
/// <c>IList&lt;object&gt;</c> — and <c>List&lt;object&gt;</c> genuinely does
/// satisfy it. The check answered honestly on what it was given; the
/// information that distinguishes <c>A</c> from <c>Bee</c> was gone before it
/// was asked. Emission then reified the real types, so the instantiation the
/// CLR sees is the one that violates the bound.</para>
/// <para><b>#4016/#4031's <c>NormaliseErasedTypeArgsForConstraintCheck</c> is
/// NOT the culprit, and this was verified rather than taken on trust.</b> That
/// normalisation replaces an erased position with the load context's own
/// <c>System.Object</c> so a projection cannot break a SIBLING parameter's
/// constraint. It operates on the vector AFTER the collapse; the collapse
/// itself happens earlier, in <c>ProjectGenericArgument</c>. Normalising a
/// placeholder more carefully cannot recover which class it stood for.</para>
/// <para><b>The repair, and why it is three-state.</b> The declared bound is
/// now kept UNSUBSTITUTED, and when it mentions another type parameter whose
/// argument arrived erased, the question is put to the SYMBOLS instead: build
/// the expected bound <c>IList[A]</c> from the symbolic vector, recover
/// <c>List[Bee]</c>'s own instantiation of <c>IList&lt;&gt;</c> as
/// <c>IList[Bee]</c>, and compare. A definitive no rejects, a definitive yes
/// accepts, and ANYTHING ELSE falls through to the pre-existing CLR comparison
/// — never to a rejection. A wrong "no" would be a GS0152 on a legal program,
/// which is a strictly worse failure than the one being fixed.</para>
/// <para><b>Two cases force the fallback, and each has its own green row.</b>
/// VARIANCE: <c>IEnumerable&lt;out T&gt;</c> is covariant, so
/// <c>Covariant[CovBase, List[CovDerived]]</c> is legal C# and identity is the
/// wrong relation. The TOP OF A BOUND: identity is right at an invariant
/// ARGUMENT position and wrong at the top, where the relation is assignability
/// — so a bare <c>where TDerived : TBase</c> instantiated as
/// <c>Chain[ChBase, ChDerived]</c> must keep binding.</para>
/// <para>The second one is load-bearing rather than defensive, and that was
/// MEASURED: with <c>MatchDependentShape</c>'s <c>depth == 0</c> guard disabled
/// and nothing else changed, <c>a-bare-dependent-bound-that-holds-over-erased-classes</c>
/// fails with a false <c>GS0152</c> (1 red / 11 green on that build). The cost
/// of declining there is that the imported spelling of a bare dependent bound
/// over two UNRELATED erased classes is still accepted — the imported analogue
/// of #4043, needing symbolic ASSIGNABILITY rather than identity, filed as
/// #4063. Accepting too much is the recoverable direction; a false GS0152 on a
/// legal program is not.</para>
/// <para><b>The asserting row this issue was filed with has been moved, not
/// deleted.</b> <c>Issue4032ConstrainedImportedGenericBaseTests</c> pinned this
/// gap as <c>ADependentConstraintOverTwoErasedClasses_IsStillAccepted_Issue4041</c>,
/// asserting that the program compiled and then threw, with a message telling
/// whoever closed the issue to move it. The violating spellings are now rows in
/// that class's <c>ConstraintViolations</c> and the matched, imported and
/// covariant spellings are rows in its <c>DependentBoundControls</c>. This
/// class is the issue's own library and repro, kept verbatim.</para>
/// </remarks>
public class Issue4041DependentConstraintOverErasedClassesTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The issue's own C# library, verbatim, plus the covariant and
    /// two-parameter shapes the controls need.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib3;

        using System.Collections.Generic;

        public class Coupled<T, U>
            where U : IList<T>
        {
            public string Tag { get; set; } = "coupled";
        }

        public class Covariant<T, U>
            where U : IEnumerable<T>
        {
            public string Tag { get; set; } = "covariant";
        }

        public class Nested<T, U>
            where U : IList<List<T>>
        {
            public string Tag { get; set; } = "nested";
        }

        // A BARE dependent bound. Its relation is assignability, not identity:
        // `Chain<ChBase, ChDerived>` is legal, so the symbolic path must decline
        // to answer at the top of a bound and leave it to the CLR comparison.
        public class Chain<TBase, TDerived>
            where TDerived : TBase
        {
            public string Tag { get; set; } = "chain";
        }

        // Review finding (#4068): an imported GENERIC interface a source class
        // can implement DIRECTLY, rather than inheriting through an imported
        // base. The symbolic walk used to follow only `ImportedBaseType`.
        public interface IDep<T>
        {
            T? Item { get; }
        }

        public class Coupled3<T, U>
            where U : IDep<T>
        {
            public string Tag { get; set; } = "coupled3";
        }

        // Review finding (#4068): a bound nested far deeper than the old
        // hard-coded recursion cap of eight.
        public class Deep<T, U>
            where U : IList<List<List<List<List<List<List<List<List<List<List<T>>>>>>>>>>>
        {
            public string Tag { get; set; } = "deep";
        }

        public static class Probe
        {
            public static string Take<T, U>(U value)
                where U : IList<T>
                => "took";
        }
        """;

    /// <summary>
    /// Every instantiation whose dependent bound is VIOLATED once the symbols
    /// are consulted. Each of these compiled with no diagnostic on the parent
    /// and threw <c>TypeLoadException</c> at run time.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> DependentViolations()
    {
        // The issue's own repro, verbatim.
        yield return new object[]
        {
            "the-issues-own-repro",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            class Bee {
                public var M int32
            }

            var c Coupled[A, List[Bee]]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // The constructor spelling, which the issue records as additionally
        // failing `ilverify` with `UnsatisfiedMethodParentInst`.
        yield return new object[]
        {
            "the-constructor-spelling-of-the-same-instantiation",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            class Bee {
                public var M int32
            }

            let c = Coupled[A, List[Bee]]()
            Console.WriteLine(c.Tag)
            """,
            "GS0152",
        };

        // Only ONE side erased is enough to lose the answer: an imported
        // `string` against a same-compilation `Bee` collapses the `Bee` half.
        yield return new object[]
        {
            "one-erased-side-against-an-imported-one",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class Bee {
                public var M int32
            }

            var c Coupled[string, List[Bee]]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // REVIEW FINDING (#4068), the serious half. A source class that
        // implements the imported generic interface DIRECTLY —
        // `class Impl : IDep[Bee]` — reached the symbolic walk, which followed
        // only `ImportedBaseType`, found nothing, and returned "no answer". The
        // erased comparison then saw `IDep<object>` on both sides and ACCEPTED
        // this, and it threw `TypeLoadException` at run time. That is this
        // change's own defect reached by a different route.
        yield return new object[]
        {
            "review-a-source-class-implementing-the-bound-generic-interface",
            """
            package P
            import System
            import HelperLib3

            class A {
                public var N int32
            }

            class Bee {
                public var M int32
            }

            class Impl : IDep[Bee] {
                public prop Item Bee { get { return nil } }
            }

            var c Coupled3[A, Impl]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // REVIEW FINDING (#4068): eleven levels of invariant nesting, well past
        // the recursion cap of eight the first version of this check imposed.
        // At that cap the shape returned indeterminate and fell back to the
        // erased comparison — the very hole the check exists to close — so the
        // cap was replaced by cycle detection.
        yield return new object[]
        {
            "review-a-bound-nested-past-the-old-recursion-cap",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            class Bee {
                public var M int32
            }

            var d Deep[A, List[List[List[List[List[List[List[List[List[List[List[Bee]]]]]]]]]]]]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };

        // NESTED erasure: the bound is `IList<List<T>>`, so the comparison has
        // to recurse rather than stop at a reference check on the outer
        // construction.
        yield return new object[]
        {
            "a-nested-dependent-bound-over-two-erased-classes",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            class Bee {
                public var M int32
            }

            var c Nested[A, List[List[Bee]]]
            Console.WriteLine("compiled")
            """,
            "GS0152",
        };
    }

    /// <summary>
    /// Every shape the repair must NOT reject. A wrong "no" on any of these is
    /// a worse defect than the one being fixed, which is why the symbolic check
    /// falls back to the CLR comparison rather than to a rejection.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> SatisfiedShapes()
    {
        // MATCHED, same-compilation: both positions are the same erased class,
        // so the symbols agree even though the CLR vector cannot tell.
        yield return new object[]
        {
            "matched-over-one-same-compilation-class",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            var c Coupled[A, List[A]]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // MATCHED, fully imported: nothing is erased, so the trigger never
        // fires and the pre-existing path answers exactly as before.
        yield return new object[]
        {
            "matched-over-imported-types",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            var c Coupled[string, List[string]]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // COVARIANT: `IEnumerable<out T>` admits `List<CovDerived>` at
        // `IEnumerable<CovBase>`, so identity is the wrong relation and the
        // symbolic path must decline to answer.
        yield return new object[]
        {
            "a-covariant-bound-over-a-derived-erased-class",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            open class CovBase {
                public var N int32
            }

            class CovDerived : CovBase {
                public var M int32
            }

            var c Covariant[CovBase, List[CovDerived]]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // MATCHED nested.
        yield return new object[]
        {
            "matched-nested-over-one-same-compilation-class",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            var c Nested[A, List[List[A]]]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // OPEN: the bound is forwarded through a G# generic, so the arguments
        // still mention type parameters and there is no closed answer. The
        // check must leave it alone; the CLR only loads it once closed.
        yield return new object[]
        {
            "an-open-forwarded-instantiation-is-left-alone",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class Holder[T] {
                public var C Coupled[T, List[T]]
            }

            let h = Holder[string]()
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // A BARE dependent bound (`where TDerived : TBase`) over two erased
        // same-compilation classes where the relation genuinely HOLDS. This is
        // the row that caught a false rejection during development: at the TOP
        // of a bound the relation is assignability, not the invariant identity
        // that is correct at an argument position, so the symbolic path
        // deliberately declines to answer there.
        yield return new object[]
        {
            "a-bare-dependent-bound-that-holds-over-erased-classes",
            """
            package P
            import System
            import HelperLib3

            open class ChBase {
                public var N int32
            }

            class ChDerived : ChBase {
                public var M int32
            }

            var c Chain[ChBase, ChDerived]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // REVIEW FINDING (#4068) control: the MATCHED spelling of the
        // source-implements-the-bound-interface shape must keep binding.
        yield return new object[]
        {
            "review-a-source-class-implementing-the-bound-interface-matched",
            """
            package P
            import System
            import HelperLib3

            class A {
                public var N int32
            }

            class Impl : IDep[A] {
                public prop Item A { get { return nil } }
            }

            var c Coupled3[A, Impl]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // REVIEW FINDING (#4068) control: the deeply nested bound SATISFIED.
        // Removing the cap must not turn a legal deep bound into a rejection.
        yield return new object[]
        {
            "review-a-deeply-nested-bound-that-holds",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            var d Deep[A, List[List[List[List[List[List[List[List[List[List[List[A]]]]]]]]]]]]
            Console.WriteLine("compiled")
            """,
            new[] { "compiled" },
        };

        // A generic METHOD carrying the same dependent bound: the imported
        // METHOD path has had its own constraint check since #750/ADR-0088, and
        // it must keep accepting the matched spelling.
        yield return new object[]
        {
            "a-generic-method-with-a-matched-dependent-bound",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            Console.WriteLine(Probe.Take[A, List[A]](List[A]()))
            """,
            new[] { "took" },
        };
    }

    /// <summary>
    /// A violated dependent bound reports <c>GS0152</c> at compile time —
    /// exactly once — instead of emitting an instantiation the CLR refuses.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(DependentViolations))]
    public void AViolatedDependentBoundOverErasedClasses_IsRefused(
        string name,
        string source,
        string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4041_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(
                tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal);

            // Issue #4032's CI follow-up, inherited: assert the COUNT, not the
            // presence. The binder probes the same receiver through several
            // entry points before committing to a reading of it, so a per-call
            // report turns one violation into a count that is a function of how
            // many internal paths the binder happened to take.
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
    /// Every satisfied shape compiles, IL-verifies, runs, and prints. These are
    /// the rows a false GS0152 would break.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(SatisfiedShapes))]
    public void ASatisfiedDependentBound_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4041_ok_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(
                tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

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
    /// bound failed, and the bound itself — so an author reading it can see
    /// that <c>U</c> is the problem and <c>IList</c> is the bound, rather than
    /// meeting a <c>TypeLoadException</c> at run time with no source location
    /// at all.
    /// </summary>
    [Fact]
    public void TheDiagnosticNamesTheArgumentTheParameterAndTheBound()
    {
        const string Source = """
            package P
            import System
            import System.Collections.Generic
            import HelperLib3

            class A {
                public var N int32
            }

            class Bee {
                public var M int32
            }

            var c Coupled[A, List[Bee]]
            Console.WriteLine("compiled")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4041_msg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(
                tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Contains("GS0152", appLog, StringComparison.Ordinal);
            Assert.Contains("'U'", appLog, StringComparison.Ordinal);
            Assert.Contains("List[Bee]", appLog, StringComparison.Ordinal);
            Assert.Contains("IList", appLog, StringComparison.Ordinal);
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
