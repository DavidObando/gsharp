// <copyright file="Issue4032ConstrainedImportedGenericBaseTests.cs" company="GSharp">
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
/// Issue #4032: a class deriving from a CONSTRAINED imported generic base.
/// </summary>
/// <remarks>
/// <para><b>The reported half did not reproduce, and that is measured.</b> The
/// issue reports <c>GS0149: Type 'Handler' is not generic</c> for
/// <c>class MyHandler : Handler[MyOptions]</c> when <c>Handler&lt;TOptions&gt;</c>
/// carries <c>where TOptions : SchemeOptions</c>. On <c>565b9a04</c> that
/// program compiles. It was re-measured across eleven shapes and four
/// reference kinds — the C# library's implementation assembly, its
/// <c>obj/…/ref/</c> reference assembly, the host shared runtime as the BCL,
/// and the <c>Microsoft.NETCore.App.Ref</c> targeting pack — and every
/// satisfying shape bound. Those shapes are the green rows below, so the
/// report is pinned rather than dismissed: if the GS0149 path exists on some
/// other input, these rows are what a fix would have to keep.</para>
/// <para><b>The unreported half is real, and it is the same area.</b>
/// <c>Type.MakeGenericType</c> validates constraints for a live runtime
/// definition and does NOT for one loaded by a
/// <c>MetadataLoadContext</c> — which is where every <c>/reference</c>
/// assembly lives. The generic METHOD path has compensated for exactly this
/// since #750/ADR-0088 (<c>SatisfiesGenericConstraints</c>, whose own comment
/// says "MetadataLoadContext's MakeGenericMethod does not validate
/// constraints"); the generic TYPE path never did. So a base clause that
/// VIOLATES the constraint compiled with no diagnostic at all:
/// <c>class Bad : Handler[string]</c> emitted an <c>extends</c> row the CLR
/// refuses and threw <c>TypeLoadException: GenericArguments[0],
/// 'System.String', on 'HelperLib2.Handler`1[TOptions]' violates the
/// constraint of type parameter 'TOptions'</c> the first time the program
/// touched the type — measured on <c>565b9a04</c>. That is the second half of
/// the issue's own Expected section ("reports <c>GS0152</c> naming the
/// constraint when it does not"), and it is what this change delivers.</para>
/// <para><b>Only CLOSED instantiations are asked.</b> A type argument that
/// still mentions a type parameter is erased to an <c>object</c> placeholder,
/// and asking a constraint of a placeholder is precisely how #4016/#4031's
/// projection broke constraint satisfaction for a SIBLING type parameter. An
/// open instantiation is skipped — it has no closed answer to give, and the
/// CLR only loads the type once it is closed. The same-compilation class case
/// is NOT skipped: the checker is handed the SYMBOLIC vector and walks a user
/// class's own base chain, so <c>class MyOptions : SchemeOptions</c> satisfies
/// <c>where TOptions : SchemeOptions</c> even though its CLR surrogate is
/// <c>object</c>. Both are green rows.</para>
/// <para><b>One neighbour is out of scope and filed separately.</b> A G#
/// generic class that derives from a constrained imported base WITHOUT
/// forwarding the bound to its own parameter —
/// <c>class MyGenericHandler[T] : Handler[T]</c> where <c>Handler</c> requires
/// <c>TOptions : SchemeOptions</c> — compiles, and its IL does not verify:
/// <c>[UnsatisfiedMethodParentInst] … Method parent instantiation has
/// unsatisfied class type parameter constraints</c>. C# requires the derived
/// declaration to repeat the constraint, and G# does not enforce that. It is
/// NOT a closed instantiation, so this change's check deliberately does not
/// see it, and inferring or demanding constraint forwarding is a language
/// rule rather than a missing check — C# spells it <c>CS0311</c>. Filed as
/// #4037. The FORWARDED spelling
/// (<c>class MyGenericHandler[T SchemeOptions] : Handler[T]</c>) verifies and
/// is the green row here.</para>
/// <para><b>Review of PR #4040 found the clause sites were not enough.</b>
/// Three EXPRESSION spellings close an imported generic without passing
/// through a type clause — a direct constructor call <c>Handler[string]()</c>,
/// a static member through a closed receiver
/// <c>Handler[string].Describe()</c>, and an object literal
/// <c>Handler[string]{…}</c> — and the first version of this change checked
/// only the clause sites, so all three still compiled and threw
/// <c>TypeLoadException</c>. Enumerating <c>MakeGenericType</c> across the
/// binder found FOUR user-facing construction sites beyond the three clause
/// sites; all now route through the same shared validation, and each has a
/// violating row and a satisfying control here.</para>
/// <para><b>One gap remains and is pinned, not hidden.</b> A DEPENDENT
/// constraint over two distinct same-compilation classes
/// (<c>Coupled[A, List[Bee]]</c> against
/// <c>Coupled&lt;T, U&gt; where U : IList&lt;T&gt;</c>) is still accepted,
/// because both classes erase to the same <c>object</c> placeholder. It is
/// pre-existing and unchanged here — this change only ADDS rejections — and it
/// has its own asserting row below. Filed as #4041.</para>
/// <para><b>#4031's reduction is constructible.</b> The ASP.NET
/// <c>AddScheme[TOptions, THandler]</c> shape — a two-parameter generic method
/// whose second constraint mentions the first
/// (<c>where THandler : AuthenticationHandler[TOptions]</c>), called with a
/// same-compilation options class and a same-compilation handler deriving from
/// the constrained imported base — compiles, IL-verifies and runs here. That
/// is the shape #4031 could pin only through the <c>cs2gs-code-exploder</c>
/// gate.</para>
/// </remarks>
public class Issue4032ConstrainedImportedGenericBaseTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every row links against. Mirrors the issue's own
    /// library, plus the ASP.NET <c>AuthenticationHandler</c>/<c>AddScheme</c>
    /// shape #4031 needed.
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

            public static string Describe() => "described";
        }

        public class Coupled<T, U>
            where U : System.Collections.Generic.IList<T>
        {
            public string Tag { get; set; } = "coupled";
        }

        public class HandlerNew<TOptions>
            where TOptions : SchemeOptions, new()
        {
            public string Tag { get; set; } = "n";
        }

        public interface IAuthenticationHandler
        {
            string Scheme { get; }
        }

        public abstract class AuthenticationHandler<TOptions> : IAuthenticationHandler
            where TOptions : SchemeOptions, new()
        {
            public string Scheme => "scheme";
        }

        public class AuthenticationBuilder
        {
            public string AddScheme<TOptions, THandler>(string name)
                where TOptions : SchemeOptions, new()
                where THandler : AuthenticationHandler<TOptions>
                => "added:" + name;
        }

        public class ClassConstrained<T>
            where T : class
        {
            public string Tag { get; set; } = "c";
        }

        public class StructConstrained<T>
            where T : struct
        {
            public string Tag { get; set; } = "v";
        }

        public class Unconstrained<T>
        {
            public string Tag { get; set; } = "u";
        }
        """;

    /// <summary>
    /// Every closed instantiation that VIOLATES a constraint the imported
    /// definition declares. Each of these compiled with NO diagnostic on the
    /// parent and threw <c>TypeLoadException</c> at run time.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> ConstraintViolations()
    {
        // An IMPORTED type argument that does not derive from the bound.
        yield return new object[]
        {
            "an-imported-type-argument-that-misses-the-base-constraint",
            """
            package P
            import System
            import HelperLib2

            class Bad : Handler[string] {
            }

            let b = Bad()
            Console.WriteLine(b.Tag)
            """,
            "GS0152",
        };

        // A SAME-COMPILATION class that does not derive from the bound. The
        // interesting one: its CLR surrogate is `object`, so the check has to
        // read the symbol's own base chain to answer at all.
        yield return new object[]
        {
            "a-same-compilation-class-that-misses-the-base-constraint",
            """
            package P
            import System
            import HelperLib2

            class NotOptions {
                public var N int32
            }

            class Bad2 : Handler[NotOptions] {
            }

            let b = Bad2()
            Console.WriteLine(b.Tag)
            """,
            "GS0152",
        };

        // A SPECIAL constraint, so the message comes from the attribute mask
        // rather than from a bound type.
        yield return new object[]
        {
            "a-reference-type-at-a-struct-constrained-base",
            """
            package P
            import System
            import HelperLib2

            class BadStruct : StructConstrained[string] {
            }

            let b = BadStruct()
            Console.WriteLine(b.Tag)
            """,
            "GS0152",
        };

        yield return new object[]
        {
            "a-value-type-at-a-class-constrained-base",
            """
            package P
            import System
            import HelperLib2

            class BadClass : ClassConstrained[int32] {
            }

            let b = BadClass()
            Console.WriteLine(b.Tag)
            """,
            "GS0152",
        };

        // REVIEW FINDING 1. Three EXPRESSION spellings close an imported
        // generic without ever reaching a type clause, and the first version of
        // this change checked only the clause sites. Each of these compiled,
        // emitted an instantiation the CLR refuses, and threw
        // `TypeLoadException` on that build.
        yield return new object[]
        {
            "review-a-direct-constructor-call-on-a-violating-instantiation",
            """
            package P
            import System
            import HelperLib2

            let h = Handler[string]()
            Console.WriteLine(h.Tag)
            """,
            "GS0152",
        };

        yield return new object[]
        {
            "review-a-static-member-through-a-violating-receiver",
            """
            package P
            import System
            import HelperLib2

            Console.WriteLine(Handler[string].Describe())
            """,
            "GS0152",
        };

        yield return new object[]
        {
            "review-an-object-literal-of-a-violating-instantiation",
            """
            package P
            import System
            import HelperLib2

            let h = Handler[string]{Tag: "z"}
            Console.WriteLine(h.Tag)
            """,
            "GS0152",
        };

        // Not only base clauses: any closed generic TYPE clause goes through
        // the same construction.
        yield return new object[]
        {
            "a-field-type-that-violates-the-constraint",
            """
            package P
            import System
            import HelperLib2

            class Holder {
                public var H Handler[int32]
            }

            Console.WriteLine("x")
            """,
            "GS0152",
        };
    }

    /// <summary>
    /// Every satisfying shape — including the issue's own repro, which is
    /// green before and after — plus the open instantiations the check must
    /// not touch.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> SatisfyingShapes()
    {
        // THE ISSUE'S OWN REPRO. Reported as GS0149; measured green.
        yield return new object[]
        {
            "the-issues-repro-a-same-compilation-class-at-a-constrained-imported-base",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            class MyHandler : Handler[MyOptions] {
            }

            let h = MyHandler()
            Console.WriteLine(h.Tag)
            """,
            new[] { "t" },
        };

        // The issue's `new()` control.
        yield return new object[]
        {
            "the-issues-new-control",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            class MyHandler : HandlerNew[MyOptions] {
            }

            let h = MyHandler()
            Console.WriteLine(h.Tag)
            """,
            new[] { "n" },
        };

        // The issue's no-constraint control.
        yield return new object[]
        {
            "control-the-unconstrained-base-still-binds",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            class MyPlain : Unconstrained[MyOptions] {
            }

            let h = MyPlain()
            Console.WriteLine(h.Tag)
            """,
            new[] { "u" },
        };

        // THE ASP.NET SHAPE, and #4031's reduction. `AddScheme[TOptions,
        // THandler]`'s second constraint MENTIONS the first, which is the
        // dependent-bound case #4016's projection broke.
        yield return new object[]
        {
            "the-aspnet-addscheme-shape-that-4031-could-only-pin-through-the-corpus",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            class MyHandler : AuthenticationHandler[MyOptions] {
            }

            let b = AuthenticationBuilder()
            Console.WriteLine(b.AddScheme[MyOptions, MyHandler]("bearer"))
            """,
            new[] { "added:bearer" },
        };

        // A satisfying IMPORTED type argument, so the green side is not only
        // the erased-symbol path.
        yield return new object[]
        {
            "an-imported-type-argument-that-satisfies-the-base-constraint",
            """
            package P
            import System
            import HelperLib2

            class Derived : Handler[SchemeOptions] {
            }

            let d = Derived()
            Console.WriteLine(d.Tag)
            """,
            new[] { "t" },
        };

        // Special constraints, satisfied.
        yield return new object[]
        {
            "satisfied-special-constraints",
            """
            package P
            import System
            import HelperLib2

            class OkClass : ClassConstrained[string] {
            }

            class OkStruct : StructConstrained[int32] {
            }

            Console.WriteLine(OkClass().Tag)
            Console.WriteLine(OkStruct().Tag)
            """,
            new[] { "c", "v" },
        };

        // REVIEW FINDING 1's green side: the same three expression spellings
        // over a SATISFYING argument must keep binding, running and printing.
        // The literal uses an IMPORTED type argument because the literal
        // spelling over a SAME-COMPILATION one does not bind at all — it takes
        // the `hasSymbolicArgument` branch and reports GS0157 "Cannot find type
        // Handler". That is pre-existing and untouched here (this change's
        // literal-site guard sits inside the `!hasSymbolicArgument` branch),
        // measured on the parent, and filed as #4042.
        yield return new object[]
        {
            "review-the-expression-spellings-still-bind-when-the-constraint-holds",
            """
            package P
            import System
            import HelperLib2

            class MyOptions : SchemeOptions {
            }

            let h = Handler[MyOptions]()
            Console.WriteLine(h.Tag)
            Console.WriteLine(Handler[MyOptions].Describe())
            let lit = Handler[SchemeOptions]{Tag: "z"}
            Console.WriteLine(lit.Tag)
            """,
            new[] { "t", "described", "z" },
        };

        // THE OPEN-INSTANTIATION SKIP. Every one of these erases its type
        // argument to `object`, which does NOT satisfy `: SchemeOptions`.
        // Asking the constraint here is the #4031 lesson; the check must not.
        yield return new object[]
        {
            "control-open-instantiations-are-not-constraint-checked",
            """
            package P
            import System
            import HelperLib2

            class Holder[T] {
                public var H Handler[T]
            }

            class MyGenericHandler[T SchemeOptions] : Handler[T] {
            }

            func openLocal[T]() int32 {
                var h Handler[T]
                if h == nil { return 1 }
                return 2
            }

            Console.WriteLine(openLocal[SchemeOptions]())
            """,
            new[] { "1" },
        };

        // A same-compilation class at an UNCONSTRAINED imported generic is the
        // commonest shape in the whole corpus. It must not have acquired a
        // constraint answer.
        yield return new object[]
        {
            "control-a-same-compilation-class-at-an-unconstrained-generic",
            """
            package P
            import System
            import System.Collections.Generic

            class Thing {
                public var N int32
            }

            let list = List[Thing]()
            let t = Thing()
            t.N = 4
            list.Add(t)
            Console.WriteLine(list.Count)

            let lookup = Dictionary[string, Thing]()
            lookup.Add("a", t)
            Console.WriteLine(lookup["a"].N)
            """,
            new[] { "1", "4" },
        };
    }

    /// <summary>
    /// NOT COVERED, and pinned so it is measured rather than merely described:
    /// a DEPENDENT constraint (<c>Coupled&lt;T, U&gt; where U : IList&lt;T&gt;</c>)
    /// over two DIFFERENT same-compilation classes is still accepted, because
    /// both erase to the same <c>object</c> placeholder and the constraint is
    /// asked on the erased vector — <c>IList&lt;object&gt;</c> is satisfied by
    /// <c>List&lt;object&gt;</c>, while the symbols say
    /// <c>IList&lt;A&gt;</c> is not satisfied by <c>List&lt;B&gt;</c>.
    /// </summary>
    /// <remarks>
    /// <para>Raised in review of PR #4040 and confirmed by measurement.
    /// <b>Pre-existing and unchanged by this PR</b>: this change only ADDS
    /// rejections, so a program it accepts was accepted on the parent too, and
    /// the parent witness records this row compiling and throwing there as
    /// well. Closing it needs symbol-aware substitution of the dependent bound
    /// rather than the erased <c>Type[]</c>, which is the same class of repair
    /// #4031 had to make for a sibling type parameter and is deliberately not
    /// attempted here. Filed as #4041.</para>
    /// <para>The row asserts the CURRENT behaviour — it compiles, and the
    /// <c>TypeLoadException</c> arrives at run time — so whoever fixes #4041
    /// gets a red row pointing at the exact program rather than silence. The
    /// matched spelling <c>Coupled[A, List[A]]</c> is green beside it, which is
    /// what any fix must not break.</para>
    /// </remarks>
    [Fact]
    public void ADependentConstraintOverTwoErasedClasses_IsStillAccepted_Issue4041()
    {
        const string Violating = """
            package P
            import System
            import System.Collections.Generic
            import HelperLib2

            class A {
                public var N int32
            }

            class Bee {
                public var M int32
            }

            var c Coupled[A, List[Bee]]
            Console.WriteLine("compiled")
            """;

        const string Matched = """
            package P
            import System
            import System.Collections.Generic
            import HelperLib2

            class A {
                public var N int32
            }

            var c Coupled[A, List[A]]
            Console.WriteLine("compiled")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4032_dep_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            // The gap: two distinct same-compilation classes collapse to one
            // placeholder, so the erased check cannot tell them apart.
            var violatingPath = Path.Combine(tempDir, "Violating.dll");
            var violatingLog = Compile(
                tempDir, "Violating.gs", Violating, violatingPath, "/target:exe", "/reference:" + libPath);
            Assert.DoesNotContain("GS9998", violatingLog, StringComparison.Ordinal);
            Assert.True(
                File.Exists(violatingPath),
                "#4041 is still open, so this must still compile. If it now reports GS0152, the gap is "
                    + $"closed — delete this row and add it to ConstraintViolations. Log:\n{violatingLog}");

            var (violatingExit, violatingOutput) = RunDotnet(violatingPath);
            Assert.True(
                violatingExit != 0 && violatingOutput.Contains("TypeLoadException", StringComparison.Ordinal),
                "the accepted instantiation must still be the one the CLR refuses; if it now loads, the "
                    + $"premise of #4041 changed. Exit {violatingExit}:\n{violatingOutput}");

            // The control any fix must not break: the MATCHED spelling is a
            // legitimate program and stays green.
            var matchedPath = Path.Combine(tempDir, "Matched.dll");
            var matchedLog = Compile(
                tempDir, "Matched.gs", Matched, matchedPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(matchedPath), $"the matched spelling must compile. Log:\n{matchedLog}");

            IlVerifier.Verify(matchedPath, new[] { libPath });

            var (matchedExit, matchedOutput) = RunDotnet(matchedPath);
            Assert.True(matchedExit == 0, $"the matched spelling must run. Exit {matchedExit}:\n{matchedOutput}");
            Assert.Equal("compiled", matchedOutput.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A closed generic type clause that violates a declared constraint now
    /// reports <c>GS0152</c> at compile time instead of throwing
    /// <c>TypeLoadException</c> at run time.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(ConstraintViolations))]
    public void AConstraintViolatingGenericTypeClause_IsRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4032_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The wrong message would be the issue's own complaint.
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Every satisfying shape compiles, IL-verifies, runs, and prints what it
    /// always printed.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(SatisfyingShapes))]
    public void ASatisfyingGenericTypeClause_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4032_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal);
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
    /// The <c>GS0152</c> text names the type argument, the type PARAMETER, and
    /// the constraint that failed — the three facts the issue's Expected
    /// section asks for and that <c>GS0149</c> gave none of.
    /// </summary>
    [Fact]
    public void TheDiagnosticNamesTheArgumentTheParameterAndTheConstraint()
    {
        const string Source = """
            package P
            import System
            import HelperLib2

            class Bad : Handler[string] {
            }

            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4032_msg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.Contains("GS0152", appLog, StringComparison.Ordinal);
            Assert.Contains("'string'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TOptions'", appLog, StringComparison.Ordinal);
            Assert.Contains("'HelperLib2.SchemeOptions'", appLog, StringComparison.Ordinal);
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
