// <copyright file="Issue4042ImportedGenericLiteralOverSourceTypeTests.cs" company="GSharp">
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
/// Issue #4042: an object literal of an IMPORTED generic over a
/// SAME-COMPILATION type argument.
/// </summary>
/// <remarks>
/// <para><b>The defect.</b> <c>Handler[MyOptions]{Tag: "z"}</c> reported
/// <c>GS0157: Cannot find type Handler. Are you missing an import?</c> — not a
/// message about the literal, but the fall-through for a type that could not
/// be named at all — while the CONSTRUCTOR spelling
/// <c>Handler[MyOptions]()</c> of the very same instantiation compiled, IL-
/// verified and ran. Re-measured on the parent before anything was written.
/// </para>
/// <para><b>Why a same-compilation argument was not "CLR-faithful".</b> The
/// imported-generic literal branch was gated on
/// <c>!hasSymbolicArgument || HasOnlyClrFaithfulSymbolicArguments(...)</c>. A
/// same-compilation user class has NO reference-context CLR type while
/// binding — its TypeDef is only produced at emit — so
/// <c>TryResolveClrConstructionTypeArgs</c> closes it over the <c>object</c>
/// SURROGATE and <c>HasOnlyClrFaithfulSymbolicArguments</c> answers false by
/// its own definition (<c>argument.ClrType == null</c>). That predicate came
/// from #4024 and is CORRECT about what it says: the closed CLR type
/// <c>Handler&lt;object&gt;</c> does not describe the argument. It was being
/// used for the wrong thing — as a gate on ENTERING the branch, when the fact
/// it establishes only decides the RESULT TYPE. The fix moves it: the branch
/// is entered for every resolvable argument, and a non-faithful vector is
/// carried beside the erased shape as
/// <c>ImportedTypeSymbol.GetConstructed(...)</c>, which is exactly what the
/// CONSTRUCTOR path has done since #671 and is why that spelling worked.</para>
/// <para><b>Measured, not assumed: this is binder-only.</b> The discriminating
/// probe was the ADR-0117 object-initializer SUFFIX,
/// <c>Handler[MyOptions](){Tag = "z"}</c>, which produces the same bound nodes
/// (<c>BoundClrConstructorCallExpression</c> plus member assignments) over a
/// constructed-symbol receiver. On the parent it compiled, IL-verified and
/// printed <c>z</c> — so the emitter already reified <c>Handler&lt;MyOptions&gt;</c>
/// from that shape and nothing in emit needed changing. The parity row below
/// asserts the reified runtime type
/// (<c>HelperLib2.Handler`1[P.MyOptions]</c>, not <c>…[System.Object]</c>) for
/// both spellings.</para>
/// <para><b>The three LOSSY-BUT-REAL spellings are must-not-change rows.</b>
/// <c>Box[[]int32]{…}</c> (#4024), <c>Box[[3]int32]{…}</c> (#3962) and the
/// named-tuple spelling (ADR-0172) each retain a symbolic argument that DOES
/// have a faithful closed CLR type. They keep taking the plain path — the
/// predicate still decides which — and are pinned here as well as in
/// <c>Issue4024SliceTypeArgumentRetentionTests</c>.</para>
/// <para><b>Widening the branch does not widen what is ACCEPTED.</b> #4032's
/// constraint check sits at the top of the branch, so
/// <c>Handler[NotOptions]{…}</c> now reports <c>GS0152</c> where it used to
/// report GS0157, and #4037's forwarding rule reaches the literal too, so
/// <c>Handler[T]{…}</c> inside an unconstrained <c>func f[T]</c> reports
/// <c>GS0580</c>. Both are rows here.</para>
/// <para><b>Issue #4059 closed the shared follow-up.</b> A member whose type
/// is the erased type parameter now projects through the symbolic receiver on
/// both spellings, so <c>Handler[MyOptions]().Options.Name</c> and the literal
/// twin bind and execute against <c>MyOptions</c>, not <c>object</c>.</para>
/// </remarks>
public class Issue4042ImportedGenericLiteralOverSourceTypeTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every row links against. Mirrors the issue's own
    /// library, plus an UNCONSTRAINED generic and a member typed by the type
    /// parameter itself.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib2;

        public class SchemeOptions
        {
            public string? Name { get; set; }
        }

        public class Handler<TOptions>
            where TOptions : SchemeOptions
        {
            public string Tag { get; set; } = "t";

            public TOptions? Options { get; set; }
        }

        public class Box<T>
        {
            public string Tag { get; set; } = "b";

            public T? Value { get; set; }
        }
        """;

    /// <summary>
    /// Every literal spelling that must bind, verify and run.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> BindingLiterals()
    {
        // THE ISSUE'S OWN REPRO. GS0157 on the parent.
        yield return new object[]
        {
            "the-issues-repro-a-literal-over-a-same-compilation-type-argument",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            let lit = Handler[MyOptions]{Tag: "z"}
            Console.WriteLine(lit.Tag)
            """,
            new[] { "z" },
        };

        // PARITY WITH THE CONSTRUCTOR SPELLING, which is what the issue's
        // Expected asks for — and the reified runtime type is asserted, so
        // "it printed the right answer" is not the whole claim. `Handler<object>`
        // would print `HelperLib2.Handler`1[System.Object]`.
        yield return new object[]
        {
            "the-literal-and-the-constructor-spellings-reify-the-same-closed-type",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            let ctor = Handler[MyOptions]()
            ctor.Tag = "c"
            let lit = Handler[MyOptions]{Tag: "c"}
            Console.WriteLine(ctor.Tag)
            Console.WriteLine(lit.Tag)
            Console.WriteLine(ctor.GetType().ToString())
            Console.WriteLine(lit.GetType().ToString())
            """,
            new[]
            {
                "c",
                "c",
                "HelperLib2.Handler`1[P.MyOptions]",
                "HelperLib2.Handler`1[P.MyOptions]",
            },
        };

        // A TYPE PARAMETER as the argument. The constructor path admits one, so
        // the literal must too — and #4037's forwarding rule is what makes the
        // FORWARDED spelling the legal one.
        yield return new object[]
        {
            "a-literal-over-a-forwarded-type-parameter",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            func viaParam[T SchemeOptions]() string {
                let h = Handler[T]{Tag: "p"}
                return h.Tag
            }

            Console.WriteLine(viaParam[MyOptions]())
            """,
            new[] { "p" },
        };

        // A SAME-COMPILATION class at an UNCONSTRAINED imported generic — the
        // commonest shape, and the one that would have shown any regression in
        // ordinary code. GS0157 on the parent too.
        yield return new object[]
        {
            "a-literal-of-an-unconstrained-imported-generic-over-a-same-compilation-class",
            """
            package P
            import System
            import HelperLib2

            class Thing {
                public var N int32
            }

            let t = Thing()
            t.N = 4
            let b = Box[Thing]{Tag: "u", Value: t}
            Console.WriteLine(b.Tag)
            Console.WriteLine(b.GetType().ToString())
            """,
            new[] { "u", "HelperLib2.Box`1[P.Thing]" },
        };

        // MUST NOT CHANGE: the IMPORTED type argument, which bound before this
        // change and is the spelling Issue4032's green row uses.
        yield return new object[]
        {
            "control-a-literal-over-an-imported-type-argument-still-binds",
            """
            package P
            import System
            import HelperLib2

            let lit = Handler[SchemeOptions]{Tag: "z"}
            Console.WriteLine(lit.Tag)
            Console.WriteLine(lit.GetType().ToString())
            """,
            new[] { "z", "HelperLib2.Handler`1[HelperLib2.SchemeOptions]" },
        };

        // MUST NOT CHANGE: the three LOSSY-BUT-REAL spellings. Each retains a
        // symbolic argument that nonetheless has a faithful closed CLR type, so
        // each keeps taking the plain path. `[]T` is #4024's row, `[N]T` is
        // #3962's, the named tuple is ADR-0172's.
        yield return new object[]
        {
            "control-the-three-lossy-but-real-spellings-still-bind",
            """
            package P
            import System
            import HelperLib2

            let slice = Box[[]int32]{ Value: []int32{1, 2, 3} }
            Console.WriteLine(slice.Value.Length)

            let fixedLen = Box[[3]int32]{ Value: [3]int32{1, 2, 3} }
            Console.WriteLine(fixedLen.Value.Length)

            let named = Box[(a int32, b string)]{ Tag: "nt" }
            Console.WriteLine(named.Tag)
            """,
            new[] { "3", "3", "nt" },
        };
    }

    /// <summary>
    /// Widening the branch must not widen what is ACCEPTED: the checks that
    /// sit at the top of it now reach the literal spelling too.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> RefusedLiterals()
    {
        // #4032's constraint check. On the parent this reported GS0157
        // ("Cannot find type Handler") — the wrong message for the wrong
        // reason. Now it reports the violation.
        yield return new object[]
        {
            "a-literal-over-a-same-compilation-class-that-misses-the-bound",
            """
            package P
            import System
            import HelperLib2

            class NotOptions {
                public var N int32
            }

            let bad = Handler[NotOptions]{Tag: "z"}
            Console.WriteLine(bad.Tag)
            """,
            "GS0152",
        };

        // #4037's forwarding rule, reached through the literal.
        yield return new object[]
        {
            "a-literal-over-an-unforwarded-type-parameter",
            """
            package P
            import System
            import HelperLib2

            func viaOpen[T]() string {
                let h = Handler[T]{Tag: "p"}
                return h.Tag
            }

            Console.WriteLine(viaOpen[SchemeOptions]())
            """,
            "GS0580",
        };
    }

    /// <summary>
    /// A literal of an imported generic over a same-compilation type argument
    /// binds, IL-verifies, runs, and reifies the real closed type.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(BindingLiterals))]
    public void AnImportedGenericLiteral_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4042_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The parent's symptom, named explicitly: the fall-through that
            // could not name the type at all.
            Assert.DoesNotContain("GS0157", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal);
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
    /// The checks at the top of the widened branch still refuse what they
    /// refused, and say why.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(RefusedLiterals))]
    public void AnInvalidImportedGenericLiteral_IsRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4042_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The parent's wrong message must not be what a reader sees.
            Assert.DoesNotContain("GS0157", appLog, StringComparison.Ordinal);

            // Issue #4032's lesson: assert the COUNT, not the presence.
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
    /// Issue #4059: a member whose type is the erased type parameter must be
    /// projected through the symbolic receiver on both construction spellings.
    /// </summary>
    /// <remarks>Both spellings must bind, execute, and produce the same value.</remarks>
    [Fact]
    public void AMemberTypedByTheErasedParameter_ProjectsOnBothSpellings()
    {
        const string ViaLiteral = """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            let o = MyOptions()
            o.Name = "n1"
            let h = Handler[MyOptions]{Tag: "z", Options: o}
            Console.WriteLine(h.Options.Name)
            """;

        const string ViaConstructor = """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            let o = MyOptions()
            o.Name = "n1"
            let h = Handler[MyOptions]()
            h.Options = o
            Console.WriteLine(h.Options.Name)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4042_erasure_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var literalPath = Path.Combine(tempDir, "ViaLiteral.dll");
            var literalLog = Compile(
                tempDir, "ViaLiteral.gs", ViaLiteral, literalPath, "/target:exe", "/reference:" + libPath);

            var constructorPath = Path.Combine(tempDir, "ViaConstructor.dll");
            var constructorLog = Compile(
                tempDir, "ViaConstructor.gs", ViaConstructor, constructorPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("error GS", literalLog, StringComparison.Ordinal);
            Assert.DoesNotContain("error GS", constructorLog, StringComparison.Ordinal);
            Assert.True(File.Exists(literalPath), literalLog);
            Assert.True(File.Exists(constructorPath), constructorLog);

            var literalRun = RunDotnet(literalPath);
            var constructorRun = RunDotnet(constructorPath);
            Assert.Equal(0, literalRun.Exit);
            Assert.Equal(0, constructorRun.Exit);
            Assert.Equal("n1", literalRun.Output.Trim());
            Assert.Equal("n1", constructorRun.Output.Trim());
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
            "HelperLib2",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib2.dll");
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
