// <copyright file="Issue4089And4090GsDeclaredGenericTypeClauseConstraintTests.cs" company="GSharp">
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
/// Issues #4089 and #4090: the two constraint questions a <b>G#-declared</b>
/// generic TYPE CLAUSE was not asked — whether an OPEN argument forwards the
/// declared bound over a generic <b>INTERFACE</b> (#4089, <c>GS0580</c>), and
/// whether a <b>CLOSED</b> argument satisfies it anywhere (#4090,
/// <c>GS0152</c>).
/// </summary>
/// <remarks>
/// <para><b>Both repros, re-measured on <c>origin/main</c> @ <c>26df552b</c>
/// before anything was written.</b> <c>class Holder[T] : IGsBox[T]</c> over
/// <c>interface IGsBox[TI SchemeOptions]</c> compiled, its IL VERIFIED — an
/// interface-implementation row is not something ILVerify checks — and the CLR
/// refused the instantiation at load time with
/// <c>TypeLoadException: GenericArguments[0], 'T', on 'P.IGsBox`1[TI]' violates
/// the constraint of type parameter 'TI'</c>. <c>class Bad :
/// GsHandler[Unrelated]</c> and <c>var f GsHandler[Unrelated]</c> compiled and
/// emitted IL that does NOT verify:
/// <c>[IL]: Error [UnsatisfiedMethodParentInst] … Method parent instantiation
/// has unsatisfied class type parameter constraints</c>.</para>
/// <para><b>One root cause, and the third witness is what proves it.</b> Both
/// issues describe the checks as missing at a site. They are not: #4067 wired
/// <c>Binder.ReportUnforwardedUserGenericConstraint</c> at the class type
/// clause, and the CONSTRUCTOR spelling has always run
/// <c>Binder.SatisfiesConstraint</c>. What was wrong is WHEN the question is
/// asked. A declaration's type-parameter constraints are resolved by
/// <c>ResolvePartialTypeParameterConstraints</c> when that declaration's own
/// body (a class) or members (an interface) are bound — #2519's aggregate-shell
/// lifecycle, which exists so a bound may name any same-compilation type and so
/// CRTP works. A type clause in ANOTHER declaration can bind first, and then
/// the declared parameter reads no constraints at all and every checker
/// accepts.</para>
/// <para>Interfaces bind their members after EVERY class body, so a G#-declared
/// generic interface was never checked at all — that is #4089. Classes are
/// ordered base-first (<c>AddBaseFirst</c>), so #4067's own base-clause repro
/// happened to work; a FIELD type has no such ordering, and
/// <c>class Unf[T] { public var f GsLate[T] }</c> with <c>GsLate</c> declared
/// BELOW it compiled silently while the identical program with <c>GsLate</c>
/// declared ABOVE reported <c>GS0580</c>. That was measured both ways on
/// <c>26df552b</c> and is <see cref="RefusedConstructions"/>'s
/// <c>a-definition-declared-below-the-field-that-uses-it</c> row. It is not in
/// either issue's text; it is the same hole seen from a third angle, and it is
/// why the repair is a deferral rather than two more call sites.</para>
/// <para><b>The repair.</b> Every G#-declared generic type-clause construction
/// now goes through <c>Binder.CheckUserGenericTypeClauseConstraints</c>, which
/// QUEUES the question while the declaration phase runs and answers it at
/// <c>Binder.FlushPendingUserGenericConstraintChecks</c>, after every
/// same-compilation constraint is resolved. Constructions bound later — method
/// bodies, which <c>BindProgram</c> binds through a freshly derived scope chain
/// — are answered in place, exactly as before. The RULES are unchanged: the
/// open half is #4067's <c>ReportUnforwardedUserGenericConstraint</c>
/// (C# §13.4.3, <c>csc</c>'s CS0314) and the closed half is
/// <c>ReportUnsatisfiedUserGenericTypeArgument</c> over the same
/// <c>SatisfiesConstraint</c> every other site already used (CS0311, which G#
/// has always spelled <c>GS0152</c>). No new diagnostic id was taken.</para>
/// <para><b>Two prerequisite false rejections, found by measurement and fixed
/// here.</b> <c>SatisfiesConstraint</c>'s predicates read reflective CLR
/// metadata that a SAME-COMPILATION symbol does not yet have, so widening the
/// predicate's reach to every type clause turned two latent false ACCEPTS into
/// false REJECTIONS — the worse direction, and the reason both are repaired in
/// this change rather than deferred.</para>
/// <para><b>#4136</b>: the <c>ClrInterfaceConstraint</c> arm used the bare
/// reflective probe, so <c>class D : IDisposable</c> did not satisfy
/// <c>[TD IDisposable]</c>. Routed through <c>BoundCarriesClrInterface</c>, the
/// same walk #4068 and #4092 gave the dependent-bound and forwarding arms.
/// <b>#4139</b>: <c>IsNonNullableValueTypeForConstraint</c> fell through to the
/// CLR probe for an <c>EnumSymbol</c>, so a source <c>enum Color</c> did not
/// satisfy <c>struct</c> — which is how it was found, because
/// <c>Issue2390NullableSameCompilationEnumBoxingEmitTests</c>'
/// <c>class Source2390 : ISource2390[Color2390]</c> went red the moment #4090's
/// enforcement reached it. Both are measurable on <c>main</c> at the
/// CONSTRUCTOR spelling (<c>GsDisposable[DisposableSource]()</c>,
/// <c>GsStruct[Color]()</c>), a path this change does not touch, which is what
/// makes them pre-existing rather than introduced. Every spelling of both is a
/// green row below.</para>
/// <para><b>The flush boundary was traced, not chosen.</b> The flush sits after
/// <c>ExpandStructInterfaceClosures</c>. The binding constraint is the
/// interface-members loop above it. The worry was the closure: an interface
/// bound is answered through <c>ImplementsInterface</c>, which reads a class's
/// own interface list. Traced by moving the flush up to immediately after the
/// interface loop, rebuilding, and compiling both inherited shapes — through a
/// BASE CLASS and through a BASE INTERFACE. Both stay green at either boundary,
/// because the walk follows <c>BaseClass</c> itself and asks
/// <c>SelfAndAllBaseInterfaces()</c>. The later point is kept as the
/// conservative one and both shapes are green rows, so moving either boundary
/// is caught here rather than by a user.</para>
/// <para><b>Blast radius.</b> This turns previously-compiling code into an
/// error. The whole <c>.gs</c> corpus was swept with the fixed build: 197 files,
/// 170 of which emit an assembly under the sweep's reference set,
/// <b>0 occurrences of GS0152 and 0 of GS0580</b> — the same counts #4092
/// measured before it.</para>
/// </remarks>
public class Issue4089And4090GsDeclaredGenericTypeClauseConstraintTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The G#-declared generics every row instantiates, plus the classes and
    /// interfaces their bounds name. Everything here is same-compilation:
    /// that is the whole point of both issues.
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

        // #4090's own definition.
        open class GsHandler[TOptions SchemeOptions] {
            public var Tag string = "g"
        }

        // #4089's own definition: a G#-declared generic INTERFACE.
        interface IGsBox[TI SchemeOptions] {
            func Unbox() TI;
        }

        open class GsStruct[TS struct] {
            public var Tag string = "s"
        }

        open class GsUnmanaged[TU unmanaged] {
            public var Tag string = "u"
        }

        // #4139: a SAME-COMPILATION enum, which has no CLR type while binding.
        enum Color { Red, Green, Blue }

        interface IEnumSource[TE struct] {
            func Find() TE?;
        }

        // A DEPENDENT bound: `TB`'s bound names the definition's own `TA`.
        open class GsPair[TA, TB TA] {
            public var Tag string = "pair"
        }

        // Unconstrained: nothing to ask.
        open class GsList[TL] {
            public var Tag string = "l"
        }

        // The interface-closure shapes the flush boundary was traced with.
        interface IBox {
            func Unbox() string;
        }

        interface IDerivedBox : IBox {
            func Extra() int32;
        }

        class ViaBaseInterface : IDerivedBox {
            public func Unbox() string { return "vi" }
            public func Extra() int32 { return 1 }
        }

        open class BoxBase : IBox {
            public func Unbox() string { return "vc" }
        }

        class ViaBaseClass : BoxBase {
        }

        open class GsBoxed[TB IBox] {
            public var Tag string = "b"
        }

        // The prerequisite false rejection: a SAME-COMPILATION class carrying
        // an IMPORTED interface, directly and through an imported base.
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

        """;

    /// <summary>
    /// Every G#-declared generic type-clause construction that must now be
    /// refused. Each of these compiled with no diagnostic on <c>26df552b</c>.
    /// </summary>
    /// <returns>Case name, the G# body appended to the prelude, the expected
    /// diagnostic id, and the id that must NOT also appear.</returns>
    public static IEnumerable<object[]> RefusedConstructions()
    {
        // ---- #4089: the OPEN question over a G#-declared generic INTERFACE.

        // The issue's own repro, verbatim in shape. Compiled AND IL-verified on
        // the parent; only the RUN showed the defect.
        yield return new object[]
        {
            "the-4089-repro-an-unforwarded-gs-declared-generic-interface-base",
            """
            class Holder[T] : IGsBox[T] {
                public func Unbox() T { return default(T) }
            }

            Console.WriteLine("x")
            """,
            "GS0580",
            "GS0152",
        };

        // The FIELD spelling the issue names beside it.
        yield return new object[]
        {
            "an-unforwarded-gs-declared-generic-interface-at-a-field-type",
            """
            class Holder[T] {
                public var B IGsBox[T]
            }

            Console.WriteLine("x")
            """,
            "GS0580",
            "GS0152",
        };

        // A bound that exists but does not imply the interface's declared one.
        yield return new object[]
        {
            "a-bound-that-does-not-imply-the-interfaces-declared-one",
            """
            class Holder[T Unrelated] {
                public var B IGsBox[T]
            }

            Console.WriteLine("x")
            """,
            "GS0580",
            "GS0152",
        };

        // THE THIRD WITNESS, and the one neither issue mentions: the CLASS case
        // was already wired, but the answer depended on SOURCE ORDER. A field
        // type is not ordered by `AddBaseFirst`, so a definition declared BELOW
        // its use had not resolved its own bound and was silently accepted. The
        // identical program with `GsLate` declared ABOVE reported GS0580 on the
        // parent — measured both ways, which is what makes this the same hole
        // rather than a second one.
        yield return new object[]
        {
            "a-definition-declared-below-the-field-that-uses-it",
            """
            class Unf[T] {
                public var F GsLate[T]
            }

            open class GsLate[TL SchemeOptions] {
                public var Tag string = "late"
            }

            Console.WriteLine("x")
            """,
            "GS0580",
            "GS0152",
        };

        // ---- #4090: the CLOSED question, everywhere.

        // The issue's own repro, base-clause half.
        yield return new object[]
        {
            "the-4090-repro-a-closed-violating-argument-in-a-base-clause",
            """
            class Bad : GsHandler[Unrelated] {
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        // ... and its variable-type half. This one binds AFTER the flush, on
        // the in-place path, so the row covers the other side of the latch.
        yield return new object[]
        {
            "the-4090-repro-a-closed-violating-argument-at-a-variable-type",
            """
            var f GsHandler[Unrelated]
            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        yield return new object[]
        {
            "a-closed-violating-argument-at-a-field-type",
            """
            class Holder {
                public var H GsHandler[Unrelated]
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        yield return new object[]
        {
            "a-closed-violating-argument-at-a-return-type",
            """
            func take() GsHandler[Unrelated] {
                return nil
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        // Inside a method BODY, which binds through a freshly derived scope
        // chain and therefore takes the in-place path rather than the queue.
        yield return new object[]
        {
            "a-closed-violating-argument-inside-a-method-body",
            """
            class Holder {
                public func M() {
                    var local GsHandler[Unrelated]
                    Console.WriteLine("no")
                }
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        // The G#-declared generic INTERFACE, closed. #4089's site asking
        // #4090's question.
        yield return new object[]
        {
            "a-closed-violating-argument-at-a-gs-declared-generic-interface",
            """
            class Holder {
                public var B IGsBox[Unrelated]
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        // NESTED inside another construction: the inner clause is bound by the
        // same recursive walk, so it is asked too.
        yield return new object[]
        {
            "a-closed-violating-argument-nested-inside-another-construction",
            """
            class Holder {
                public var N GsList[GsHandler[string]]
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        // The QUALIFIED spelling, which reaches
        // `BindAndConstructUserGenericSegment` rather than
        // `BindNonNullableTypeClause`. Both sites are wired; this is the row
        // that says so.
        yield return new object[]
        {
            "a-closed-violating-argument-at-a-qualified-name",
            """
            class Holder {
                public var Q P.GsHandler[string]
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        // A SPECIAL constraint, closed: `SchemeOptions` is a class, so it does
        // not satisfy `struct`.
        yield return new object[]
        {
            "a-closed-argument-violating-a-special-constraint",
            """
            class Holder {
                public var S GsStruct[SchemeOptions]
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };

        // A DEPENDENT bound (#4043), closed — the shape that only has an answer
        // once the BOUNDING parameter's own argument is known, which is why the
        // checker maps the whole vector before asking any position.
        yield return new object[]
        {
            "a-closed-argument-violating-a-dependent-bound",
            """
            class Holder {
                public var P GsPair[SchemeOptions, Unrelated]
            }

            Console.WriteLine("x")
            """,
            "GS0152",
            "GS0580",
        };
    }

    /// <summary>
    /// Every shape the two rules must NOT reject. A false GS0152 or GS0580 is a
    /// worse defect than either of the ones being fixed, and this table is what
    /// stands between the change and one.
    /// </summary>
    /// <returns>Case name, the G# body appended to the prelude, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedConstructions()
    {
        // #4089's own control: the forwarded spelling.
        yield return new object[]
        {
            "the-4089-control-a-forwarded-gs-declared-generic-interface",
            """
            class Holder[T SchemeOptions] : IGsBox[T] {
                public func Unbox() T { return default(T) }
            }

            Console.WriteLine(Holder[SchemeOptions]().Unbox() == nil)
            """,
            new[] { "True" },
        };

        // ... at a field type too.
        yield return new object[]
        {
            "a-forwarded-gs-declared-generic-interface-at-a-field-type",
            """
            class Holder[T SchemeOptions] {
                public var B IGsBox[T]
            }

            Console.WriteLine("x")
            """,
            new[] { "x" },
        };

        // #4090's own control: the satisfied closed spelling.
        yield return new object[]
        {
            "the-4090-control-a-satisfied-closed-argument-in-a-base-clause",
            """
            class Good : GsHandler[SchemeOptions] {
            }

            Console.WriteLine(Good().Tag)
            """,
            new[] { "g" },
        };

        // A DERIVED argument satisfies a base-class bound.
        yield return new object[]
        {
            "a-derived-closed-argument-satisfies-a-base-class-bound",
            """
            class Good : GsHandler[DerivedOptions] {
            }

            var alsoOk GsHandler[DerivedOptions]
            Console.WriteLine(Good().Tag)
            """,
            new[] { "g" },
        };

        // The definition declared BELOW its satisfied use — the mirror of the
        // red source-order row, so the deferral is shown to accept as well as
        // reject independently of order.
        yield return new object[]
        {
            "a-definition-declared-below-its-satisfied-use",
            """
            class Holder {
                public var F GsLate[SchemeOptions]
            }

            open class GsLate[TL SchemeOptions] {
                public var Tag string = "late"
            }

            Console.WriteLine(GsLate[SchemeOptions]().Tag)
            """,
            new[] { "late" },
        };

        // FLUSH BOUNDARY, arm 1: the implementation is inherited from a BASE
        // CLASS. Green at both candidate flush points (traced); the row exists
        // so a future move of the boundary is caught.
        yield return new object[]
        {
            "an-interface-bound-satisfied-through-a-base-class",
            """
            class Uses : GsBoxed[ViaBaseClass] {
            }

            Console.WriteLine(Uses().Tag)
            """,
            new[] { "b" },
        };

        // FLUSH BOUNDARY, arm 2: the bound interface is reached through a BASE
        // INTERFACE, whose own base list is populated only when the interface's
        // members bind.
        yield return new object[]
        {
            "an-interface-bound-satisfied-through-a-base-interface",
            """
            class Uses : GsBoxed[ViaBaseInterface] {
            }

            Console.WriteLine(Uses().Tag)
            """,
            new[] { "b" },
        };

        // A satisfied DEPENDENT bound, the green half of the vector-wide
        // substitution.
        yield return new object[]
        {
            "a-satisfied-dependent-bound",
            """
            class Holder {
                public var P GsPair[SchemeOptions, DerivedOptions]
            }

            Console.WriteLine(GsPair[SchemeOptions, DerivedOptions]().Tag)
            """,
            new[] { "pair" },
        };

        // CRTP over a G#-declared generic INTERFACE bound — the shape #2519's
        // lifecycle exists to keep working, now that #4089 asks a question at
        // that site at all.
        yield return new object[]
        {
            "a-crtp-interface-bound-over-a-gs-declared-interface",
            """
            interface ICmp[TC ICmp[TC]] {
                func CompareWith(other TC) int32;
            }

            class Node : ICmp[Node] {
                public func CompareWith(other Node) int32 { return 0 }
            }

            open class Bag[TItem ICmp[TItem]] {
                public var Label string = "bag"
            }

            class NodeBag : Bag[Node] {
            }

            Console.WriteLine(NodeBag().Label)
            """,
            new[] { "bag" },
        };

        // An unconstrained definition asks nothing of a closed argument.
        yield return new object[]
        {
            "an-unconstrained-definition-accepts-any-closed-argument",
            """
            class Holder {
                public var L GsList[Unrelated]
            }

            Console.WriteLine(GsList[Unrelated]().Tag)
            """,
            new[] { "l" },
        };

        // PREREQUISITE FIX, type-clause spelling: a SAME-COMPILATION class has
        // no CLR type while binding, so the bare reflective probe answered "no"
        // for `class D : IDisposable` at `[TD IDisposable]`.
        yield return new object[]
        {
            "a-source-class-satisfies-the-imported-interface-it-implements",
            """
            class Uses : GsDisposable[DisposableSource] {
            }

            Console.WriteLine(Uses().Tag)
            """,
            new[] { "d" },
        };

        // PREREQUISITE FIX, imported-base arm: the interface arrives through an
        // IMPORTED base class, which a source class holds in its own slot.
        yield return new object[]
        {
            "a-source-class-satisfies-the-interface-its-imported-base-carries",
            """
            class Uses : GsEnumerable[EnumerableSource] {
            }

            Console.WriteLine(Uses().Tag)
            """,
            new[] { "e" },
        };

        // PREREQUISITE FIX (#4139), type-clause spelling: a SAME-COMPILATION
        // enum is a non-nullable value type, so it satisfies `struct` — and
        // `unmanaged`, which the `struct` check gates. Without this the very
        // first fixture #4090's enforcement touched
        // (Issue2390NullableSameCompilationEnumBoxingEmitTests) went red.
        yield return new object[]
        {
            "a-source-enum-satisfies-a-struct-constraint",
            """
            class Uses {
                public var S GsStruct[Color]
                public var U GsUnmanaged[Color]
            }

            Console.WriteLine(GsStruct[Color]().Tag + GsUnmanaged[Color]().Tag)
            """,
            new[] { "su" },
        };

        // ... and at a G#-declared generic INTERFACE implementation, which is
        // the shape #2390's own fixture writes.
        yield return new object[]
        {
            "a-source-enum-satisfies-a-struct-constraint-at-an-interface-implementation",
            """
            class Source : IEnumSource[Color] {
                func Find() Color? -> Color.Blue
            }

            let s IEnumSource[Color] = Source{}
            Console.WriteLine(s.Find())
            """,
            new[] { "Blue" },
        };

        // PREREQUISITE FIX, CONSTRUCTOR spelling — the witness that proves the
        // defect was PRE-EXISTING rather than introduced here. This path
        // (`OverloadResolver.Constructors`) is untouched by this change and
        // reported a false GS0152 on `main`.
        yield return new object[]
        {
            "the-constructor-spelling-of-a-source-class-carrying-an-imported-interface",
            """
            let a = GsDisposable[DisposableSource]()
            let b = GsEnumerable[EnumerableSource]()
            Console.WriteLine(a.Tag + b.Tag)
            """,
            new[] { "de" },
        };
    }

    /// <summary>
    /// Every construction in <see cref="RefusedConstructions"/> reports its
    /// diagnostic at compile time — exactly once, and only that one — instead of
    /// emitting IL the CLR or ILVerify refuses.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared prelude.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    /// <param name="forbiddenId">The sibling id that must NOT also fire.</param>
    [Theory]
    [MemberData(nameof(RefusedConstructions))]
    public void AnUncheckedGsDeclaredTypeClause_IsNowRefused(
        string name,
        string body,
        string expectedId,
        string forbiddenId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4089_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The OPEN and CLOSED questions are complementary per position, so
            // exactly one of them has an answer to give. Both firing would mean
            // an erased placeholder was asked a closed constraint (#4016/#4031)
            // or a closed argument was asked an implication.
            Assert.DoesNotContain(forbiddenId, appLog, StringComparison.Ordinal);

            // Issue #4032's lesson, inherited through #4067: assert the COUNT,
            // not the presence. A type clause is re-bound through several entry
            // points, and the deferral adds one more — the queue is drained on a
            // bag that may already hold an in-place report of the same
            // violation.
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
    /// Every construction in <see cref="AcceptedConstructions"/> compiles,
    /// IL-verifies, runs and prints. These are the rows a false GS0152 or
    /// GS0580 would break.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# body appended to the shared prelude.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedConstructions))]
    public void ACheckedGsDeclaredTypeClause_StillCompilesVerifiesAndRuns(
        string name,
        string body,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4089_ok_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);
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
    /// The <c>GS0152</c> text at a type clause names the offending argument,
    /// the definition's parameter, and the bound — the same three facts the
    /// constructor spelling has always named, so the two spellings of one
    /// violation read identically.
    /// </summary>
    [Fact]
    public void TheClosedDiagnosticNamesTheArgumentTheParameterAndTheBound()
    {
        const string Body = """
            class Bad : GsHandler[Unrelated] {
            }

            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4090_msg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(tempDir, "App.gs", Prelude + Body, appPath, "/target:exe");

            Assert.Contains("GS0152", appLog, StringComparison.Ordinal);
            Assert.Contains("'Unrelated'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TOptions'", appLog, StringComparison.Ordinal);
            Assert.Contains("'SchemeOptions'", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The <c>GS0580</c> text at a G#-declared generic INTERFACE names the
    /// author's own type parameter, the interface's parameter, and the bound it
    /// does not carry — identical in shape to the class case #4067 closed, which
    /// is the point: one rule, two substrates.
    /// </summary>
    [Fact]
    public void TheOpenDiagnosticAtAnInterfaceNamesBothParametersAndTheBound()
    {
        const string Body = """
            class Holder[T] : IGsBox[T] {
                public func Unbox() T { return default(T) }
            }

            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4089_msg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(tempDir, "App.gs", Prelude + Body, appPath, "/target:exe");

            Assert.Contains("GS0580", appLog, StringComparison.Ordinal);
            Assert.Contains("'T'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TI'", appLog, StringComparison.Ordinal);
            Assert.Contains("'SchemeOptions'", appLog, StringComparison.Ordinal);
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
