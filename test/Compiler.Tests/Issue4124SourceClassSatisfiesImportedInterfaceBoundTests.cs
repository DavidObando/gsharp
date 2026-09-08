// <copyright file="Issue4124SourceClassSatisfiesImportedInterfaceBoundTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4124: a SAME-COMPILATION class that implements an IMPORTED interface
/// must satisfy a <c>[T IDisposable]</c> bound — at a generic function call and
/// at a generic type construction alike.
/// </summary>
/// <remarks>
/// <para><b>The repro, re-measured on <c>origin/main</c> @ <c>26df552b</c> with
/// a rebuilt <c>gsc</c> before anything was written.</b> For
/// <c>class D : IDisposable</c>, both <c>take[D]()</c> and <c>Box[D]()</c>
/// reported <c>GS0152: Type argument 'D' ... does not satisfy the
/// 'System.IDisposable' constraint.</c> — a FALSE REJECTION of ordinary,
/// idiomatic code, which is the worse direction of this rule's two failure
/// modes. <c>csc</c> accepts the C# equivalent and so does the CLR.</para>
/// <para><b>The mechanism.</b> <c>Binder.SatisfiesConstraint</c>'s
/// <c>ClrInterfaceConstraint</c> arm calls
/// <c>Binder.SatisfiesClrInterfaceConstraint</c>, which read
/// <c>typeArgument.ClrType.GetInterfaces()</c>. A same-compilation class has
/// no CLR type until emit, so that returned <see langword="false"/> at its
/// second guard — before looking at anything the symbol knows about itself.
/// The symbol does know: <c>StructSymbol.ImplementedClrInterfaces</c> holds
/// exactly <c>IDisposable</c> for <c>class D : IDisposable</c>.</para>
/// <para><b>The FOURTH appearance of one defect, and why this closes the
/// class rather than the instance.</b> The same blindness was repaired three
/// times before, each at whichever site happened to hit it: #4061 at the
/// imported class-chain walk, #4068 at <c>Binder.SatisfiesDependentBound</c>
/// (which is where <c>SourceSymbolImplementsImportedInterface</c> was
/// written), and #4092's review round at
/// <c>Binder.TypeParameterForwardsUserDeclaredConstraints</c> — that one by
/// CALLING #4068's walk rather than copying it. This change does not add a
/// fourth caller-side patch. It moves the fallback INTO
/// <c>SatisfiesClrInterfaceConstraint</c> itself, splitting the reflective
/// body out as <c>SatisfiesClrInterfaceConstraintReflectively</c> and wrapping
/// EVERY exit of it, then DELETES the two copies that were sitting at #4068's
/// and #4092's call sites. All three symbolic askers now bottom out in one
/// predicate, so a fifth site cannot appear: any future caller of the leaf
/// gets the symbolic answer for free.</para>
/// <para><b>Why it was not done in #4092.</b> <c>Binder.SatisfiesConstraint</c>
/// is the central constraint predicate — it also gates extension-method
/// candidate unification in <c>BoundScope.TryUnifyAndCheckConstraints</c>,
/// where widening acceptance can turn a previously-skipped candidate into an
/// ambiguity. That is a blast radius that wants its own sweep rather than a
/// ride on an unrelated PR. The widening is MONOTONE in the satisfaction
/// direction — it only turns a <see langword="false"/> into a
/// <see langword="true"/>, and only for an argument with NO CLR type, which is
/// exactly the case reflection cannot see — so nothing the reflective path
/// already answers changes.</para>
/// <para><b>The self-referential row was a bonus, and it was measured.</b>
/// <c>class Cmp : IComparable[Cmp]</c> against <c>[T IComparable[T]]</c> was
/// ALSO red on the parent, for the same reason. The reflective half already
/// substitutes the argument for the constrained parameter
/// (<c>GenericConstraintArgumentsMatch</c>); the symbolic half did not, so the
/// expected vector stayed <c>[T]</c> and never matched <c>[Cmp]</c>. Giving
/// the symbolic walk the same substitution is parity between the two halves of
/// one predicate, not a second feature.</para>
/// <para><b>The consolidation was load-bearing within days.</b> Issue #4136
/// was filed independently against this very site while #4089/#4090 were being
/// closed — a same-compilation class failing an imported interface constraint
/// at a CONSTRUCTOR — and its stated fix was "route the arm through
/// <c>BoundCarriesClrInterface</c>", which is the fifth copy. Because the
/// fallback moved INTO the leaf instead, #4136's repro is answered here with
/// no additional code: measured <c>2 × GS0152</c> on this branch's parent
/// <c>b4478875</c> and <c>de</c> on this branch. It is a row below. Its
/// sibling #4139 is NOT closed here and is NOT the same defect — that one is
/// <c>IsNonNullableValueTypeForConstraint</c> missing an <c>EnumSymbol</c> arm
/// for the <c>struct</c>/<c>unmanaged</c> constraints, a different predicate
/// that never consults the interface walk. Measured red on the parent AND on
/// this branch (<c>2 × GS0152</c> both), and left where it belongs.</para>
/// </remarks>
public class Issue4124SourceClassSatisfiesImportedInterfaceBoundTests
{
    private const int RunTimeout = 60_000;

