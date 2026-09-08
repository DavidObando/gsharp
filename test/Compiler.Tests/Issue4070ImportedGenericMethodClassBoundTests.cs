// <copyright file="Issue4070ImportedGenericMethodClassBoundTests.cs" company="GSharp">
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
/// Issue #4070: an imported generic METHOD constrained to an interface, called
/// with a type argument that is a type parameter whose bound is a CLASS
/// implementing that interface.
/// </summary>
/// <remarks>
/// <para><b>The defect.</b> <c>Probes.NeedsDisposable[T]()</c> inside
/// <c>func callIt[T DisposableBase]()</c> reported
/// <c>GS0159: Cannot find function NeedsDisposable.</c> — measured on
/// <c>origin/main</c> @ <c>7708be7d</c> before anything was written. <c>T</c>'s
/// own bound is <c>DisposableBase</c>, which implements
/// <c>System.IDisposable</c>, so <c>T</c> satisfies
/// <c>where T : IDisposable</c> in every instantiation; <c>csc</c> accepts the
/// C# equivalent. Because the candidate was FILTERED out of overload
/// resolution rather than diagnosed, the author saw a "cannot find function"
/// where the real answer was "the constraint is satisfied".</para>
/// <para><b>Root cause, and why one rule now serves both askers.</b> The
/// question "does this type parameter satisfy an interface constraint" is asked
/// in exactly TWO places, enumerated by #4070 and re-measured here:
/// <c>ClrOverloadResolution.TypeParameterSatisfiesClrBound</c> (generic TYPE
/// construction, #4037's <c>GS0580</c>) walked the parameter's
/// <c>ClassConstraint</c> chain; <c>SatisfiesDeclaredConstraints</c>' #2617 arm
/// (generic METHOD resolution, since #750/ADR-0088) did not, because the shared
/// leaf <c>ErasedSymbolSatisfiesInterfaceConstraint</c>'s type-parameter arm
/// reads only <c>ClrInterfaceConstraint</c>/<c>InterfaceConstraint</c>. The
/// repair EXTRACTS the type-path walk into
/// <c>TypeParameterSatisfiesClrInterfaceBound</c> and calls it from the method
/// path too. The leaf is left byte-identical — it has other callers for which
/// "only the declared interface bounds" is the right meaning.</para>
/// <para><b>The guard, which was paid for.</b> The new arm only runs when the
/// UNSUBSTITUTED constraint mentions no type parameter — the same skip the
/// generic-TYPE path applies (#4031/#4041). Without it, measured: a
/// same-compilation <c>class GsEq : IEquatable[GsEq]</c> made
/// <c>func callIt[T GsEq]()</c> bind <c>Probes.NeedsEquatable[T]()</c> over
/// <c>where T : IEquatable&lt;T&gt;</c>, which COMPILED and then threw
/// <c>System.Security.VerificationException: Method
/// HelperLib2.Probes.NeedsEquatable: type argument 'T' violates the constraint
/// of type parameter 'T'</c>. <c>IEquatable&lt;T&gt;</c> and the erased
/// <c>IEquatable&lt;GsEq&gt;</c> both project to
/// <c>IEquatable&lt;object&gt;</c>, so the walk "proved" an implication that
/// does not hold — and <c>csc</c> reports <c>CS0311</c> on the C# equivalent
/// (measured by compiling it), so the acceptance was wrong on both counts. The
/// guard is narrow: a constructed constraint whose arguments are all CONCRETE
/// (<c>where T : IEnumerable&lt;string&gt;</c> from <c>[T StringBag]</c>) still
/// forwards, and a self-referential bound carried by the parameter ITSELF
/// (<c>[T IEquatable[T]]</c>) is answered by the pre-existing arm that runs
/// first. All three are rows.</para>
/// <para><b>Blast radius, which is the main event.</b>
/// <c>SatisfiesDeclaredConstraints</c> has two direct callers —
/// <c>SatisfiesGenericTypeConstraints</c> (1 call site,
/// <c>Binder.ReportUnsatisfiedGenericTypeConstraint</c>) and
/// <c>SatisfiesGenericConstraints</c> (7 call sites in
/// <c>ClrOverloadResolution</c>: the method-group probe, the closed-method
/// resolver, two inference paths, the explicit-type-argument path, and the two
/// user-value-type surrogate paths) — so EVERY imported generic method call in
/// the corpus flows through it. The new arm is MONOTONE: it can only turn a
/// <c>false</c> into a <c>true</c>, never the reverse, so no program the CLR
/// refuses becomes acceptable. What monotonicity does not by itself settle is
/// which candidate WINS once a constrained one becomes applicable, so that was
/// MEASURED on both sides rather than reasoned about: no winner moves. The
/// explicit spelling reported <c>GS0159</c> on the parent (an explicit type
/// argument removes a non-generic sibling from the candidate set entirely, so
/// there was nothing to flip) and now binds; the INFERRED spelling picks the
/// boxing <c>Take(object)</c> both before and after, which diverges from
/// <c>csc</c> and is filed as #4086. The <c>.gs</c> corpus was swept before and
/// after with a rebuilt compiler — 197 files, 170 of which emit an assembly
/// under the sweep's reference set — and the two per-file manifests (emit
/// status plus the multiset of diagnostic ids) are IDENTICAL. The four test
/// assemblies were run and the <c>cs2gs</c> code-exploder gate was run.</para>
/// <para><b>Note 3's shape, kept as an explicit green row.</b>
/// <c>Task.ContinueWith[TResult](Func[Task, TResult])</c> — one concrete nested
/// position beside one open one — has been broken twice by rewrites of this
/// erasure gate. It is a green row here so any future edit to this checker
/// trips over it in this file too.</para>
/// <para><b>Three gaps left open, filed rather than fixed, and pinned as
/// asserting rows so a later fix sees the exact programs.</b> (1) A
/// BASE-CLASS constraint at a generic method — <c>Probes.NeedsScheme[T]()</c>
/// under <c>where T : SchemeOptions</c> from inside
/// <c>func callIt[T SchemeOptions]()</c> — is refused for the same reason one
/// bound-kind over, but it lives on the loop's non-interface FALLTHROUGH, the
/// path every base-class and special constraint of every imported generic
/// method takes, so widening it is a strictly larger blast radius than the
/// interface branch this change touches. Filed as #4083. (2) A DEPENDENT bound
/// (<c>[TBase DisposableBase, TDerived TBase]</c>) forwards the interface just
/// as well, and <c>csc</c> accepts it — but NEITHER walk reads
/// <c>TypeParameterSymbol.TypeParameterBound</c>, so the generic-TYPE path
/// refuses it too (measured: <c>GS0580</c>), and closing it is new behaviour on
/// both paths at once. Filed as #4084. (3) An INFERRED call picks the boxing
/// <c>Take(object)</c> where <c>csc</c> picks the constrained
/// <c>Take&lt;T&gt;(T)</c> — measured identical before and after this change,
/// so it is surfaced by the blast-radius measurement rather than caused by it.
/// Filed as #4086.</para>
/// </remarks>
public class Issue4070ImportedGenericMethodClassBoundTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every row links against. The issue's own library, plus
    /// the shapes needed to exercise each arm of the walk and each rejection
    /// that must stay a rejection.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib2;

        public class SchemeOptions
        {
        }

        public class DisposableBase : System.IDisposable
        {
            public void Dispose()
            {
            }
        }

        public class DerivedDisposable : DisposableBase
        {
        }

        public interface IMarker
        {
        }

        public class MarkerBase : IMarker
        {
        }

        public class DisposableConstrained<T>
            where T : System.IDisposable
        {
            public string Tag { get; set; } = "i";
        }

        // A SELF-REFERENTIAL interface bound. `IEquatable<T>` mentions the
        // definition's own parameter, so it cannot be answered on the erased
        // vector — both `IEquatable<T>` and a same-compilation
        // `IEquatable<GsEq>` project to `IEquatable<object>`.
        public class MyEq : System.IEquatable<MyEq>
        {
            public bool Equals(MyEq? other) => true;
        }

        public class MyCmp : System.IComparable<MyCmp>
        {
            public int CompareTo(MyCmp? other) => 0;
        }

        // A CONSTRUCTED bound whose arguments are all CONCRETE. The erasure
        // loses nothing here, so this one must still forward.
        public class StringBag : System.Collections.Generic.List<string>
        {
        }

        public static class Probes
        {
            public static string NeedsEquatable<T>()
                where T : System.IEquatable<T>
                => "eq-ok";

            public static string NeedsComparable<T>()
                where T : System.IComparable<T>
                => "cmp-ok";

            public static string NeedsStringSeq<T>()
                where T : System.Collections.Generic.IEnumerable<string>
                => "seq-ok";

            public static string NeedsDisposable<T>()
                where T : System.IDisposable
                => "method-ok";

            public static string NeedsMarker<T>()
                where T : IMarker
                => "marker-ok";

            public static string NeedsScheme<T>()
                where T : SchemeOptions
                => "scheme-ok";

            public static string Unconstrained<T>()
                => "unconstrained-ok";
        }

        public static class Overloads
        {
            public static string Take<T>(T value)
                where T : System.IDisposable
                => "generic-disposable";

            public static string Take(object value)
                => "object";
        }
        """;

    /// <summary>
    /// Every shape that must now bind, compile, IL-verify and run. Each of
    /// these reported <c>GS0159</c> on the parent unless marked as a control.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> NowBinding()
    {
        // THE ISSUE'S OWN REPRO, verbatim. GS0159 on the parent.
        yield return new object[]
        {
            "the-issues-repro-a-class-bound-forwards-an-imported-interface",
            """
            package P
            import System
            import HelperLib2

            func callIt[T DisposableBase]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[DisposableBase]())
            """,
            new[] { "method-ok" },
        };

        // The interface INHERITED from the bound's own base one level up. This
        // arm lands on `IsAssignableByName` over the bound's CLR type rather
        // than on the parameter's own interface list.
        yield return new object[]
        {
            "an-interface-inherited-from-the-bounds-base",
            """
            package P
            import System
            import HelperLib2

            func callIt[T DerivedDisposable]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[DerivedDisposable]())
            """,
            new[] { "method-ok" },
        };

        // A SAME-COMPILATION class bound. The bound has no CLR type during
        // binding, so the walk must fall through to
        // `ErasedSymbolSatisfiesInterfaceConstraint`'s StructSymbol arm and
        // read the symbol's own base chain.
        yield return new object[]
        {
            "a-same-compilation-class-bound-forwards-through-its-imported-base",
            """
            package P
            import System
            import HelperLib2

            class MyDisp : DisposableBase {
            }

            func callIt[T MyDisp]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[MyDisp]())
            """,
            new[] { "method-ok" },
        };

        // A SAME-COMPILATION class implementing the imported interface
        // DIRECTLY — the `ImplementedClrInterfaces` loop rather than the
        // `ImportedBaseType` fallback.
        yield return new object[]
        {
            "a-same-compilation-class-bound-implementing-the-interface-directly",
            """
            package P
            import System
            import HelperLib2

            class MyMarker : IMarker {
            }

            func callIt[T MyMarker]() string {
                return Probes.NeedsMarker[T]()
            }

            Console.WriteLine(callIt[MyMarker]())
            """,
            new[] { "marker-ok" },
        };

        // A SECOND interface, so the rule is not `IDisposable`-shaped. An
        // imported user-defined interface rather than a BCL one.
        yield return new object[]
        {
            "a-second-imported-interface-through-an-imported-class-bound",
            """
            package P
            import System
            import HelperLib2

            func callIt[T MarkerBase]() string {
                return Probes.NeedsMarker[T]()
            }

            Console.WriteLine(callIt[MarkerBase]())
            """,
            new[] { "marker-ok" },
        };

        // Two DIFFERENT imported interfaces forwarded by two different class
        // bounds in one program, so the rule is not a single-shape accident
        // and one call site does not prime a cache the other reads.
        yield return new object[]
        {
            "two-interfaces-forwarded-by-two-class-bounds-in-one-program",
            """
            package P
            import System
            import HelperLib2

            func viaDisposable[T DisposableBase]() string {
                return Probes.NeedsDisposable[T]()
            }

            func viaMarker[T MarkerBase]() string {
                return Probes.NeedsMarker[T]()
            }

            Console.WriteLine(viaDisposable[DisposableBase]())
            Console.WriteLine(viaMarker[MarkerBase]())
            """,
            new[] { "method-ok", "marker-ok" },
        };

        // THE OVERLOAD row. Monotonicity guarantees no program the CLR refuses
        // is newly accepted, but it does not by itself say which candidate
        // WINS once a constrained one becomes applicable, so that was measured
        // rather than reasoned about — see
        // TheConstrainedOverloadIsReachedAndTheInferredSpellingIsUnmoved for
        // the full before/after table. On the parent this EXPLICIT spelling
        // reported `GS0159: Cannot find function Take.` — an explicit type
        // argument removes the non-generic `Take(object)` from the candidate
        // set entirely, so there was no winner to flip — and it now picks
        // `Take[T](T)`, which is what `csc` picks for the same source
        // (measured by running it).
        yield return new object[]
        {
            "a-newly-reachable-constrained-overload-binds-as-csc-picks-it",
            """
            package P
            import System
            import HelperLib2

            func callIt[T DisposableBase](value T) string {
                return Overloads.Take[T](value)
            }

            Console.WriteLine(callIt[DisposableBase](DisposableBase()))
            """,
            new[] { "generic-disposable" },
        };

        // CONTROL — the #2617 shape this arm was built for: a
        // same-compilation CLASS (not a type parameter) as the type argument
        // of an interface-constrained imported generic method. Unchanged by
        // this edit; pinned so a regression in the arm's original job is
        // caught here.
        yield return new object[]
        {
            "control-the-2617-shape-a-same-compilation-class-argument",
            """
            package P
            import System
            import HelperLib2

            class MyMarker2 : IMarker {
            }

            Console.WriteLine(Probes.NeedsMarker[MyMarker2]())
            """,
            new[] { "marker-ok" },
        };

        // A CONSTRUCTED interface bound whose arguments are all CONCRETE. The
        // new arm is guarded on the UNSUBSTITUTED constraint mentioning no type
        // parameter, and this one does not, so it still forwards:
        // `[T StringBag]` over `StringBag : List<string>` proves
        // `where T : IEnumerable<string>`. The guard is narrow, and this row is
        // what says so.
        yield return new object[]
        {
            "a-constructed-interface-bound-over-concrete-arguments-still-forwards",
            """
            package P
            import System
            import HelperLib2

            func callIt[T StringBag]() string {
                return Probes.NeedsStringSeq[T]()
            }

            Console.WriteLine(callIt[StringBag]())
            """,
            new[] { "seq-ok" },
        };

        // CONTROL — a SELF-REFERENTIAL bound carried by the type parameter
        // ITSELF (`[T IEquatable[T]]`) is answered by the pre-existing arm,
        // which runs BEFORE the new one, so the guard cannot reach it. This is
        // the legitimate spelling of the shape the rejection rows refuse, and
        // it must stay green.
        yield return new object[]
        {
            "control-a-self-referential-bound-on-the-parameter-itself-still-forwards",
            """
            package P
            import System
            import HelperLib2

            func callIt[T IEquatable[T]]() string {
                return Probes.NeedsEquatable[T]()
            }

            Console.WriteLine(callIt[MyEq]())
            """,
            new[] { "eq-ok" },
        };

        // CONTROL — an UNCONSTRAINED imported generic method called with a
        // type parameter. The commonest shape in the corpus; it must not have
        // acquired an answer it did not have.
        yield return new object[]
        {
            "control-an-unconstrained-imported-generic-method",
            """
            package P
            import System
            import HelperLib2

            func callIt[T]() string {
                return Probes.Unconstrained[T]()
            }

            Console.WriteLine(callIt[string]())
            """,
            new[] { "unconstrained-ok" },
        };

        // CONTROL — note 3's shape. `Task.ContinueWith[TResult](Func[Task,
        // TResult])` has one concrete nested position beside one open one, and
        // a per-position rewrite of this erasure gate has broken it TWICE.
        // Green here so any future edit to this checker trips over it in this
        // file too.
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

        // CONTROL — a generic method whose constraint is satisfied through the
        // type parameter's own INTERFACE bound, which is the path that already
        // worked. It must keep working: the new arm runs only after the
        // existing one has declined.
        yield return new object[]
        {
            "control-an-interface-bound-still-forwards-directly",
            """
            package P
            import System
            import HelperLib2

            func callIt[T IMarker]() string {
                return Probes.NeedsMarker[T]()
            }

            Console.WriteLine(callIt[MarkerBase]())
            """,
            new[] { "marker-ok" },
        };
    }

    /// <summary>
    /// Every shape the checker must keep refusing. A class bound proves only
    /// the interfaces that class actually implements, so an unrelated bound
    /// (or none) is still not a forwarding.
    /// </summary>
    /// <returns>Case name, G# source.</returns>
    public static IEnumerable<object[]> StillRefused()
    {
        // No bound at all. `T` can be `int32`, which is not `IDisposable`.
        yield return new object[]
        {
            "an-unconstrained-type-parameter-forwards-nothing",
            """
            package P
            import System
            import HelperLib2

            func callIt[T]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[DisposableBase]())
            """,
        };

        // A class bound that implements a DIFFERENT interface.
        yield return new object[]
        {
            "a-class-bound-implementing-a-different-interface",
            """
            package P
            import System
            import HelperLib2

            func callIt[T MarkerBase]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[MarkerBase]())
            """,
        };

        // A class bound implementing NO interface at all.
        yield return new object[]
        {
            "a-class-bound-implementing-no-interface",
            """
            package P
            import System
            import HelperLib2

            func callIt[T SchemeOptions]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[SchemeOptions]())
            """,
        };

        // A SAME-COMPILATION class bound implementing nothing. The symbolic
        // arm of the walk must decline as firmly as the reflective one.
        yield return new object[]
        {
            "a-same-compilation-class-bound-implementing-nothing",
            """
            package P
            import System
            import HelperLib2

            class Plain {
            }

            func callIt[T Plain]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[Plain]())
            """,
        };

        // A SELF-REFERENTIAL interface bound reached through an IMPORTED class
        // bound. `[T MyEq]` proves `IEquatable[MyEq]`, NOT `IEquatable[T]` for
        // every subtype of `MyEq` — `IEquatable<T>` is invariant. `csc` reports
        // `CS0311` on the C# equivalent (measured by compiling it), so this
        // must stay refused.
        yield return new object[]
        {
            "a-self-referential-interface-bound-through-an-imported-class-bound",
            """
            package P
            import System
            import HelperLib2

            func callIt[T MyEq]() string {
                return Probes.NeedsEquatable[T]()
            }

            Console.WriteLine(callIt[MyEq]())
            """,
        };

        // THE ROW THAT PAID FOR THE GUARD. The same question over a
        // SAME-COMPILATION class bound, where the erasure genuinely collapses:
        // `GsEq`'s own `IEquatable[GsEq]` and the definition's `IEquatable<T>`
        // both project to `IEquatable<object>`, so an unguarded walk "proves"
        // an implication that does not hold. Measured on the first version of
        // this change: it COMPILED and then threw at run time —
        // `System.Security.VerificationException: Method
        // HelperLib2.Probes.NeedsEquatable: type argument 'T' violates the
        // constraint of type parameter 'T'`. That is precisely #4031/#4041's
        // dependent-bound shape, which the generic-TYPE path already skips; the
        // new arm now skips it too.
        yield return new object[]
        {
            "a-self-referential-interface-bound-through-a-same-compilation-class-bound",
            """
            package P
            import System
            import HelperLib2

            class GsEq : IEquatable[GsEq] {
                public func Equals(other GsEq) bool {
                    return true
                }
            }

            func callIt[T GsEq]() string {
                return Probes.NeedsEquatable[T]()
            }

            Console.WriteLine(callIt[GsEq]())
            """,
        };

        // The same skip one interface over, so it is not `IEquatable`-shaped.
        yield return new object[]
        {
            "a-self-referential-comparable-bound-through-an-imported-class-bound",
            """
            package P
            import System
            import HelperLib2

            func callIt[T MyCmp]() string {
                return Probes.NeedsComparable[T]()
            }

            Console.WriteLine(callIt[MyCmp]())
            """,
        };

        // An INTERFACE bound that is not the one the definition asks for.
        yield return new object[]
        {
            "an-interface-bound-that-is-the-wrong-interface",
            """
            package P
            import System
            import HelperLib2

            func callIt[T IMarker]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[MarkerBase]())
            """,
        };
    }

    /// <summary>
    /// A type parameter whose CLASS bound implements the imported interface now
    /// binds at an imported generic METHOD, compiles, IL-verifies and runs —
    /// matching the generic-TYPE path and <c>csc</c>.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(NowBinding))]
    public void AClassBoundForwardsAnImportedInterfaceAtAGenericMethod(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4070_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

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
    /// A bound that does not prove the interface is still refused — the fix is
    /// monotone in the satisfaction direction only, and never starts accepting
    /// what the CLR would refuse.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    [Theory]
    [MemberData(nameof(StillRefused))]
    public void ABoundThatDoesNotProveTheInterface_IsStillRefused(string name, string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4070_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // Assert the COUNT, not the presence: the generic-receiver
            // resolvers are backtracking probes, so a per-call report turns one
            // violation into several identical errors and the count becomes a
            // function of how many internal paths the binder took.
            var occurrences = appLog.Split("GS0159", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"'{name}' must report GS0159 exactly once, saw {occurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// NOT COVERED, and pinned so it is measured rather than merely described
    /// (issue #4084): a DEPENDENT bound
    /// (<c>[TBase DisposableBase, TDerived TBase]</c>) forwards the interface
    /// just as a direct class bound does, and <c>csc</c> accepts the C#
    /// equivalent — but NEITHER of the two walks reads
    /// <c>TypeParameterSymbol.TypeParameterBound</c>, so the generic-TYPE path
    /// refuses it too.
    /// </summary>
    /// <remarks>
    /// <para>Closing it means teaching both walks a new slot, which is new
    /// behaviour on the checker every imported generic method call flows
    /// through and is beyond what #4070 filed. The row asserts the CURRENT
    /// behaviour on BOTH paths — <c>GS0159</c> at the method and #4037's
    /// <c>GS0580</c> at the type, each exactly once, measured rather than
    /// inferred from the source — so whoever fixes it gets a red row pointing
    /// at the exact programs rather than silence, and the DIRECT-bound
    /// spelling is green beside it as the thing any fix must not break.</para>
    /// </remarks>
    [Fact]
    public void ADependentBoundStillDoesNotForwardTheInterface()
    {
        const string Dependent = """
            package P
            import System
            import HelperLib2

            func callIt[TBase DisposableBase, TDerived TBase]() string {
                return Probes.NeedsDisposable[TDerived]()
            }

            Console.WriteLine(callIt[DisposableBase, DisposableBase]())
            """;

        const string DependentAtAType = """
            package P
            import System
            import HelperLib2

            class Forwarded[TBase DisposableBase, TDerived TBase] : DisposableConstrained[TDerived] {
            }

            Console.WriteLine("x")
            """;

        const string Direct = """
            package P
            import System
            import HelperLib2

            func callIt[TBase DisposableBase]() string {
                return Probes.NeedsDisposable[TBase]()
            }

            Console.WriteLine(callIt[DisposableBase]())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4070_dep_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var dependentPath = Path.Combine(tempDir, "Dependent.dll");
            var dependentLog = Compile(
                tempDir, "Dependent.gs", Dependent, dependentPath, "/target:exe", "/reference:" + libPath);
            Assert.DoesNotContain("GS9998", dependentLog, StringComparison.Ordinal);
            Assert.False(
                File.Exists(dependentPath),
                "the dependent-bound gap is still open, so this must still be refused. If it now compiles, "
                    + $"the gap is closed — move this into NowBinding. Log:\n{dependentLog}");

            var occurrences = dependentLog.Split("GS0159", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"the dependent-bound shape must report GS0159 exactly once, saw {occurrences}. "
                    + $"Log:\n{dependentLog}");

            // The GENERIC-TYPE path has the same blind spot — measured here
            // rather than inferred from the source, because #4084's body
            // claims it. #4037's rule DOES fire, so this one is diagnosed
            // rather than filtered: GS0580, not GS0159.
            var typePath = Path.Combine(tempDir, "DependentAtAType.dll");
            var typeLog = Compile(
                tempDir, "DependentAtAType.gs", DependentAtAType, typePath, "/target:exe", "/reference:" + libPath);
            Assert.DoesNotContain("GS9998", typeLog, StringComparison.Ordinal);
            Assert.False(
                File.Exists(typePath),
                $"the dependent bound at a generic TYPE must still be refused. Log:\n{typeLog}");

            var typeOccurrences = typeLog.Split("GS0580", StringSplitOptions.None).Length - 1;
            Assert.True(
                typeOccurrences == 1,
                $"the dependent bound at a generic TYPE must report GS0580 exactly once, saw "
                    + $"{typeOccurrences}. Log:\n{typeLog}");

            // The DIRECT spelling of the same question is what this change
            // fixed, and it is what any later fix must not break.
            var directPath = Path.Combine(tempDir, "Direct.dll");
            var directLog = Compile(
                tempDir, "Direct.gs", Direct, directPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(directPath), $"the direct spelling must compile. Log:\n{directLog}");

            IlVerifier.Verify(directPath, new[] { libPath });

            var (exit, output) = RunDotnet(directPath);
            Assert.True(exit == 0, $"the direct spelling must run. Exit {exit}:\n{output}");
            Assert.Equal("method-ok", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The overload question, measured rather than reasoned about: the
    /// EXPLICIT spelling is newly reachable and picks the constrained generic
    /// candidate (which is what <c>csc</c> picks), while the INFERRED spelling
    /// picks the boxing <c>Take(object)</c> — before AND after, so this change
    /// moves no winner.
    /// </summary>
    /// <remarks>
    /// <para>Monotonicity says no program the CLR refuses is newly accepted; it
    /// does not by itself say which candidate wins once a constrained one
    /// becomes applicable, and that is the one risk a monotone widening of an
    /// overload-resolution filter genuinely carries. Measured on the parent
    /// with a rebuilt compiler:</para>
    /// <list type="table">
    /// <item><description><c>Take[T](v)</c> explicit — <c>csc</c>
    /// <c>generic-disposable</c>; parent <c>GS0159</c>; here
    /// <c>generic-disposable</c>. An explicit type argument removes the
    /// non-generic <c>Take(object)</c> from the candidate set entirely, so
    /// there was no winner to flip — this is the same "cannot find function"
    /// repair as every other row.</description></item>
    /// <item><description><c>Take(v)</c> inferred — <c>csc</c>
    /// <c>generic-disposable</c>; parent <c>object</c>; here <c>object</c>.
    /// Unmoved by this change, and a pre-existing divergence from <c>csc</c>
    /// filed as #4086.</description></item>
    /// </list>
    /// <para>The inferred row asserts the CURRENT (wrong) answer so whoever
    /// fixes #4086 gets a failing row rather than silence.</para>
    /// </remarks>
    [Fact]
    public void TheConstrainedOverloadIsReachedAndTheInferredSpellingIsUnmoved()
    {
        const string Explicit = """
            package P
            import System
            import HelperLib2

            func callIt[T DisposableBase](value T) string {
                return Overloads.Take[T](value)
            }

            Console.WriteLine(callIt[DisposableBase](DisposableBase()))
            """;

        const string Inferred = """
            package P
            import System
            import HelperLib2

            func callIt[T DisposableBase](value T) string {
                return Overloads.Take(value)
            }

            Console.WriteLine(callIt[DisposableBase](DisposableBase()))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4070_ovl_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var explicitPath = Path.Combine(tempDir, "Explicit.dll");
            var explicitLog = Compile(
                tempDir, "Explicit.gs", Explicit, explicitPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(explicitPath), $"the explicit spelling must compile. Log:\n{explicitLog}");
            IlVerifier.Verify(explicitPath, new[] { libPath });
            var (explicitExit, explicitOutput) = RunDotnet(explicitPath);
            Assert.True(explicitExit == 0, $"the explicit spelling must run. Exit {explicitExit}:\n{explicitOutput}");
            Assert.Equal("generic-disposable", explicitOutput.Trim());

            var inferredPath = Path.Combine(tempDir, "Inferred.dll");
            var inferredLog = Compile(
                tempDir, "Inferred.gs", Inferred, inferredPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(inferredPath), $"the inferred spelling must compile. Log:\n{inferredLog}");
            IlVerifier.Verify(inferredPath, new[] { libPath });
            var (inferredExit, inferredOutput) = RunDotnet(inferredPath);
            Assert.True(inferredExit == 0, $"the inferred spelling must run. Exit {inferredExit}:\n{inferredOutput}");
            Assert.Equal(
                "object",
                inferredOutput.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// NOT COVERED, and pinned so it is measured rather than merely described
    /// (issue #4083): a BASE-CLASS constraint at an imported generic method
    /// (<c>where T : SchemeOptions</c>) is not forwarded by a type parameter
    /// carrying that very bound, in either the imported or the
    /// same-compilation spelling. <c>csc</c> accepts both.
    /// </summary>
    /// <remarks>
    /// <para>The same failure mode one bound-kind over — the candidate is
    /// FILTERED, so the author sees <c>GS0159</c> — but a different arm of the
    /// loop: the non-interface FALLTHROUGH, which every base-class and special
    /// constraint of every imported generic method takes, rather than the
    /// <c>constraint.IsInterface</c> branch this change touches. Widening it is
    /// a strictly larger blast radius and wants its own corpus sweep, so it is
    /// filed rather than ridden along.</para>
    /// <para>The row asserts the CURRENT behaviour and keeps the INTERFACE
    /// spelling green beside it, so a later fix sees exactly which programs
    /// change and which must not.</para>
    /// </remarks>
    [Fact]
    public void AClassBoundDoesNotYetForwardABaseClassConstraint()
    {
        const string ImportedBound = """
            package P
            import System
            import HelperLib2

            func callIt[T SchemeOptions]() string {
                return Probes.NeedsScheme[T]()
            }

            Console.WriteLine(callIt[SchemeOptions]())
            """;

        const string SameCompilationBound = """
            package P
            import System
            import HelperLib2

            class MyScheme : SchemeOptions {
            }

            func callIt[T MyScheme]() string {
                return Probes.NeedsScheme[T]()
            }

            Console.WriteLine(callIt[MyScheme]())
            """;

        const string InterfaceSpelling = """
            package P
            import System
            import HelperLib2

            func callIt[T DisposableBase]() string {
                return Probes.NeedsDisposable[T]()
            }

            Console.WriteLine(callIt[DisposableBase]())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4070_base_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            foreach (var (name, source) in new[]
            {
                ("ImportedBound", ImportedBound),
                ("SameCompilationBound", SameCompilationBound),
            })
            {
                var path = Path.Combine(tempDir, name + ".dll");
                var log = Compile(tempDir, name + ".gs", source, path, "/target:exe", "/reference:" + libPath);

                Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal);
                Assert.False(
                    File.Exists(path),
                    $"the base-class gap (#4083) is still open, so '{name}' must still be refused. If it now "
                        + $"compiles, the gap is closed — move it into NowBinding. Log:\n{log}");

                var occurrences = log.Split("GS0159", StringSplitOptions.None).Length - 1;
                Assert.True(
                    occurrences == 1,
                    $"'{name}' must report GS0159 exactly once, saw {occurrences}. Log:\n{log}");
            }

            // The INTERFACE spelling of the same question is what this change
            // fixed, and it is what any later fix must not break.
            var interfacePath = Path.Combine(tempDir, "Interface.dll");
            var interfaceLog = Compile(
                tempDir, "Interface.gs", InterfaceSpelling, interfacePath, "/target:exe", "/reference:" + libPath);
            Assert.True(
                File.Exists(interfacePath),
                $"the interface spelling must compile. Log:\n{interfaceLog}");

            IlVerifier.Verify(interfacePath, new[] { libPath });

            var (exit, output) = RunDotnet(interfacePath);
            Assert.True(exit == 0, $"the interface spelling must run. Exit {exit}:\n{output}");
            Assert.Equal("method-ok", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The generic-TYPE path and the generic-METHOD path now answer the SAME
    /// question the same way, in one program. That equality is the whole point
    /// of #4070: <c>class Forwarded[T DisposableBase] : DisposableConstrained[T]</c>
    /// bound on the parent while <c>Probes.NeedsDisposable[T]()</c> did not.
    /// </summary>
    [Fact]
    public void TheTypePathAndTheMethodPathNowAgree()
    {
        const string Source = """
            package P
            import System
            import HelperLib2

            func viaMethod[T DisposableBase]() string {
                return Probes.NeedsDisposable[T]()
            }

            func viaMethodRefused[T SchemeOptions]() string {
                return Probes.Unconstrained[T]()
            }

            Console.WriteLine(viaMethod[DisposableBase]())
            Console.WriteLine(viaMethodRefused[SchemeOptions]())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4070_agree_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, "Agree.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"both paths must bind. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"the program must run. Exit {exit}:\n{output}");
            Assert.Equal(new[] { "method-ok", "unconstrained-ok" }, SplitLines(output));
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
