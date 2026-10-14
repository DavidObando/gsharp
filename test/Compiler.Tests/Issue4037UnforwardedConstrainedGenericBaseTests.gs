// <copyright file="Issue4037UnforwardedConstrainedGenericBaseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4037: a generic declaration that names its OWN type parameter as the
/// type argument of a CONSTRAINED imported generic, without forwarding the
/// bound.
/// @remarks <b>The defect.</b> `class Unforwarded[T] : Handler[T]` over
/// `Handler<TOptions> where TOptions : SchemeOptions` compiled with
/// no diagnostic, and the emitted `extends` row named an instantiation
/// that is not provably valid for every `T`:
/// `[IL]: Error [UnsatisfiedMethodParentInst]:
/// [P.Unforwarded`1::.ctor()][offset 0x00000001] [found
/// [HelperLib2]HelperLib2.Handler`1<T0>] Method parent instantiation has
/// unsatisfied class type parameter constraints.` Re-measured on the
/// parent before anything was written.
///
/// <b>Why #4032's check could not see it, and where this one lives.</b>
/// #4032 asks "does this ARGUMENT satisfy the bound", which only a CLOSED
/// instantiation can answer — an argument that still mentions a type parameter
/// is erased to an `object` placeholder, and asking a constraint of a
/// placeholder is exactly how #4016's projection broke constraint satisfaction
/// for a SIBLING parameter (#4031's repair). `Handler[T]` is OPEN, so that
/// check correctly declines it. The question that DOES have an answer is a
/// different one: `T` stands for every type its own bounds admit, so the
/// instantiation is valid exactly when `T`'s constraint set IMPLIES the
/// definition's. The check therefore lives beside #4032's, in
/// `Binder.ReportUnsatisfiedGenericTypeConstraint`, on the branch that
/// used to `return false` for an open vector — one shared entry point, so
/// every construction site inherits the rule at once.
///
/// <b>The C# rule, measured rather than assumed.</b> The issue attributes
/// this to `CS0311`. `csc` actually reports <b>CS0314</b> — "The type
/// 'T' cannot be used as type parameter 'TOptions' … There is no boxing
/// conversion or type parameter conversion from 'T' to
/// 'HelperLib2.SchemeOptions'" — because CS0311 is the CONCRETE-argument case,
/// which G# already spells `GS0152` (#4032). Measured against
/// `csc` on this very library. The same measurement decided the SCOPE:
/// `csc` reports CS0314 at a base clause, a field type, a local
/// declaration, an interface list entry and a return type alike, which is why
/// the rule sits at the shared construction sites and not in the base-clause
/// binder.
///
/// <b>What is still not asked.</b> Only a type argument that IS a type
/// parameter. A composite open shape (`Handler[List[T]]`) has no
/// forwarding question and is skipped exactly as before, and so is a position
/// whose declared bound MENTIONS another of the definition's own parameters —
/// #4031's dependent-bound shape, where a placeholder answer is precisely what
/// goes wrong. Both are pinned as green rows below, so the skip is measured
/// rather than merely described.
///
/// <b>A class bound implies its interfaces, and the first version of
/// this rule got that wrong.</b> `[T DisposableOptions]` forwards
/// `where T : IDisposable` when `DisposableOptions : IDisposable` —
/// `csc` accepts it, and the first version reported `GS0580`, a FALSE
/// rejection of valid code. Caught in review, measured against `csc`, and
/// fixed by walking the class-constraint chain in the interface branch too.
/// Copilot's review of PR #4061 named the same defect at the same branch after
/// the walk had landed; measured on the reviewed commit, its own shape
/// (`[T DisposableBase]`) compiles, verifies and runs, and reverting only
/// that walk turns it and its three siblings into `GS0580` — so the
/// finding is a false positive, but two ARMS of the walk were genuinely
/// untested and are pinned now: an interface INHERITED from the bound's base,
/// and a same-compilation class implementing the imported interface DIRECTLY.
/// Seven green rows across the branch.
///
/// <b>The interface question is asked in exactly two places, and only
/// one of them is this rule's.</b> Enumerated rather than assumed:
/// `ClrOverloadResolution.TypeParameterSatisfiesClrBound` (this rule,
/// walks the class chain) and `SatisfiesDeclaredConstraints`' #2617 arm on
/// the imported generic METHOD path (does not). Both bottom out in the shared
/// leaf `ErasedSymbolSatisfiesInterfaceConstraint`, whose type-parameter
/// arm reads only interface bounds. The method path therefore has the same
/// blind spot — measured: `Probes.NeedsDisposable[T]()` from inside
/// `func callIt[T DisposableBase]()` reports `GS0159 Cannot find
/// function`. It is <b>pre-existing and untouched here</b> — this file's
/// whole `ClrOverloadResolution` change has ZERO deleted lines, so that
/// checker is byte-identical to the parent — and closing it means changing the
/// checker every imported generic method call in the corpus goes through.
/// Filed as #4070 rather than fixed opportunistically.
///
/// <b>Blast radius.</b> This turns previously-compiling code into an
/// error. The whole `.gs` corpus was swept before and after: 192 files,
/// 166 of which emit an assembly under the sweep's reference set,
/// <b>0 occurrences of GS0580</b>.
///
/// <b>The G#-declared gap this class pinned is CLOSED (#4067).</b> A
/// <b>G#-declared</b> constrained generic base (`class Unf[T] : GsHandler[T]`
/// where `GsHandler[TOptions SchemeOptions]` is declared in the same
/// compilation) is a different code path — closed by symbol substitution in the
/// declaration binder, never by `Type.MakeGenericType` — so it never
/// reached this check. It was pinned here as
/// `AGsDeclaredConstrainedGenericBase_IsStillNotChecked`, asserting that it
/// compiled and that ILVerify reported `UnsatisfiedMethodParentInst`. #4067
/// gave that path the symbolic twin of this rule, so the asserting row has been
/// MOVED rather than deleted: the violating spelling is
/// `issue-4067-a-gs-declared-constrained-generic-base` in
/// `UnforwardedConstraints` and the forwarded spelling is
/// `issue-4067-the-forwarded-gs-declared-constrained-base` in
/// `ForwardedAndSkippedShapes`. The full matrix is
/// `Issue4067UnforwardedGsDeclaredGenericBaseTests`.
open class Issue4037UnforwardedConstrainedGenericBaseTests {
    /// An open instantiation whose type parameter does not forward the bound
    /// now reports `GS0580` at compile time instead of emitting IL that
    /// does not verify.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("UnforwardedConstraints")
    func AnUnforwardedConstrainedGenericInstantiation_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4037_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The CLOSED check must not be the one that fired: this is an open
            // instantiation, and GS0152 here would mean the erased placeholder
            // was asked a constraint — the #4016/#4031 defect.
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            // Issue #4032's lesson, kept: assert the COUNT, not the presence.
            // The generic-receiver resolvers are backtracking probes, so a
            // per-call report turns one violation into several identical
            // errors and the count becomes a function of how many internal
            // paths the binder happened to take.
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