    /// <summary>
    /// Every shape that must now bind, compile, IL-verify and run. Each of
    /// these reported <c>GS0152</c> on the parent unless marked as a control.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> NowBinding()
    {
        // THE ISSUE'S OWN REPRO, verbatim. Both spellings — a generic FUNCTION
        // call and a generic TYPE construction — route through
        // `Binder.SatisfiesConstraint`, so both reported GS0152.
        yield return new object[]
        {
            "the-issues-repro-a-source-class-implements-an-imported-interface",
            """
            package P
            import System

            class D : IDisposable {
                public func Dispose() {
                }
            }

            func take[T IDisposable]() string {
                return "took"
            }

            open class Box[TB IDisposable] {
                public var Tag string = "b"
            }

            Console.WriteLine(take[D]())
            Console.WriteLine(Box[D]().Tag)
            """,
            new[] { "took", "b" },
        };

        // Through the SOURCE base chain: `EnumerateDeclaredClrInterfaces`
        // walks `BaseClass` as well as the class's own list.
        yield return new object[]
        {
            "a-source-base-class-supplies-the-imported-interface",
            """
            package P
            import System

            open class Base : IDisposable {
                public func Dispose() {
                }
            }

            class Sub : Base {
            }

            func take[T IDisposable]() string {
                return "took-sub"
            }

            Console.WriteLine(take[Sub]())
            """,
            new[] { "took-sub" },
        };

        // Through a G#-DECLARED interface that itself extends the imported
        // one — the `EnumerateInterfaceClrBases` arm of the same walk.
        yield return new object[]
        {
            "a-gs-declared-interface-projects-onto-the-imported-one",
            """
            package P
            import System

            interface IGs : IDisposable {
            }

            class D2 : IGs {
                public func Dispose() {
                }
            }

            func take[T IDisposable]() string {
                return "took-iface"
            }

            Console.WriteLine(take[D2]())
            """,
            new[] { "took-iface" },
        };

        // A SELF-REFERENTIAL generic bound. `[T IComparable[T]]` names the
        // constrained parameter as its own argument, so the expected vector is
        // `[T]` and the symbolic walk had to learn the substitution the
        // reflective half already performs.
        yield return new object[]
        {
            "a-self-referential-generic-bound-over-a-source-class",
            """
            package P
            import System

            class Cmp : IComparable[Cmp] {
                public func CompareTo(other Cmp?) int32 {
                    return 0
                }
            }

            func take[T IComparable[T]]() string {
                return "took-cmp"
            }

            Console.WriteLine(take[Cmp]())
            """,
            new[] { "took-cmp" },
        };

        // Issue #4136, filed independently against the SAME site while #4089/
        // #4090 were being closed, and closed by this change without a second
        // repair — which is the point of consolidating at the leaf rather than
        // patching a fourth caller. Its repro verbatim: a source class that
        // implements the imported interface DIRECTLY, and one that inherits it
        // from an IMPORTED base (`ArrayList` carries `IEnumerable`). Measured
        // `2 x GS0152` on this branch's parent `b4478875` and `de` here.
        yield return new object[]
        {
            "issue-4136-a-direct-implementation-and-an-imported-base-at-a-constructor",
            """
            package P
            import System
            import System.Collections

            open class GsDisposable[TD IDisposable] {
                public var Tag string = "d"
            }

            open class GsEnumerable[TE IEnumerable] {
                public var Tag string = "e"
            }

            class DisposableSource : IDisposable {
                public func Dispose() {
                }
            }

            class EnumerableSource : ArrayList {
            }

            let a = GsDisposable[DisposableSource]()
            let b = GsEnumerable[EnumerableSource]()
            Console.WriteLine(a.Tag + b.Tag)
            """,
            new[] { "de" },
        };

        // A CONTROL, green before and after: an IMPORTED type argument has a
        // CLR type, so the reflective half answers it and the new fallback is
        // never consulted. This is the control #4136's "Expected" section
        // names.
        yield return new object[]
        {
            "an-imported-type-argument-is-still-answered-reflectively",
            """
            package P
            import System
            import System.IO

            func take[T IDisposable]() string {
                return "took-imported"
            }

            Console.WriteLine(take[MemoryStream]())
            """,
            new[] { "took-imported" },
        };
    }

