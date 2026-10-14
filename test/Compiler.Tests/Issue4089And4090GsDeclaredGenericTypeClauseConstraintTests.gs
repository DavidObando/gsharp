// <copyright file="Issue4089And4090GsDeclaredGenericTypeClauseConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issues #4089 and #4090: the two constraint questions a <b>G#-declared</b>
/// generic TYPE CLAUSE was not asked — whether an OPEN argument forwards the
/// declared bound over a generic <b>INTERFACE</b> (#4089, `GS0580`), and
/// whether a <b>CLOSED</b> argument satisfies it anywhere (#4090,
/// `GS0152`).
/// @remarks <b>Both repros, re-measured on <c>origin/main</c> @ <c>26df552b</c>
/// before anything was written.</b> `class Holder[T] : IGsBox[T]` over
/// `interface IGsBox[TI SchemeOptions]` compiled, its IL VERIFIED — an
/// interface-implementation row is not something ILVerify checks — and the CLR
/// refused the instantiation at load time with
/// `TypeLoadException: GenericArguments[0], 'T', on 'P.IGsBox`1[TI]' violates
/// the constraint of type parameter 'TI'`. `class Bad :
/// GsHandler[Unrelated]` and `var f GsHandler[Unrelated]` compiled and
/// emitted IL that does NOT verify:
/// `[IL]: Error [UnsatisfiedMethodParentInst] … Method parent instantiation
/// has unsatisfied class type parameter constraints`.
///
/// <b>One root cause, and the third witness is what proves it.</b> Both
/// issues describe the checks as missing at a site. They are not: #4067 wired
/// `Binder.ReportUnforwardedUserGenericConstraint` at the class type
/// clause, and the CONSTRUCTOR spelling has always run
/// `Binder.SatisfiesConstraint`. What was wrong is WHEN the question is
/// asked. A declaration's type-parameter constraints are resolved by
/// `ResolvePartialTypeParameterConstraints` when that declaration's own
/// body (a class) or members (an interface) are bound — #2519's aggregate-shell
/// lifecycle, which exists so a bound may name any same-compilation type and so
/// CRTP works. A type clause in ANOTHER declaration can bind first, and then
/// the declared parameter reads no constraints at all and every checker
/// accepts.
///
/// Interfaces bind their members after EVERY class body, so a G#-declared
/// generic interface was never checked at all — that is #4089. Classes are
/// ordered base-first (`AddBaseFirst`), so #4067's own base-clause repro
/// happened to work; a FIELD type has no such ordering, and
/// `class Unf[T] { public var f GsLate[T] }` with `GsLate` declared
/// BELOW it compiled silently while the identical program with `GsLate`
/// declared ABOVE reported `GS0580`. That was measured both ways on
/// `26df552b` and is (cref:RefusedConstructions)'s
/// `a-definition-declared-below-the-field-that-uses-it` row. It is not in
/// either issue's text; it is the same hole seen from a third angle, and it is
/// why the repair is a deferral rather than two more call sites.
///
/// <b>The repair.</b> Every G#-declared generic type-clause construction
/// now goes through `Binder.CheckUserGenericTypeClauseConstraints`, which
/// QUEUES the question while the declaration phase runs and answers it at
/// `Binder.FlushPendingUserGenericConstraintChecks`, after every
/// same-compilation constraint is resolved. Constructions bound later — method
/// bodies, which `BindProgram` binds through a freshly derived scope chain
/// — are answered in place, exactly as before. The RULES are unchanged: the
/// open half is #4067's `ReportUnforwardedUserGenericConstraint`
/// (C# §13.4.3, `csc`'s CS0314) and the closed half is
/// `ReportUnsatisfiedUserGenericTypeArgument` over the same
/// `SatisfiesConstraint` every other site already used (CS0311, which G#
/// has always spelled `GS0152`). No new diagnostic id was taken.
///
/// <b>Two prerequisite false rejections, found by measurement and fixed
/// here.</b> `SatisfiesConstraint`'s predicates read reflective CLR
/// metadata that a SAME-COMPILATION symbol does not yet have, so widening the
/// predicate's reach to every type clause turned two latent false ACCEPTS into
/// false REJECTIONS — the worse direction, and the reason both are repaired in
/// this change rather than deferred.
///
/// <b>One of the two turned out to be a DUPLICATE, and that is worth
/// recording rather than quietly dropping.</b> The
/// `ClrInterfaceConstraint` arm used the bare reflective probe, so
/// `class D : IDisposable` did not satisfy `[TD IDisposable]`. That
/// is #4124, which PR #4138 fixed at the shared leaf — the reflective body
/// split out of `SatisfiesClrInterfaceConstraint`, the symbolic walk
/// wrapping EVERY exit, and `BoundCarriesClrInterface` plus the two
/// caller-side copies DELETED. This arm already called
/// `SatisfiesClrInterfaceConstraint`, so on that base it inherits the
/// repair without any routing at all. Filed from this site as #4136 and closed
/// as a duplicate; the interim one-line repair is gone from this branch and the
/// rows are asked of #4138's leaf instead, because the TYPE-CLAUSE spelling is
/// this change's own — #4124's repro is a generic method call and a
/// constructor. The lesson is the consolidation one: #4136's own proposed fix
/// was a FIFTH copy of those three lines, and #4138 made the fifth occurrence
/// unexpressible instead of writing it.
///
/// <b>#4139</b>, by contrast, is not covered by #4138 — measured, its
/// diff touches none of `IsNonNullableValueTypeForConstraint`,
/// `IsUnmanagedTypeForConstraint` or `EnumSymbol`.
/// `IsNonNullableValueTypeForConstraint` fell through to the
/// CLR probe for an `EnumSymbol`, so a source `enum Color` did not
/// satisfy `struct` — which is how it was found, because
/// `Issue2390NullableSameCompilationEnumBoxingEmitTests`'
/// `class Source2390 : ISource2390[Color2390]` went red the moment #4090's
/// enforcement reached it. Both were measurable at the CONSTRUCTOR spelling
/// (`GsDisposable[DisposableSource]()`, `GsStruct[Color]()`) on the
/// `main` this branch started from — a path this change does not touch,
/// which is what makes them pre-existing rather than introduced. The first of
/// those two passes on today's `main`, because #4124's consolidation has
/// since landed underneath it; the second is still this branch's to fix. #4139 is nonetheless a true
/// PREREQUISITE of this change rather than a user-visible failure it merely
/// happened upon: its `class Source2390 : ISource2390[Color2390]` witness
/// is green whether or not the interface arm is repaired, and goes red only
/// once #4090 makes the type clause ask (cref:SatisfiesConstraint) at
/// all.
///
/// <b>The flush boundary was traced, not chosen.</b> The flush sits after
/// `ExpandStructInterfaceClosures`. The binding constraint is the
/// interface-members loop above it. The worry was the closure: an interface
/// bound is answered through `ImplementsInterface`, which reads a class's
/// own interface list. Traced by moving the flush up to immediately after the
/// interface loop, rebuilding, and compiling both inherited shapes — through a
/// BASE CLASS and through a BASE INTERFACE. Both stay green at either boundary,
/// because the walk follows `BaseClass` itself and asks
/// `SelfAndAllBaseInterfaces()`. The later point is kept as the
/// conservative one and both shapes are green rows, so moving either boundary
/// is caught here rather than by a user.
///
/// <b>Blast radius.</b> This turns previously-compiling code into an
/// error. The whole `.gs` corpus was swept with the fixed build: 197 files,
/// 170 of which emit an assembly under the sweep's reference set,
/// <b>0 occurrences of GS0152 and 0 of GS0580</b> — the same counts #4092
/// measured before it.
open class Issue4089And4090GsDeclaredGenericTypeClauseConstraintTests {
    /// Every construction in (cref:RefusedConstructions) reports its
    /// diagnostic at compile time — exactly once, and only that one — instead of
    /// emitting IL the CLR or ILVerify refuses.
    /// @param name The case name.
    /// @param body The G# body appended to the shared prelude.
    /// @param expectedId The diagnostic id the log must carry.
    /// @param forbiddenId The sibling id that must NOT also fire.
    @Theory
    @MemberData("RefusedConstructions")
    func AnUncheckedGsDeclaredTypeClause_IsNowRefused(name string, body string, expectedId string, forbiddenId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4089_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The OPEN and CLOSED questions are complementary per position, so
            // exactly one of them has an answer to give. Both firing would mean
            // an erased placeholder was asked a closed constraint (#4016/#4031)
            // or a closed argument was asked an implication.
            Assert.DoesNotContain(forbiddenId, appLog, StringComparison.Ordinal)
            // Issue #4032's lesson, inherited through #4067: assert the COUNT,
            // not the presence. A type clause is re-bound through several entry
            // points, and the deferral adds one more — the queue is drained on a
            // bag that may already hold an in-place report of the same
            // violation.
            let occurrences = appLog.Split(expectedId, StringSplitOptions.None).Length - 1
            Assert.True(
                occurrences == 1,
                (`'` + "$name" + `' must report ` + "$expectedId" + ` exactly once, saw ` + "$occurrences" + `. Log:
` + "$appLog")
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every construction in (cref:AcceptedConstructions) compiles,
    /// IL-verifies, runs and prints. These are the rows a false GS0152 or
    /// GS0580 would break.
    /// @param name The case name.
    /// @param body The G# body appended to the shared prelude.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedConstructions")
    func ACheckedGsDeclaredTypeClause_StillCompilesVerifiesAndRuns(name string, body string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4089_ok_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe")
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, Array.Empty[string]())
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The `GS0152` text at a type clause names the offending argument,
    /// the definition's parameter, and the bound — the same three facts the
    /// constructor spelling has always named, so the two spellings of one
    /// violation read identically.
    @Fact
    func TheClosedDiagnosticNamesTheArgumentTheParameterAndTheBound() {
        const Body = `class Bad : GsHandler[Unrelated] {
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4090_msg_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + Body, appPath, "/target:exe")
            Assert.Contains("GS0152", appLog, StringComparison.Ordinal)
            Assert.Contains("'Unrelated'", appLog, StringComparison.Ordinal)
            Assert.Contains("'TOptions'", appLog, StringComparison.Ordinal)
            Assert.Contains("'SchemeOptions'", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The `GS0580` text at a G#-declared generic INTERFACE names the
    /// author's own type parameter, the interface's parameter, and the bound it
    /// does not carry — identical in shape to the class case #4067 closed, which
    /// is the point: one rule, two substrates.
    @Fact
    func TheOpenDiagnosticAtAnInterfaceNamesBothParametersAndTheBound() {
        const Body = `class Holder[T] : IGsBox[T] {
    public func Unbox() T { return default(T) }
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4089_msg_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + Body, appPath, "/target:exe")
            Assert.Contains("GS0580", appLog, StringComparison.Ordinal)
            Assert.Contains("'T'", appLog, StringComparison.Ordinal)
            Assert.Contains("'TI'", appLog, StringComparison.Ordinal)
            Assert.Contains("'SchemeOptions'", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The G#-declared generics every row instantiates, plus the classes and
        /// interfaces their bounds name. Everything here is same-compilation:
        /// that is the whole point of both issues.
        private const Prelude string = (`package P
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

// A DEPENDENT bound: ` + "`" + `TB` + "`" + `'s bound names the definition's own ` + "`" + `TA` + "`" + `.
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
`)

        /// Every G#-declared generic type-clause construction that must now be
        /// refused. Each of these compiled with no diagnostic on `26df552b`.
        /// @returns Case name, the G# body appended to the prelude, the expected
        /// diagnostic id, and the id that must NOT also appear.
        func RefusedConstructions() sequence[[]object] {
            // ---- #4089: the OPEN question over a G#-declared generic INTERFACE.
            // The issue's own repro, verbatim in shape. Compiled AND IL-verified on
            // the parent; only the RUN showed the defect.
            yield[]object{"the-4089-repro-an-unforwarded-gs-declared-generic-interface-base", `class Holder[T] : IGsBox[T] {
    public func Unbox() T { return default(T) }
}

Console.WriteLine("x")`, "GS0580", "GS0152"}
            // The FIELD spelling the issue names beside it.
            yield[]object{"an-unforwarded-gs-declared-generic-interface-at-a-field-type", `class Holder[T] {
    public var B IGsBox[T]
}

Console.WriteLine("x")`, "GS0580", "GS0152"}
            // A bound that exists but does not imply the interface's declared one.
            yield[]object{"a-bound-that-does-not-imply-the-interfaces-declared-one", `class Holder[T Unrelated] {
    public var B IGsBox[T]
}

Console.WriteLine("x")`, "GS0580", "GS0152"}
            // THE THIRD WITNESS, and the one neither issue mentions: the CLASS case
            // was already wired, but the answer depended on SOURCE ORDER. A field
            // type is not ordered by `AddBaseFirst`, so a definition declared BELOW
            // its use had not resolved its own bound and was silently accepted. The
            // identical program with `GsLate` declared ABOVE reported GS0580 on the
            // parent — measured both ways, which is what makes this the same hole
            // rather than a second one.
            yield[]object{"a-definition-declared-below-the-field-that-uses-it", `class Unf[T] {
    public var F GsLate[T]
}

open class GsLate[TL SchemeOptions] {
    public var Tag string = "late"
}

Console.WriteLine("x")`, "GS0580", "GS0152"}
            // ---- #4090: the CLOSED question, everywhere.
            // The issue's own repro, base-clause half.
            yield[]object{"the-4090-repro-a-closed-violating-argument-in-a-base-clause", `class Bad : GsHandler[Unrelated] {
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            // ... and its variable-type half. This one binds AFTER the flush, on
            // the in-place path, so the row covers the other side of the latch.
            yield[]object{
                "the-4090-repro-a-closed-violating-argument-at-a-variable-type",
                "var f GsHandler[Unrelated]\nConsole.WriteLine(\"x\")",
                "GS0152",
                "GS0580"
            }
            yield[]object{"a-closed-violating-argument-at-a-field-type", `class Holder {
    public var H GsHandler[Unrelated]
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            yield[]object{"a-closed-violating-argument-at-a-return-type", `func take() GsHandler[Unrelated] {
    return nil
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            // Inside a method BODY, which binds through a freshly derived scope
            // chain and therefore takes the in-place path rather than the queue.
            yield[]object{"a-closed-violating-argument-inside-a-method-body", `class Holder {
    public func M() {
        var local GsHandler[Unrelated]
        Console.WriteLine("no")
    }
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            // The G#-declared generic INTERFACE, closed. #4089's site asking
            // #4090's question.
            yield[]object{"a-closed-violating-argument-at-a-gs-declared-generic-interface", `class Holder {
    public var B IGsBox[Unrelated]
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            // NESTED inside another construction: the inner clause is bound by the
            // same recursive walk, so it is asked too.
            yield[]object{"a-closed-violating-argument-nested-inside-another-construction", `class Holder {
    public var N GsList[GsHandler[string]]
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            // The QUALIFIED spelling, which reaches
            // `BindAndConstructUserGenericSegment` rather than
            // `BindNonNullableTypeClause`. Both sites are wired; this is the row
            // that says so.
            yield[]object{"a-closed-violating-argument-at-a-qualified-name", `class Holder {
    public var Q P.GsHandler[string]
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            // A SPECIAL constraint, closed: `SchemeOptions` is a class, so it does
            // not satisfy `struct`.
            yield[]object{"a-closed-argument-violating-a-special-constraint", `class Holder {
    public var S GsStruct[SchemeOptions]
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
            // A DEPENDENT bound (#4043), closed — the shape that only has an answer
            // once the BOUNDING parameter's own argument is known, which is why the
            // checker maps the whole vector before asking any position.
            yield[]object{"a-closed-argument-violating-a-dependent-bound", `class Holder {
    public var P GsPair[SchemeOptions, Unrelated]
}

Console.WriteLine("x")`, "GS0152", "GS0580"}
        }

        /// Every shape the two rules must NOT reject. A false GS0152 or GS0580 is a
        /// worse defect than either of the ones being fixed, and this table is what
        /// stands between the change and one.
        /// @returns Case name, the G# body appended to the prelude, expected stdout lines.
        func AcceptedConstructions() sequence[[]object] {
            // #4089's own control: the forwarded spelling.
            yield[]object{"the-4089-control-a-forwarded-gs-declared-generic-interface", `class Holder[T SchemeOptions] : IGsBox[T] {
    public func Unbox() T { return default(T) }
}

Console.WriteLine(Holder[SchemeOptions]().Unbox() == nil)`, []string{"True"}}
            // ... at a field type too.
            yield[]object{"a-forwarded-gs-declared-generic-interface-at-a-field-type", `class Holder[T SchemeOptions] {
    public var B IGsBox[T]
}

Console.WriteLine("x")`, []string{"x"}}
            // #4090's own control: the satisfied closed spelling.
            yield[]object{"the-4090-control-a-satisfied-closed-argument-in-a-base-clause", `class Good : GsHandler[SchemeOptions] {
}

Console.WriteLine(Good().Tag)`, []string{"g"}}
            // A DERIVED argument satisfies a base-class bound.
            yield[]object{"a-derived-closed-argument-satisfies-a-base-class-bound", `class Good : GsHandler[DerivedOptions] {
}

var alsoOk GsHandler[DerivedOptions]
Console.WriteLine(Good().Tag)`, []string{"g"}}
            // The definition declared BELOW its satisfied use — the mirror of the
            // red source-order row, so the deferral is shown to accept as well as
            // reject independently of order.
            yield[]object{"a-definition-declared-below-its-satisfied-use", `class Holder {
    public var F GsLate[SchemeOptions]
}

open class GsLate[TL SchemeOptions] {
    public var Tag string = "late"
}

Console.WriteLine(GsLate[SchemeOptions]().Tag)`, []string{"late"}}
            // FLUSH BOUNDARY, arm 1: the implementation is inherited from a BASE
            // CLASS. Green at both candidate flush points (traced); the row exists
            // so a future move of the boundary is caught.
            yield[]object{"an-interface-bound-satisfied-through-a-base-class", `class Uses : GsBoxed[ViaBaseClass] {
}

Console.WriteLine(Uses().Tag)`, []string{"b"}}
            // FLUSH BOUNDARY, arm 2: the bound interface is reached through a BASE
            // INTERFACE, whose own base list is populated only when the interface's
            // members bind.
            yield[]object{"an-interface-bound-satisfied-through-a-base-interface", `class Uses : GsBoxed[ViaBaseInterface] {
}

Console.WriteLine(Uses().Tag)`, []string{"b"}}
            // A satisfied DEPENDENT bound, the green half of the vector-wide
            // substitution.
            yield[]object{"a-satisfied-dependent-bound", `class Holder {
    public var P GsPair[SchemeOptions, DerivedOptions]
}

Console.WriteLine(GsPair[SchemeOptions, DerivedOptions]().Tag)`, []string{"pair"}}
            // CRTP over a G#-declared generic INTERFACE bound — the shape #2519's
            // lifecycle exists to keep working, now that #4089 asks a question at
            // that site at all.
            yield[]object{"a-crtp-interface-bound-over-a-gs-declared-interface", `interface ICmp[TC ICmp[TC]] {
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

Console.WriteLine(NodeBag().Label)`, []string{"bag"}}
            // An unconstrained definition asks nothing of a closed argument.
            yield[]object{"an-unconstrained-definition-accepts-any-closed-argument", `class Holder {
    public var L GsList[Unrelated]
}

Console.WriteLine(GsList[Unrelated]().Tag)`, []string{"l"}}
            // A SAME-COMPILATION class at an IMPORTED interface bound, TYPE-CLAUSE
            // spelling. These three rows were briefly withdrawn from this fixture,
            // and the round trip is worth recording. A same-compilation class has
            // no CLR type while binding, so the bare reflective probe answered "no"
            // for `class D : IDisposable` at `[TD IDisposable]`. Filed from this
            // site as #4136 and closed as a DUPLICATE of #4124, which PR #4138
            // fixes at the shared leaf: the reflective body split out of
            // `SatisfiesClrInterfaceConstraint`, the symbolic walk wrapping EVERY
            // exit, and `BoundCarriesClrInterface` plus the two caller-side copies
            // DELETED. This arm already called `SatisfiesClrInterfaceConstraint`,
            // so it inherits the repair with no routing at all, and #4136's own
            // proposed fix — a FIFTH copy of that fallback — stopped being
            // expressible rather than getting written.
            //
            // The rows stay because the SPELLING is this change's, not #4124's:
            // #4124's repro is a generic method call and a constructor, and the
            // type clause is the position #4090 newly brings under the predicate at
            // all. Dropping the interim repair measured exactly these three red and
            // NOTHING else — 28/31, all fourteen refusals unchanged — so the
            // interface widening neither loosens nor tightens anything this fixture
            // asserts in either direction.
            yield[]object{"a-source-class-satisfies-the-imported-interface-it-implements", `class Uses : GsDisposable[DisposableSource] {
}

Console.WriteLine(Uses().Tag)`, []string{"d"}}
            // ... and the imported-BASE arm: the interface arrives through an
            // imported base class, which a source class holds in its own slot.
            yield[]object{"a-source-class-satisfies-the-interface-its-imported-base-carries", `class Uses : GsEnumerable[EnumerableSource] {
}

Console.WriteLine(Uses().Tag)`, []string{"e"}}
            // PREREQUISITE FIX (#4139), type-clause spelling: a SAME-COMPILATION
            // enum is a non-nullable value type, so it satisfies `struct` — and
            // `unmanaged`, which the `struct` check gates. Without this the very
            // first fixture #4090's enforcement touched
            // (Issue2390NullableSameCompilationEnumBoxingEmitTests) went red.
            yield[]object{"a-source-enum-satisfies-a-struct-constraint", `class Uses {
    public var S GsStruct[Color]
    public var U GsUnmanaged[Color]
}

Console.WriteLine(GsStruct[Color]().Tag + GsUnmanaged[Color]().Tag)`, []string{"su"}}
            // ... and at a G#-declared generic INTERFACE implementation, which is
            // the shape #2390's own fixture writes.
            yield[]object{"a-source-enum-satisfies-a-struct-constraint-at-an-interface-implementation", `class Source : IEnumSource[Color] {
    func Find() Color? -> Color.Blue
}

let s IEnumSource[Color] = Source{}
Console.WriteLine(s.Find())`, []string{"Blue"}}
            // The CONSTRUCTOR spelling of the imported-interface bound, which is
            // what proves that defect was PRE-EXISTING rather than introduced here.
            // `OverloadResolver.Constructors` is untouched by this change and
            // reported a false GS0152 on the `main` this branch started from; it
            // passes here because #4124's consolidation fixed the shared leaf
            // underneath it, with none of this change's code in the path.
            yield[]object{"the-constructor-spelling-of-a-source-class-carrying-an-imported-interface", `let a = GsDisposable[DisposableSource]()
let b = GsEnumerable[EnumerableSource]()
Console.WriteLine(a.Tag + b.Tag)`, []string{"de"}}
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