    /// Every forwarded spelling, and every open shape the rule deliberately
    /// does not ask about, compiles, IL-verifies, runs, and prints what it
    /// always printed.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("ForwardedAndSkippedShapes")
    func AForwardedOrSkippedInstantiation_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4037_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
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

    /// The `GS0580` text names the offending TYPE PARAMETER, the
    /// definition's own parameter, and the constraint that is not forwarded —
    /// and says what to do about it, which is what separates it from
    /// `GS0152`: the remedy is to change the DECLARATION, not the type
    /// argument.
    @Fact
    func TheDiagnosticNamesTheParameterTheBoundAndTheRemedy() {
        const Source = `package P
import System
import HelperLib2

class Unforwarded[T] : Handler[T] {
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4037_msg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Contains("GS0580", appLog, StringComparison.Ordinal)
            Assert.Contains("'T'", appLog, StringComparison.Ordinal)
            Assert.Contains("'TOptions'", appLog, StringComparison.Ordinal)
            Assert.Contains("'HelperLib2.SchemeOptions'", appLog, StringComparison.Ordinal)
            Assert.Contains("Forward the constraint", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The IL the issue reported. Before this change the unforwarded
    /// declaration emitted an assembly whose `extends` row ILVerify
    /// rejected with `UnsatisfiedMethodParentInst`; the forwarded
    /// spelling verified. Now the unforwarded one never reaches the emitter,
    /// and the forwarded one still verifies — so the pair is asserted
    /// together rather than each in isolation.
    @Fact
    func TheForwardedSpellingVerifiesAndTheUnforwardedOneNeverReachesTheEmitter() {
        const Unforwarded = `package P
import System
import HelperLib2

class Unforwarded[T] : Handler[T] {
}

Console.WriteLine("x")`
        const Forwarded = `package P
import System
import HelperLib2

class Forwarded[T SchemeOptions] : Handler[T] {
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4037_il_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let unforwardedPath = Path.Combine(tempDir, "Unforwarded.dll")
            let unforwardedLog = Compile(
                tempDir,
                "Unforwarded.gs",
                Unforwarded,
                unforwardedPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.False(
                File.Exists(unforwardedPath),
                "the unforwarded declaration must not reach the emitter — that assembly is what ILVerify " + (`rejected with UnsatisfiedMethodParentInst. Log:
` + "$unforwardedLog")
            )
            let forwardedPath = Path.Combine(tempDir, "Forwarded.dll")
            let forwardedLog = Compile(
                tempDir,
                "Forwarded.gs",
                Forwarded,
                forwardedPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.True(File.Exists(forwardedPath), (`the forwarded declaration must compile. Log:
` + "$forwardedLog"))
            IlVerifier.Verify(forwardedPath, []string{libPath})
            let (exit, output) = RunDotnet(forwardedPath)
            Assert.True(exit == 0, (`the forwarded declaration must run. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("x", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. Mirrors the issue's own
        /// library, plus the shapes needed to exercise a special constraint, an
        /// interface bound, and a DEPENDENT bound.
        private const LibrarySource string = `namespace HelperLib2;

public class SchemeOptions
{
    public string? Name { get; set; }
}

public class Handler<TOptions>
    where TOptions : SchemeOptions
{
    public string Tag { get; set; } = "t";
}

public class HandlerNew<TOptions>
    where TOptions : SchemeOptions, new()
{
    public string Tag { get; set; } = "n";
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

public class DisposableConstrained<T>
    where T : System.IDisposable
{
    public string Tag { get; set; } = "i";
}

public class ComparableConstrained<T>
    where T : System.IComparable<T>
{
    public string Tag { get; set; } = "s";
}

public interface IMarker
{
}

public class DisposableOptions : SchemeOptions, System.IDisposable
{
    public void Dispose()
    {
    }
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

public class MarkerOptions : SchemeOptions, IMarker
{
}

public class MarkerConstrained<T>
    where T : IMarker
{
    public string Tag { get; set; } = "m";
}

public class Unconstrained<T>
{
    public string Tag { get; set; } = "u";
}

public class Coupled<T, U>
    where U : System.Collections.Generic.IList<T>
{
    public string Tag { get; set; } = "coupled";
}`

        /// Every OPEN instantiation whose type parameter does not forward the
        /// bound the imported definition declares. Each of these compiled with NO
        /// diagnostic on the parent.
        /// @returns Case name, G# source, expected diagnostic id.
        func UnforwardedConstraints() sequence[[]object] {
            // THE ISSUE'S OWN REPRO. Compiled clean on the parent; ILVerify
            // reported 1x UnsatisfiedMethodParentInst.
            yield[]object{"the-issues-repro-an-unforwarded-generic-base", `package P
import System
import HelperLib2

class Unforwarded[T] : Handler[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // A FIELD type inside a generic class. `csc` reports CS0314 here too
            // (measured), and this spelling used to be a green row in
            // Issue4032ConstrainedImportedGenericBaseTests' open-instantiation
            // control.
            yield[]object{"an-unforwarded-field-type-inside-a-generic-class", `package P
import System
import HelperLib2

class Holder[T] {
    public var H Handler[T]
}

Console.WriteLine("x")`, "GS0580"}
            // A LOCAL declaration inside a generic function. The other half of
            // that former control row.
            yield[]object{"an-unforwarded-local-type-inside-a-generic-function", `package P
import System
import HelperLib2

func openLocal[T]() int32 {
    var h Handler[T]
    if h == nil { return 1 }
    return 2
}

Console.WriteLine(openLocal[SchemeOptions]())`, "GS0580"}
            // A partially-forwarded constraint set: `SchemeOptions` is forwarded,
            // `new()` is not. The rule is per-constraint, not per-bound-kind.
            yield[]object{"a-forwarded-base-bound-with-an-unforwarded-init-constraint", `package P
import System
import HelperLib2

class PartlyForwarded[T SchemeOptions] : HandlerNew[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // A SPECIAL constraint, so the message comes from the attribute mask
            // rather than from a bound type.
            yield[]object{"an-unforwarded-class-constraint", `package P
import System
import HelperLib2

class UnforwardedClass[T] : ClassConstrained[T] {
}

Console.WriteLine("x")`, "GS0580"}
            yield[]object{"an-unforwarded-struct-constraint", `package P
import System
import HelperLib2

class UnforwardedStruct[T] : StructConstrained[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // An INTERFACE bound rather than a base-class bound. Deliberately a
            // NON-dependent one (`IDisposable`, not `IComparable<T>`): a bound
            // that mentions the definition's own parameter is #4031's shape and is
            // skipped by design — that skip has its own green row below.
            yield[]object{"an-unforwarded-interface-constraint", `package P
import System
import HelperLib2

class UnforwardedDisposable[T] : DisposableConstrained[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // The DIRECT-CONSTRUCTION spelling, so the rule is not base-clause
            // only. `Handler[T]()` inside an unconstrained generic function is the
            // same open instantiation one syntax over.
            yield[]object{"an-unforwarded-constructor-call-inside-a-generic-function", `package P
import System
import HelperLib2

func make[T]() int32 {
    let h = Handler[T]()
    return 1
}

Console.WriteLine(make[SchemeOptions]())`, "GS0580"}
            // A NESTED type-argument position: the offending `Handler[T]` is
            // itself the argument of an unconstrained generic, so the OUTER
            // construction is skipped (composite open shape) while the inner type
            // clause is asked. `csc` reports CS0314 on the inner one too.
            yield[]object{"an-unforwarded-nested-type-argument", `package P
import System
import HelperLib2

class Nested[T] {
    public var U Unconstrained[Handler[T]]
}

Console.WriteLine("x")`, "GS0580"}
            // Issue #4067, CLOSED: the same shape over a G#-DECLARED constrained
            // generic base. This was the asserting row
            // `AGsDeclaredConstrainedGenericBase_IsStillNotChecked` on this class,
            // which pinned that it compiled and that ILVerify reported
            // UnsatisfiedMethodParentInst, and told whoever closed the issue to
            // move it here. Its full matrix lives in
            // Issue4067UnforwardedGsDeclaredGenericBaseTests; it stays here as the
            // row this class's own Notes promised.
            yield[]object{"issue-4067-a-gs-declared-constrained-generic-base", `package P
import System
import HelperLib2

open class GsHandler[TOptions SchemeOptions] {
    public var Tag string = "g"
}

class SchemeOptions {
    public var Name string = ""
}

class Unf[T] : GsHandler[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // A generic CLASS's own method, so the offending parameter belongs to
            // the enclosing TYPE rather than to the function.
            yield[]object{"an-unforwarded-parameter-of-the-enclosing-class", `package P
import System
import HelperLib2

class Outer[T] {
    public func take(h Handler[T]) int32 {
        return 1
    }
}

Console.WriteLine("x")`, "GS0580"}
        }

        /// Every shape that must keep binding: the FORWARDED spellings at each
        /// position, the constraint kinds that are satisfied by a forwarded bound,
        /// and the two open shapes the rule deliberately does not ask about.
        /// @returns Case name, G# source, expected stdout lines.
        func ForwardedAndSkippedShapes() sequence[[]object] {
            // THE ISSUE'S CONTROL. Green before, green after — the row this change
            // must not disturb.
            yield[]object{"the-issues-control-the-forwarded-base-still-verifies-and-runs", `package P
import System
import HelperLib2

class Forwarded[T SchemeOptions] : Handler[T] {
}

class MyOptions : SchemeOptions {
}

let f = Forwarded[MyOptions]()
Console.WriteLine(f.Tag)`, []string{"t"}}
            // Issue #4067's control, moved here beside its violation row: the
            // FORWARDED spelling of the G#-declared constrained generic base. It
            // was green before #4067 and is green after, which is the invariant
            // that fix must not break.
            yield[]object{"issue-4067-the-forwarded-gs-declared-constrained-base", `package P
import System
import HelperLib2

open class GsHandler[TOptions SchemeOptions] {
    public var Tag string = "g"
}

class SchemeOptions {
    public var Name string = ""
}

class Fwd[T SchemeOptions] : GsHandler[T] {
}

Console.WriteLine(Fwd[SchemeOptions]().Tag)`, []string{"g"}}
            // Every OTHER open position, forwarded. `csc` accepts all of these.
            yield[]object{"forwarded-field-local-parameter-and-construction", `package P
import System
import HelperLib2

class Holder[T SchemeOptions] {
    public var H Handler[T]
}

func openLocal[T SchemeOptions]() int32 {
    var h Handler[T]
    if h == nil { return 1 }
    return 2
}

func take[T SchemeOptions](h Handler[T]) string {
    return h.Tag
}

func make[T SchemeOptions]() string {
    return Handler[T]().Tag
}

Console.WriteLine(openLocal[SchemeOptions]())
Console.WriteLine(take[SchemeOptions](Handler[SchemeOptions]()))
Console.WriteLine(make[SchemeOptions]())
let hd = Holder[SchemeOptions]()
Console.WriteLine(hd.H == nil)`, []string{"1", "t", "t", "True"}}
            // The forwarded SPECIAL constraints.
            yield[]object{"forwarded-special-constraints", `package P
import System
import HelperLib2

class OkClass[T class] : ClassConstrained[T] {
}

class OkStruct[T struct] : StructConstrained[T] {
}

Console.WriteLine(OkClass[string]().Tag)
Console.WriteLine(OkStruct[int32]().Tag)`, []string{"c", "v"}}
            // A STRONGER bound satisfies a weaker one: a class-typed bound proves
            // the parameter is a reference type, so it forwards `where T : class`
            // without an explicit `class` keyword. `csc` agrees.
            yield[]object{"a-class-typed-bound-forwards-the-class-constraint", `package P
import System
import HelperLib2

class OkStronger[T SchemeOptions] : ClassConstrained[T] {
}

Console.WriteLine(OkStronger[SchemeOptions]().Tag)`, []string{"c"}}
            // A CLASS bound implies every interface that class implements, so it
            // forwards an INTERFACE constraint without naming the interface. The
            // first version of this rule reported GS0580 on all three of these —
            // a FALSE rejection of code `csc` accepts, caught in review and fixed
            // by walking the class-constraint chain in the interface branch too.
            // Three shapes, because the walk has three arms: an IMPORTED class
            // bound (read through its CLR type), a SAME-COMPILATION class bound
            // (read through its own interface list and imported base chain), and
            // an imported class bound implementing an IMPORTED interface.
            yield[]object{"a-class-typed-bound-forwards-the-interfaces-that-class-implements", `package P
import System
import HelperLib2

class MyDisposable : DisposableOptions {
}

class OkViaClassBound[T DisposableOptions] : DisposableConstrained[T] {
}

class OkViaUserClassBound[T MyDisposable] : DisposableConstrained[T] {
}

class OkViaMarker[T MarkerOptions] : MarkerConstrained[T] {
}

Console.WriteLine(OkViaClassBound[DisposableOptions]().Tag)
Console.WriteLine(OkViaUserClassBound[MyDisposable]().Tag)
Console.WriteLine(OkViaMarker[MarkerOptions]().Tag)`, []string{"i", "i", "m"}}
            // COPILOT REVIEW of PR #4061. The reviewer read the interface branch as
            // consulting only a parameter's DIRECT interface bounds and named
            // `class Forwarded[T DisposableBase] : DisposableConstrained[T]` as a
            // false rejection. Measured on the reviewed commit: it compiles,
            // IL-verifies and prints `i` — the class-constraint walk added earlier
            // in this same commit already carries it, and reverting just that walk
            // turns all four shapes below into GS0580 (measured, one build each
            // way). So the finding is a false positive AGAINST THE REVIEWED COMMIT.
            //
            // Two ARMS of the walk were nonetheless untested, and that half of the
            // finding is real. The three rows above all use a bound that reaches
            // the interface through an IMPORTED BASE (`DisposableOptions`,
            // `MyDisposable : DisposableOptions`, `MarkerOptions`). Untested were:
            // an interface INHERITED from the bound's own base one level up
            // (`DerivedDisposable`), and a SAME-COMPILATION class that implements
            // the imported interface DIRECTLY (`MyMarker : IMarker`) — which lands
            // on `ErasedSymbolSatisfiesInterfaceConstraint`'s
            // `ImplementedClrInterfaces` loop rather than its `ImportedBaseType`
            // fallback. Both are pinned here, alongside the reviewer's own shape.
            // `csc` accepts all four (measured).
            yield[]object{"review-a-class-bound-forwards-an-interface-through-every-arm-of-the-walk", `package P
import System
import HelperLib2

class MyDisp : DisposableBase {
}

class MyMarker : IMarker {
}

class Forwarded[T DisposableBase] : DisposableConstrained[T] {
}

class ViaBase[T DerivedDisposable] : DisposableConstrained[T] {
}

class ViaUserClass[T MyDisp] : DisposableConstrained[T] {
}

class ViaUserMarker[T MyMarker] : MarkerConstrained[T] {
}

Console.WriteLine(Forwarded[DisposableBase]().Tag)
Console.WriteLine(ViaBase[DerivedDisposable]().Tag)
Console.WriteLine(ViaUserClass[MyDisp]().Tag)
Console.WriteLine(ViaUserMarker[MyMarker]().Tag)`, []string{"i", "i", "i", "m"}}
            // A forwarded bound onto a SAME-COMPILATION class. The bound has no
            // CLR type of its own during binding, so the walk has to read the
            // symbol's base chain.
            yield[]object{"a-bound-onto-a-same-compilation-class-forwards-through-its-base-chain", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

class OkUser[T MyOptions] : Handler[T] {
}

Console.WriteLine(OkUser[MyOptions]().Tag)`, []string{"t"}}
            // THE UNCONSTRAINED DEFINITION. The commonest shape in the corpus:
            // an open instantiation of a generic with no bound at all must not
            // have acquired an answer.
            yield[]object{"control-an-open-instantiation-of-an-unconstrained-generic", `package P
import System
import System.Collections.Generic
import HelperLib2

class Bag[T] {
    public var Items List[T]
    public var U Unconstrained[T]
}

func each[T](items List[T]) int32 {
    return items.Count
}

let b = Bag[string]()
b.Items = List[string]()
b.Items.Add("a")
Console.WriteLine(each[string](b.Items))`, []string{"1"}}
            // THE COMPOSITE OPEN SHAPE. `Handler[List[T]]` mentions a type
            // parameter but is not one, so there is no forwarding question to ask
            // and the rule skips it — exactly as the closed check always did.
            // (`List[T]` does not derive from `SchemeOptions`, so this program is
            // wrong; it compiles, which is the pre-existing behaviour this change
            // deliberately does not alter. Pinned so a later fix sees a red row
            // rather than silence.)
            yield[]object{"control-a-composite-open-shape-is-still-skipped", `package P
import System
import System.Collections.Generic
import HelperLib2

class Composite[T] {
    public var H Handler[List[T]]
}

Console.WriteLine("compiled")`, []string{"compiled"}}
            // A DEPENDENT INTERFACE bound (`where T : IComparable<T>`) is the same
            // skip one bound-kind over, and it is the shape every self-referential
            // constraint has. Pinned green so the skip is measured.
            yield[]object{"control-a-dependent-interface-bound-is-not-asked", `package P
import System
import HelperLib2

class SelfRef[T] {
    public var C ComparableConstrained[T]
}

Console.WriteLine("compiled")`, []string{"compiled"}}
            // THE DEPENDENT BOUND (#4031/#4041's shape). `Coupled<T, U> where U :
            // IList<T>` mentions the definition's OWN first parameter, and
            // answering it needs symbol-aware substitution rather than the erased
            // vector. The rule skips such a position, so this compiles even
            // though the bound is not forwarded. Pinned so the skip is measured.
            yield[]object{"control-a-dependent-bound-is-not-asked", `package P
import System
import System.Collections.Generic
import HelperLib2

class Dependent[A, B] {
    public var C Coupled[A, B]
}

Console.WriteLine("compiled")`, []string{"compiled"}}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib2",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib2.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
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