    /// <summary>
    /// Shapes that must STILL be refused. The widening is monotone in the
    /// satisfaction direction only; a type that does not carry the interface
    /// never starts satisfying the bound.
    /// </summary>
    /// <returns>Case name and G# source.</returns>
    public static IEnumerable<object[]> StillRefused()
    {
        // The plain negative: a source class that implements nothing.
        yield return new object[]
        {
            "a-source-class-that-does-not-implement-the-interface",
            """
            package P
            import System

            class E {
            }

            func take[T IDisposable]() string {
                return "took"
            }

            Console.WriteLine(take[E]())
            """,
        };

        // A source class carrying the WRONG imported interface. The walk
        // reaches an interface list; it must still compare it.
        yield return new object[]
        {
            "a-source-class-that-implements-a-different-imported-interface",
            """
            package P
            import System

            class F : ICloneable {
                public func Clone() object {
                    return this
                }
            }

            func take[T IDisposable]() string {
                return "took"
            }

            Console.WriteLine(take[F]())
            """,
        };

        // A GENERIC bound is decided on the SYMBOLIC arguments, so the wrong
        // argument is still wrong even though both project to the identical
        // erased `IComparable<object>`.
        yield return new object[]
        {
            "a-generic-bound-with-the-wrong-symbolic-argument",
            """
            package P
            import System

            class Other {
            }

            class Cmp2 : IComparable[Cmp2] {
                public func CompareTo(other Cmp2?) int32 {
                    return 0
                }
            }

            func take[T IComparable[Other]]() string {
                return "took"
            }

            Console.WriteLine(take[Cmp2]())
            """,
        };
    }

