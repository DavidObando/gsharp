// <copyright file="Issue4067UnforwardedGsDeclaredGenericBaseTests.cs" company="GSharp">
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
/// Issue #4067: a generic declaration that names its OWN type parameter as the
/// type argument of a <b>G#-DECLARED</b> constrained generic, without
/// forwarding the bound.
/// </summary>
/// <remarks>
/// <para><b>The repro, re-measured on <c>origin/main</c> @ <c>7708be7d</c>
/// before anything was written.</b> <c>class Unf[T] : GsHandler[T]</c> over
/// <c>open class GsHandler[TOptions SchemeOptions]</c> compiled with no
/// diagnostic, and the emitted <c>extends</c> row named an instantiation that
/// is not provably valid for every <c>T</c>:
/// <c>[IL]: Error [UnsatisfiedMethodParentInst]: [gsbase.dll :
/// P.Unf`1::.ctor()][offset 0x00000001][found [P]P.GsHandler`1&lt;T0&gt;]
/// Method parent instantiation has unsatisfied class type parameter
/// constraints.</c></para>
/// <para><b>Root cause, and why it is NOT #4063's.</b> #4037 put the
/// implication rule — "T stands for every type its own bounds admit, so the
/// instantiation is valid exactly when T's constraint set IMPLIES the
/// definition's", C# §13.4.3, <c>csc</c>'s CS0314 — at
/// <c>Binder.ReportUnsatisfiedGenericTypeConstraint</c>, the one entry point
/// every user-facing <c>Type.MakeGenericType</c> construction funnels through.
/// A G#-DECLARED generic is never closed that way: the type-clause binder
/// resolves it by symbol substitution at
/// <c>StructSymbol.Construct</c> / <c>InterfaceSymbol.Construct</c> and never
/// builds a CLR open definition at all, so the construction reached NO
/// constraint checker. This is therefore a MISSING CHECK on a path that had
/// none — the opposite failure from #4063, which is a wrong RELATION on a path
/// that exists. The two issues do not share a root cause; they share only the
/// symptom, IL the CLR refuses.</para>
/// <para><b>The rule is the symbolic twin, deliberately.</b>
/// <c>ClrOverloadResolution.TypeParameterForwardsDeclaredConstraints</c> asks
/// this of a reflective <c>Type</c>;
/// <c>Binder.TypeParameterForwardsUserDeclaredConstraints</c> asks the same
/// question of <c>TypeParameterSymbol.ClassConstraint</c> /
/// <c>InterfaceConstraint</c> / <c>ClrInterfaceConstraint</c> /
/// <c>HasReferenceTypeConstraint</c> / <c>HasValueTypeConstraint</c> /
/// <c>HasDefaultConstructorConstraint</c>, and both report <c>GS0580</c>.</para>
/// <para><b>Two walks, and the difference was measured rather than assumed.</b>
/// A TYPE bound is implied by anything the parameter is provably an instance
/// of, so it is asked of the argument AND of every bound in its chain — that is
/// what makes <c>[T PingOptions]</c> forward <c>[TP IPing]</c> when
/// <c>PingOptions</c> implements <c>IPing</c>, which is the false rejection
/// #4037's own review caught in the imported twin. A SPECIAL constraint
/// (<c>struct</c> / <c>class</c> / <c>init()</c> / <c>unmanaged</c>) is a
/// property of the PARAMETER's declaration and is asked only of the type
/// parameters in the chain: a class bound with a public parameterless
/// constructor does NOT give the parameter <c>init()</c>, and accepting it
/// there would be a false accept the CLR then refuses.</para>
/// <para><b>The chain arm is load-bearing, and it is what made this more than a
/// call to <c>Binder.SatisfiesConstraint</c>.</b> Measured on the parent:
/// <c>func f[U SchemeOptions, T U]() { GsHandler[T]{…} }</c> already reports a
/// FALSE <c>GS0152</c> on the struct-literal path, because
/// <c>SatisfiesClassConstraint</c> propagates through <c>ClassConstraint</c>
/// and not through #4043's <c>TypeParameterBound</c> slot. The equivalent base
/// clause <c>class Fwd[U SchemeOptions, T U] : GsHandler[T]</c> compiles,
/// IL-verifies and RUNS — also measured — so reusing that predicate unchanged
/// would have turned a legal program into a GS0580. It is a green row below.
/// The pre-existing struct-literal false rejection was filed as <b>#4091</b> and
/// has since been FIXED on <c>main</c>, which taught
/// <c>SatisfiesClassConstraint</c> itself to follow the
/// <c>TypeParameterBound</c> slot. This chain walk is therefore no longer the
/// only thing standing between that row and a false rejection — but it is still
/// what carries the SPECIAL constraints and the interface arms, which
/// <c>SatisfiesClassConstraint</c> does not answer, so it stays and the row
/// stays with it.</para>
/// <para><b>What is still not asked, and it is pinned rather than described.</b>
/// Only a type argument that IS a type parameter. A composite open shape
/// (<c>GsList[[]T]</c>) has no forwarding question; a declared bound that
/// mentions another of the definition's own parameters is the #4031/#4041
/// dependent shape, where answering on an unsubstituted parameter is precisely
/// what goes wrong; a G#-declared generic INTERFACE has not resolved its own
/// parameters' constraints yet when a class body is bound (#2519's CRTP
/// lifecycle — traced at the site, see
/// <see cref="AGsDeclaredGenericInterface_IsStillNotChecked"/>); and a CLOSED
/// violating argument (<c>class Bad : GsHandler[Unrelated]</c>) is a different
/// question this checker deliberately does not ask — see
/// <see cref="AClosedViolatingArgumentAtAGsDeclaredGeneric_IsStillNotChecked"/>.
/// Each is a row rather than a sentence.</para>
/// <para><b>The asserting row this issue was filed with has been moved, not
/// deleted.</b> <c>Issue4037UnforwardedConstrainedGenericBaseTests</c> pinned
/// this gap as <c>AGsDeclaredConstrainedGenericBase_IsStillNotChecked</c>,
/// asserting that the program compiled and that ILVerify reported
/// <c>UnsatisfiedMethodParentInst</c>, with a message telling whoever closed
/// the issue to move it into that class's <c>UnforwardedConstraints</c> table.
/// It is now a row there, and the forwarded spelling that stood beside it is a
/// row in that class's <c>ForwardedAndSkippedShapes</c>. This class is the issue's
/// own repro and its full matrix.</para>
/// <para><b>Blast radius.</b> This turns previously-compiling code into an
/// error. The whole <c>.gs</c> corpus was swept before and after: 197 files,
/// 170 of which emit an assembly under the sweep's reference set,
/// <b>0 occurrences of GS0580</b>.</para>
/// </remarks>
public class Issue4067UnforwardedGsDeclaredGenericBaseTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The G#-declared constrained generics every row instantiates, plus the
    /// classes and interface their bounds name. Everything here is
    /// same-compilation: that is the whole point of the issue.
    /// </summary>
    private const string Prelude = """
        package P
        import System
        import System.Collections

        open class SchemeOptions {
            public var Name string = ""
        }

        open class DerivedOptions : SchemeOptions {
            public var Extra int32
        }

        open class Unrelated {
            public var Q int32
        }

        interface IPing {
            func Ping() int32;
        }

        open class PingOptions : SchemeOptions, IPing {
            public func Ping() int32 { return 7 }
        }

        // The issue's own definition.
        open class GsHandler[TOptions SchemeOptions] {
            public var Tag string = "g"
        }

        open class GsPing[TP IPing] {
            public var Tag string = "p"
        }

        open class GsNew[TN init()] {
            public var Tag string = "n"
        }

        open class GsClass[TC class] {
            public var Tag string = "c"
        }

        open class GsStruct[TS struct] {
            public var Tag string = "s"
        }

        // A DEPENDENT bound: `TB`'s bound names the definition's own `TA`.
        open class GsPair[TA, TB TA] {
            public var Tag string = "pair"
        }

        // Unconstrained: nothing to forward.
        open class GsList[TL] {
            public var Tag string = "l"
        }

        interface IGsBox[TI SchemeOptions] {
            func Unbox() TI;
        }

        // Review finding (#4092): the two implication branches the first
        // matrix left untested.
        open class GsUnmanaged[TU unmanaged] {
            public var Tag string = "u"
        }

        open class GsComparable[TK comparable] {
            public var Tag string = "k"
        }

        // Review finding (#4092): an IMPORTED interface bound, reached from a
        // SAME-COMPILATION class that has no CLR type while binding.
        open class GsDisposable[TD IDisposable] {
            public var Tag string = "d"
        }

        class DisposableSource : IDisposable {
            public func Dispose() {
            }
        }

        // ... and one whose IMPORTED BASE carries the interface instead.
        class EnumerableSource : ArrayList {
        }

        """;

    /// <summary>
    /// Every declaration that writes its own type parameter at a G#-declared
    /// constrained position it does not forward. Each of these compiled with no
    /// diagnostic on the parent and emitted IL that ILVerify refuses.
    /// </summary>
    /// <returns>Case name, the G# body appended to the prelude, expected diagnostic id.</returns>
    public static IEnumerable<object[]> UnforwardedConstraints()
    {
        // The issue's own repro, verbatim.
        yield return new object[]
        {
            "the-issues-own-repro-a-gs-declared-constrained-base",
            """
            class Unf[T] : GsHandler[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // A bound that exists but does not imply the declared one.
        yield return new object[]
        {
            "a-class-bound-that-does-not-imply-the-declared-one",
            """
            class Unf[T Unrelated] : GsHandler[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // An INTERFACE bound does not imply a CLASS bound.
        yield return new object[]
        {
            "an-interface-bound-against-a-class-bound",
            """
            class Unf[T IPing] : GsHandler[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // ... and a CLASS bound does not imply an interface the class does not
        // carry. `SchemeOptions` does not implement `IPing`; `PingOptions`
        // does, and that spelling is a green row.
        yield return new object[]
        {
            "a-class-bound-against-an-interface-the-class-lacks",
            """
            class Unf[T SchemeOptions] : GsPing[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // The special constraints, one row each. `csc` reports CS0314 for all
        // three, and the CLR refuses all three.
        yield return new object[]
        {
            "an-unforwarded-default-constructor-constraint",
            """
            class Unf[T] : GsNew[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        yield return new object[]
        {
            "an-unforwarded-reference-type-constraint",
            """
            class Unf[T] : GsClass[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        yield return new object[]
        {
            "an-unforwarded-value-type-constraint",
            """
            class Unf[T] : GsStruct[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // A class bound gives the parameter reference-ness but NOT a public
        // parameterless constructor: this is the false accept the two-walk
        // split exists to prevent, and it is a red row rather than a comment.
        yield return new object[]
        {
            "a-class-bound-does-not-supply-a-default-constructor",
            """
            class Unf[T SchemeOptions] : GsNew[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // Review finding (#4092): the `unmanaged` branch. `struct` is NOT
        // `unmanaged` — a value type may hold a reference — so a forwarded
        // `struct` does not carry it, and this is the row that separates the
        // two flags.
        yield return new object[]
        {
            "an-unforwarded-unmanaged-constraint",
            """
            class Unf[T struct] : GsUnmanaged[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // Review finding (#4092): the `comparable` branch (ADR-0020's legacy
        // constraint), which has its own implication rule and had no row.
        yield return new object[]
        {
            "an-unforwarded-comparable-constraint",
            """
            class Unf[T] : GsComparable[T] {
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // NOT only the base clause. `csc` reports CS0314 at a field type too,
        // which is why the check sits at the shared construction site rather
        // than in the base-clause binder.
        yield return new object[]
        {
            "a-field-typed-by-an-unforwarded-instantiation",
            """
            class Holder[T] {
                public var H GsHandler[T]
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };

        // ... and at a return type.
        yield return new object[]
        {
            "a-return-type-that-is-an-unforwarded-instantiation",
            """
            func take[T]() GsHandler[T] {
                return nil
            }

            Console.WriteLine("x")
            """,
            "GS0580",
        };
    }

    /// <summary>
    /// Every shape the rule must NOT reject: the forwarded spellings, the
    /// implications a forwarded bound genuinely carries, and the two positions
    /// the rule deliberately declines to ask about. A false GS0580 is a worse
    /// defect than the one being fixed.
    /// </summary>
    /// <returns>Case name, the G# body appended to the prelude, expected stdout lines.</returns>
    public static IEnumerable<object[]> ForwardedConstraints()
    {
        // The issue's own control, verbatim.
        yield return new object[]
        {
            "the-issues-own-control-the-forwarded-spelling",
            """
            class Fwd[T SchemeOptions] : GsHandler[T] {
            }

            Console.WriteLine(Fwd[SchemeOptions]().Tag)
            """,
            new[] { "g" },
        };

        // A DERIVED class bound implies the declared base bound.
        yield return new object[]
        {
            "a-derived-class-bound-implies-the-declared-base",
            """
            class Fwd[T DerivedOptions] : GsHandler[T] {
            }

            Console.WriteLine(Fwd[DerivedOptions]().Tag)
            """,
            new[] { "g" },
        };

        // THE row that made this more than a call to `SatisfiesConstraint`:
        // the bound reaches the declared class through #4043's dependent-bound
        // slot rather than through `ClassConstraint`. Measured legal — it
        // compiles, IL-verifies and runs on the parent — so a checker that
        // could not see the chain would have turned it into a GS0580.
        yield return new object[]
        {
            "a-bound-forwarded-through-a-chain-of-type-parameters",
            """
            class Fwd[U SchemeOptions, T U] : GsHandler[T] {
            }

            Console.WriteLine(Fwd[SchemeOptions, SchemeOptions]().Tag)
            """,
            new[] { "g" },
        };

        // A CLASS bound implies every interface that class carries. This is
        // #4037's own review defect, asked of the symbolic surface.
        yield return new object[]
        {
            "a-class-bound-implies-the-interfaces-it-carries",
            """
            class Fwd[T PingOptions] : GsPing[T] {
            }

            Console.WriteLine(Fwd[PingOptions]().Tag)
            """,
            new[] { "p" },
        };

        // The interface bound spelled directly.
        yield return new object[]
        {
            "the-interface-bound-forwarded-directly",
            """
            class Fwd[T IPing] : GsPing[T] {
            }

            Console.WriteLine(Fwd[PingOptions]().Tag)
            """,
            new[] { "p" },
        };

        // The special constraints, forwarded.
        yield return new object[]
        {
            "a-forwarded-default-constructor-constraint",
            """
            class Fwd[T init()] : GsNew[T] {
            }

            Console.WriteLine(Fwd[SchemeOptions]().Tag)
            """,
            new[] { "n" },
        };

        yield return new object[]
        {
            "a-forwarded-reference-type-constraint",
            """
            class Fwd[T class] : GsClass[T] {
            }

            Console.WriteLine(Fwd[SchemeOptions]().Tag)
            """,
            new[] { "c" },
        };

        yield return new object[]
        {
            "a-forwarded-value-type-constraint",
            """
            class Fwd[T struct] : GsStruct[T] {
            }

            Console.WriteLine(Fwd[int32]().Tag)
            """,
            new[] { "s" },
        };

        // `struct` implies a public parameterless constructor at the CLR level
        // (ECMA-335 II.10.1.7), so it forwards `init()`.
        yield return new object[]
        {
            "a-value-type-constraint-implies-the-default-constructor-one",
            """
            class Fwd[T struct] : GsNew[T] {
            }

            Console.WriteLine(Fwd[int32]().Tag)
            """,
            new[] { "n" },
        };

        // A CLASS bound proves reference-ness, so it forwards `class`.
        yield return new object[]
        {
            "a-class-bound-implies-the-reference-type-constraint",
            """
            class Fwd[T SchemeOptions] : GsClass[T] {
            }

            Console.WriteLine(Fwd[SchemeOptions]().Tag)
            """,
            new[] { "c" },
        };

        // Review finding (#4092): the `unmanaged` branch, forwarded.
        yield return new object[]
        {
            "a-forwarded-unmanaged-constraint",
            """
            class Fwd[T unmanaged] : GsUnmanaged[T] {
            }

            Console.WriteLine(Fwd[int32]().Tag)
            """,
            new[] { "u" },
        };

        // `unmanaged` is a value-type constraint, so it forwards BOTH `struct`
        // and — through `struct` — `init()`. Two rows, because the two flags
        // are read from different slots.
        yield return new object[]
        {
            "an-unmanaged-constraint-implies-the-value-type-one",
            """
            class Fwd[T unmanaged] : GsStruct[T] {
            }

            Console.WriteLine(Fwd[int32]().Tag)
            """,
            new[] { "s" },
        };

        yield return new object[]
        {
            "an-unmanaged-constraint-implies-the-default-constructor-one",
            """
            class Fwd[T unmanaged] : GsNew[T] {
            }

            Console.WriteLine(Fwd[int32]().Tag)
            """,
            new[] { "n" },
        };

        // Review finding (#4092): the `comparable` branch, forwarded.
        yield return new object[]
        {
            "a-forwarded-comparable-constraint",
            """
            class Fwd[T comparable] : GsComparable[T] {
            }

            Console.WriteLine(Fwd[int32]().Tag)
            """,
            new[] { "k" },
        };

        // REVIEW FINDING (#4092), the serious half — a FALSE REJECTION on the
        // reviewed commit. A SAME-COMPILATION class that implements an
        // IMPORTED interface has no CLR type while binding, so the reflective
        // `SatisfiesClrInterfaceConstraint` returned false without ever
        // reading `DisposableSource`'s interface list and this reported
        // `GS0580` on a program `csc` and the CLR both accept. The arm now
        // falls back to `SourceSymbolImplementsImportedInterface`, which is
        // #4068's repair for the SAME defect on the dependent-bound path
        // rather than a fourth private copy of it.
        yield return new object[]
        {
            "review-a-source-class-bound-implies-the-imported-interface-it-implements",
            """
            class Fwd[T DisposableSource] : GsDisposable[T] {
            }

            Console.WriteLine(Fwd[DisposableSource]().Tag)
            """,
            new[] { "d" },
        };

        // REVIEW FINDING (#4092), the second arm: the interface arrives
        // through an IMPORTED BASE, which a source class holds in its own slot
        // rather than in `BaseClass` — so the shared walk saw an empty
        // interface list for `class EnumerableSource : ArrayList` and rejected
        // it for not carrying `IEnumerable`, which `ArrayList` plainly does.
        yield return new object[]
        {
            "review-a-source-class-bound-implies-the-interface-its-imported-base-carries",
            """
            open class GsEnumerable[TE IEnumerable] {
                public var Tag string = "e"
            }

            class Fwd[T EnumerableSource] : GsEnumerable[T] {
            }

            Console.WriteLine(Fwd[EnumerableSource]().Tag)
            """,
            new[] { "e" },
        };

        // SKIP: a COMPOSITE open argument has no forwarding question to ask.
        yield return new object[]
        {
            "control-a-composite-open-argument-is-not-asked",
            """
            class Composite[T] : GsList[[]T] {
            }

            Console.WriteLine(Composite[int32]().Tag)
            """,
            new[] { "l" },
        };

        // SKIP: the declared bound MENTIONS another of the definition's own
        // parameters — #4031/#4041's dependent shape, where answering on an
        // unsubstituted parameter is exactly what goes wrong.
        yield return new object[]
        {
            "control-a-dependent-bound-is-not-asked",
            """
            class Dependent[A, B] {
                public var C GsPair[A, B]
            }

            Console.WriteLine("x")
            """,
            new[] { "x" },
        };

        // SELF-REFERENCE: a constrained generic naming its OWN parameter at its
        // OWN position. The argument and the declared parameter are the same
        // symbol, so there is nothing to forward and the question is not asked
        // — a checker that asked it anyway would reject every recursive
        // declaration in the corpus.
        yield return new object[]
        {
            "control-a-definition-writing-its-own-parameter-at-its-own-position",
            """
            open class SelfRef[TS SchemeOptions] {
                public var Tag string = "r"
                public var Next SelfRef[TS]
            }

            Console.WriteLine(SelfRef[SchemeOptions]().Tag)
            """,
            new[] { "r" },
        };

        // CRTP: the declared bound is a construction over the definition's own
        // parameter, so it MENTIONS a type parameter and the implication test
        // declines — the same skip as the dependent bound above, reached
        // through `ClassConstraint` rather than `TypeParameterBound`.
        yield return new object[]
        {
            "control-a-crtp-bound-is-not-asked",
            """
            open class Crtp[TC Crtp[TC]] {
                public var Tag string = "y"
            }

            class Node : Crtp[Node] {
            }

            Console.WriteLine(Node().Tag)
            """,
            new[] { "y" },
        };

        // An unconstrained definition asks nothing of its arguments.
        yield return new object[]
        {
            "control-an-unconstrained-definition-asks-nothing",
            """
            class Plain[T] : GsList[T] {
            }

            Console.WriteLine(Plain[int32]().Tag)
            """,
            new[] { "l" },
        };

        // A G#-declared generic INTERFACE, forwarded. Interfaces are outside
        // this rule's reach (see AGsDeclaredGenericInterface_IsStillNotChecked)
        // and the forwarded spelling must keep binding either way.
        yield return new object[]
        {
            "a-forwarded-gs-declared-generic-interface",
            """
            class Holder[T SchemeOptions] {
                public var B IGsBox[T]
            }

            Console.WriteLine("x")
            """,
            new[] { "x" },
        };
    }

    /// <summary>
    /// An instantiation of a G#-declared constrained generic whose type
    /// parameter does not forward the bound now reports <c>GS0580</c> at
    /// compile time — exactly once — instead of emitting IL that does not
    /// verify.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared prelude.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(UnforwardedConstraints))]
    public void AnUnforwardedGsDeclaredInstantiation_IsRefused(string name, string body, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4067_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The CLOSED check must not be the one that fired: this is an open
            // instantiation, and GS0152 here would mean the erased placeholder
            // was asked a constraint — the #4016/#4031 defect.
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);

            // Issue #4032's lesson, inherited through #4037: assert the COUNT,
            // not the presence. A type clause is re-bound through several entry
            // points, so a per-call report would turn one violation into a count
            // that is a function of how many internal paths the binder took.
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
    /// Every forwarded spelling, every implication a bound genuinely carries,
    /// and every deliberately unasked position compiles, IL-verifies, runs and
    /// prints. These are the rows a false GS0580 would break.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared prelude.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(ForwardedConstraints))]
    public void AForwardedGsDeclaredInstantiation_CompilesVerifiesAndRuns(
        string name,
        string body,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4067_ok_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal);
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

    /// <summary>
    /// The <c>GS0580</c> text names the author's own type parameter, the
    /// definition's parameter whose bound it fails, and the bound itself — so
    /// the reader can see that the fix is on the DECLARATION of <c>T</c> rather
    /// than at the instantiation.
    /// </summary>
    [Fact]
    public void TheDiagnosticNamesBothParametersAndTheBound()
    {
        const string Body = """
            class Unf[T] : GsHandler[T] {
            }

            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4067_msg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(tempDir, "App.gs", Prelude + Body, appPath, "/target:exe");

            Assert.Contains("GS0580", appLog, StringComparison.Ordinal);
            Assert.Contains("'T'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TOptions'", appLog, StringComparison.Ordinal);
            Assert.Contains("'SchemeOptions'", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// NOT COVERED, and pinned so it is measured rather than merely described:
    /// the same unforwarded shape over a G#-declared generic <b>INTERFACE</b>
    /// (<c>class Holder[T] : IGsBox[T]</c> where
    /// <c>IGsBox[TI SchemeOptions]</c> is declared in the same compilation)
    /// still compiles, and still throws <c>TypeLoadException</c> when the
    /// program touches it.
    /// </summary>
    /// <remarks>
    /// <para>The RULE is the one this change adds; the SUBSTRATE is not ready
    /// when it would have to run. An interface publishes bare type parameters
    /// with its shell and resolves their constraints only when its MEMBERS are
    /// bound — deliberately, so CRTP still works (#2519). A class body binds
    /// first, so at <c>IGsBox[T]</c> the declared parameter still reads
    /// <c>ClassConstraint == null</c> and there is nothing to imply. Traced at
    /// the construction site, not inferred. Moving that resolution earlier is
    /// the interface-shell lifecycle, which is a separate repair.</para>
    /// <para><b>ILVerify does not catch this one, and the row says so.</b> The
    /// emitted assembly verifies — the interface-implementation row is not
    /// something ILVerify checks — and the CLR refuses the instantiation at
    /// load time instead. The row therefore asserts the RUN, which is the only
    /// place the defect is visible.</para>
    /// <para>Filed as <b>#4089</b>. A fix should turn this row red, at which
    /// point it moves into <see cref="UnforwardedConstraints"/> beside its
    /// class siblings. The forwarded spelling is already a green row
    /// there.</para>
    /// </remarks>
    [Fact]
    public void AGsDeclaredGenericInterface_IsStillNotChecked()
    {
        const string Unforwarded = """
            class Holder[T] : IGsBox[T] {
                public func Unbox() T { return default(T) }
            }

            Console.WriteLine(Holder[SchemeOptions]().Unbox() == nil)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4067_iface_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "GsInterface.dll");
            var appLog = Compile(tempDir, "GsInterface.gs", Prelude + Unforwarded, appPath, "/target:exe");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.True(
                File.Exists(appPath),
                "the G#-declared generic INTERFACE gap is still open, so this must still compile. If it now "
                    + $"reports GS0580, the gap is closed — move this into UnforwardedConstraints. Log:\n{appLog}");

            // The emitted IL verifies; the CLR refuses the instantiation at
            // load time. Both halves are asserted so a fix that only silences
            // one of them is still visible here.
            IlVerifier.Verify(appPath, Array.Empty<string>());

            var (exit, output) = RunDotnet(appPath);
            Assert.True(
                exit != 0 && output.Contains("TypeLoadException", StringComparison.Ordinal),
                "the unforwarded G#-declared generic interface is still refused by the CLR at run time. If it "
                    + $"now runs, say why here. Exit {exit}:\n{output}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// NOT COVERED, and pinned so it is measured rather than merely described:
    /// a CLOSED violating argument at the same G#-declared construction site
    /// (<c>class Bad : GsHandler[Unrelated]</c>, <c>var f GsHandler[Unrelated]</c>)
    /// still compiles, and its IL still does not verify.
    /// </summary>
    /// <remarks>
    /// <para>It is a DIFFERENT question from this issue's. #4067 asks whether
    /// an OPEN argument's own bounds IMPLY the declared ones (C#'s CS0314);
    /// this asks whether a CLOSED argument SATISFIES them (CS0311, which G#
    /// spells <c>GS0152</c>). The constructor spelling
    /// <c>GsHandler[Unrelated]()</c> already reports <c>GS0152</c> through
    /// <c>OverloadResolver.Constructors</c> — measured — so only the TYPE-CLAUSE
    /// spelling is unchecked, and closing it is one
    /// <c>Binder.SatisfiesConstraint</c> loop at the same site this change
    /// already touches. It is left out because it is a separate GS0152 blast
    /// radius on every closed user-generic type clause in the corpus, and
    /// because #4067 does not ask for it. Filed as <b>#4090</b>.</para>
    /// <para>The row asserts the CURRENT behaviour — it compiles, and ILVerify
    /// reports <c>UnsatisfiedMethodParentInst</c>, named as a tracked
    /// suppression so a DIFFERENT verification error would still fail this row
    /// — so whoever fixes it gets a red row pointing at the exact program
    /// rather than silence. The satisfied spelling is green beside it.</para>
    /// </remarks>
    [Fact]
    public void AClosedViolatingArgumentAtAGsDeclaredGeneric_IsStillNotChecked()
    {
        const string Violating = """
            class Bad : GsHandler[Unrelated] {
            }

            var f GsHandler[Unrelated]
            Console.WriteLine("x")
            """;

        const string Satisfied = """
            class Good : GsHandler[SchemeOptions] {
            }

            Console.WriteLine(Good().Tag)
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4067_closed_").FullName;
        try
        {
            var violatingPath = Path.Combine(tempDir, "ClosedViolating.dll");
            var violatingLog = Compile(
                tempDir, "ClosedViolating.gs", Prelude + Violating, violatingPath, "/target:exe");
            Assert.DoesNotContain("GS9998", violatingLog, StringComparison.Ordinal);
            Assert.True(
                File.Exists(violatingPath),
                "the CLOSED-argument gap at a G#-declared generic type clause is still open, so this must "
                    + "still compile. If it now reports GS0152, the gap is closed — move this row into "
                    + $"UnforwardedConstraints' closed sibling. Log:\n{violatingLog}");

            IlVerifier.Verify(
                violatingPath,
                Array.Empty<string>(),
                ignoredErrorCodes: new[] { "UnsatisfiedMethodParentInst" });

            var satisfiedPath = Path.Combine(tempDir, "ClosedSatisfied.dll");
            var satisfiedLog = Compile(
                tempDir, "ClosedSatisfied.gs", Prelude + Satisfied, satisfiedPath, "/target:exe");
            Assert.True(
                File.Exists(satisfiedPath),
                $"the satisfied closed spelling must compile. Log:\n{satisfiedLog}");

            IlVerifier.Verify(satisfiedPath, Array.Empty<string>());

            var (exit, output) = RunDotnet(satisfiedPath);
            Assert.True(exit == 0, $"the satisfied closed spelling must run. Exit {exit}:\n{output}");
            Assert.Equal("g", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
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