    /// <summary>
    /// A same-compilation class that implements the imported interface now
    /// satisfies the bound, compiles, IL-verifies and runs.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(NowBinding))]
    public void ASourceClassSatisfiesAnImportedInterfaceBound(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4124_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, Array.Empty<string>());

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A type that does not carry the interface is still refused, with
    /// <c>GS0152</c> reported exactly once.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    [Theory]
    [MemberData(nameof(StillRefused))]
    public void ATypeThatDoesNotCarryTheInterfaceIsStillRefused(string name, string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4124_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // Assert the COUNT, not the presence: a per-call report would turn
            // one violation into a number that is a function of how many
            // internal paths the binder happened to take.
            var occurrences = appLog.Split("GS0152", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"'{name}' must report GS0152 exactly once, saw {occurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The blast-radius row named by the issue: <c>SatisfiesConstraint</c> also
    /// gates extension-method candidate unification in
    /// <c>BoundScope.TryUnifyAndCheckConstraints</c>, where widening acceptance
    /// can newly ADMIT a candidate. Measured rather than reasoned about — the
    /// constrained extension is now reached for a source class that implements
    /// the interface, and the unconstrained sibling still wins for one that
    /// does not.
    /// </summary>
    [Fact]
    public void AConstrainedExtensionIsReachedForASourceClass()
    {
        const string Source = """
            package P
            import System

            class D : IDisposable {
                public func Dispose() {
                }
            }

            class E {
            }

            func (value T) Describe[T IDisposable]() string {
                return "disposable"
            }

            func (value U) DescribeAny[U]() string {
                return "any"
            }

            Console.WriteLine(D().Describe())
            Console.WriteLine(D().DescribeAny())
            Console.WriteLine(E().DescribeAny())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4124_ext_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Ext.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"the extension shapes must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, Array.Empty<string>());

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the program must run. Exit {exit}:\n{output}");
            Assert.Equal(new[] { "disposable", "any", "any" }, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The other half of the blast-radius question, and the one monotonicity
    /// does NOT settle by itself: once a constrained candidate becomes
    /// applicable, which one WINS? Measured on the parent and here, and
    /// nothing moves.
    /// </summary>
    /// <remarks>
    /// <para><c>TryUnifyAndCheckConstraints</c> scores specificity from the
    /// <c>struct</c>/<c>class</c> flags only — an interface bound contributes
    /// 0 — so two same-name extensions that both survive would tie. Measured:
    /// the pair below reported <c>GS0266</c> (ambiguous) on the parent AND
    /// here, so no program that compiled before stops compiling; the
    /// widening changed which candidates are applicable, not the ranking. The
    /// free-function pair <c>f[T IDisposable](T)</c> / <c>f(object)</c> picks
    /// the generic one on the parent AND here.</para>
    /// <para>The DIFFERENT-name shape is the actual red row and lives in
    /// <see cref="AConstrainedExtensionIsReachedForASourceClass"/>: there the
    /// constrained candidate was skipped entirely on the parent, so the call
    /// reported <c>GS0159</c> and now binds.</para>
    /// </remarks>
    [Fact]
    public void NoOverloadWinnerMoves()
    {
        const string AmbiguousExtensions = """
            package P
            import System

            class D : IDisposable {
                public func Dispose() {
                }
            }

            func (value T) Describe[T IDisposable]() string {
                return "disposable"
            }

            func (value U) Describe[U]() string {
                return "any"
            }

            Console.WriteLine(D().Describe())
            """;

        const string FreeFunctions = """
            package P
            import System

            class D : IDisposable {
                public func Dispose() {
                }
            }

            func f[T IDisposable](x T) string {
                return "generic"
            }

            func f(x object) string {
                return "object"
            }

            Console.WriteLine(f(D()))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4124_rank_").FullName;
        try
        {
            // Ambiguous on the parent and ambiguous here — an interface bound
            // is worth 0 specificity, so the two same-name extensions tie
            // whether or not the constrained one is applicable.
            var ambiguousPath = Path.Combine(tempDir, "Ambiguous.dll");
            var ambiguousLog = Compile(
                tempDir, "Ambiguous.gs", AmbiguousExtensions, ambiguousPath, "/target:exe");
            Assert.DoesNotContain("GS9998", ambiguousLog, StringComparison.Ordinal);
            Assert.False(
                File.Exists(ambiguousPath),
                $"the same-name extension pair must stay ambiguous. Log:\n{ambiguousLog}");
            var occurrences = ambiguousLog.Split("GS0266", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"the ambiguity must be reported exactly once, saw {occurrences}. Log:\n{ambiguousLog}");

            // The constrained generic already won on the parent and still does.
            var freePath = Path.Combine(tempDir, "Free.dll");
            var freeLog = Compile(tempDir, "Free.gs", FreeFunctions, freePath, "/target:exe");
            Assert.True(File.Exists(freePath), $"the free-function pair must compile. Log:\n{freeLog}");

            IlVerifier.Verify(freePath, Array.Empty<string>());

            var (exit, output) = RunDotnet(freePath);
            Assert.True(exit == 0, $"the free-function pair must run. Exit {exit}:\n{output}");
            Assert.Equal("generic", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] SplitLines(string output)
        => output
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .ToArray();

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
