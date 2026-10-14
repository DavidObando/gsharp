// <copyright file="Issue4070ImportedGenericMethodClassBoundTests.cs" company="GSharp">
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

/// Issue #4070: an imported generic METHOD constrained to an interface, called
/// with a type argument that is a type parameter whose bound is a CLASS
/// implementing that interface.
/// @remarks <b>The defect.</b> `Probes.NeedsDisposable[T]()` inside
/// `func callIt[T DisposableBase]()` reported
/// `GS0159: Cannot find function NeedsDisposable.` — measured on
/// `origin/main` @ `7708be7d` before anything was written. `T`'s
/// own bound is `DisposableBase`, which implements
/// `System.IDisposable`, so `T` satisfies
/// `where T : IDisposable` in every instantiation; `csc` accepts the
/// C# equivalent. Because the candidate was FILTERED out of overload
/// resolution rather than diagnosed, the author saw a "cannot find function"
/// where the real answer was "the constraint is satisfied".
///
/// <b>Root cause, and why one rule now serves both askers.</b> The
/// question "does this type parameter satisfy an interface constraint" is asked
/// in exactly TWO places, enumerated by #4070 and re-measured here:
/// `ClrOverloadResolution.TypeParameterSatisfiesClrBound` (generic TYPE
/// construction, #4037's `GS0580`) walked the parameter's
/// `ClassConstraint` chain; `SatisfiesDeclaredConstraints`' #2617 arm
/// (generic METHOD resolution, since #750/ADR-0088) did not, because the shared
/// leaf `ErasedSymbolSatisfiesInterfaceConstraint`'s type-parameter arm
/// reads only `ClrInterfaceConstraint`/`InterfaceConstraint`. The
/// repair EXTRACTS the type-path walk into
/// `TypeParameterSatisfiesClrInterfaceBound` and calls it from the method
/// path too. The leaf is left byte-identical — it has other callers for which
/// "only the declared interface bounds" is the right meaning.
///
/// <b>The guard, which was paid for.</b> The new arm only runs when the
/// UNSUBSTITUTED constraint mentions no type parameter — the same skip the
/// generic-TYPE path applies (#4031/#4041). Without it, measured: a
/// same-compilation `class GsEq : IEquatable[GsEq]` made
/// `func callIt[T GsEq]()` bind `Probes.NeedsEquatable[T]()` over
/// `where T : IEquatable<T>`, which COMPILED and then threw
/// `System.Security.VerificationException: Method
/// HelperLib2.Probes.NeedsEquatable: type argument 'T' violates the constraint
/// of type parameter 'T'`. `IEquatable<T>` and the erased
/// `IEquatable<GsEq>` both project to
/// `IEquatable<object>`, so the walk "proved" an implication that
/// does not hold — and `csc` reports `CS0311` on the C# equivalent
/// (measured by compiling it), so the acceptance was wrong on both counts. The
/// guard is narrow: a constructed constraint whose arguments are all CONCRETE
/// (`where T : IEnumerable<string>` from `[T StringBag]`) still
/// forwards, and a self-referential bound carried by the parameter ITSELF
/// (`[T IEquatable[T]]`) is answered by the pre-existing arm that runs
/// first. All three are rows.
///
/// <b>Blast radius, which is the main event.</b>
/// `SatisfiesDeclaredConstraints` has two direct callers —
/// `SatisfiesGenericTypeConstraints` (1 call site,
/// `Binder.ReportUnsatisfiedGenericTypeConstraint`) and
/// `SatisfiesGenericConstraints` (7 call sites in
/// `ClrOverloadResolution`: the method-group probe, the closed-method
/// resolver, two inference paths, the explicit-type-argument path, and the two
/// user-value-type surrogate paths) — so EVERY imported generic method call in
/// the corpus flows through it. The new arm is MONOTONE: it can only turn a
/// `false` into a `true`, never the reverse, so no program the CLR
/// refuses becomes acceptable. What monotonicity does not by itself settle is
/// which candidate WINS once a constrained one becomes applicable, so that was
/// MEASURED on both sides rather than reasoned about: no winner moves. The
/// explicit spelling reported `GS0159` on the parent (an explicit type
/// argument removes a non-generic sibling from the candidate set entirely, so
/// there was nothing to flip) and now binds; the INFERRED spelling picks the
/// boxing `Take(object)` both before and after, which diverges from
/// `csc` and was filed as #4086 — since CLOSED, so the inferred row now
/// asserts `generic-disposable` beside the explicit one. The `.gs`
/// corpus was swept before and
/// after with a rebuilt compiler — 197 files, 170 of which emit an assembly
/// under the sweep's reference set — and the two per-file manifests (emit
/// status plus the multiset of diagnostic ids) are IDENTICAL. The four test
/// assemblies were run and the `cs2gs` code-exploder gate was run.
///
/// <b>Note 3's shape, kept as an explicit green row.</b>
/// `Task.ContinueWith[TResult](Func[Task, TResult])` — one concrete nested
/// position beside one open one — has been broken twice by rewrites of this
/// erasure gate. It is a green row here so any future edit to this checker
/// trips over it in this file too.
///
/// <b>Three gaps #4070 left open, all since closed, and their rows now
/// assert the fixed behaviour rather than the gap.</b> (1) A BASE-CLASS
/// constraint at a generic method — `Probes.NeedsScheme[T]()` under
/// `where T : SchemeOptions` from inside
/// `func callIt[T SchemeOptions]()` — was refused for the same reason one
/// bound-kind over, on the loop's non-interface FALLTHROUGH, the path every
/// base-class constraint of every imported generic method takes. Filed as
/// #4083 and closed by extracting the generic-TYPE path's class-chain walk and
/// calling it from the method path too; see
/// (cref:AClassBoundForwardsABaseClassConstraintAtAGenericMethod).
/// (2) A DEPENDENT bound (`[TBase DisposableBase, TDerived TBase]`)
/// forwards the interface just as well, and `csc` accepts it — but
/// NEITHER walk read `TypeParameterSymbol.TypeParameterBound`, so the
/// generic-TYPE path refused it too (measured: `GS0580`). Filed as #4084
/// and closed by giving both walks #4067's
/// `Binder.EnumerateForwardedParameterChain`; see
/// (cref:ADependentBoundForwardsTheBoundingParametersConstraints).
/// (3) An INFERRED call picked the boxing `Take(object)` where `csc`
/// picks the constrained `Take<T>(T)` — measured identical before
/// and after #4070, so it was surfaced by the blast-radius measurement rather
/// than caused by it. Filed as #4086, and CLOSED by the erased-type-parameter
/// identity fix; the row below now asserts the same answer for both
/// spellings.
open class Issue4070ImportedGenericMethodClassBoundTests {
    /// A type parameter whose CLASS bound implements the imported interface now
    /// binds at an imported generic METHOD, compiles, IL-verifies and runs —
    /// matching the generic-TYPE path and `csc`.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("NowBinding")
    func AClassBoundForwardsAnImportedInterfaceAtAGenericMethod(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4070_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal(expectedLines, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A bound that does not prove the interface is still refused — the fix is
    /// monotone in the satisfaction direction only, and never starts accepting
    /// what the CLR would refuse.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @MemberData("StillRefused")
    func ABoundThatDoesNotProveTheInterface_IsStillRefused(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4070_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // Assert the COUNT, not the presence: the generic-receiver
            // resolvers are backtracking probes, so a per-call report turns one
            // violation into several identical errors and the count becomes a
            // function of how many internal paths the binder took.
            let occurrences = appLog.Split("GS0159", StringSplitOptions.None).Length - 1
            Assert.True(occurrences == 1, (`'` + "$name" + `' must report GS0159 exactly once, saw ` + "$occurrences" + `. Log:
` + "$appLog"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4084, CLOSED: a DEPENDENT bound
    /// (`[TBase DisposableBase, TDerived TBase]`) forwards the bounding
    /// parameter's whole constraint set, so `TDerived` carries
    /// `IDisposable` and `SchemeOptions` just as `TBase` does —
    /// on the generic-METHOD path and the generic-TYPE path alike.
    /// @remarks <b>What was measured on the parent</b> (`origin/main` @
    /// `26df552b`, rebuilt `gsc`): the method spelling reported
    /// `GS0159 Cannot find function NeedsDisposable.` — FILTERED out of
    /// overload resolution — while the type spelling reported #4037's
    /// `GS0580`, so the two paths gave two DIFFERENT wrong answers to one
    /// question. `csc` accepts both:
    /// `TDerived : TBase : DisposableBase : IDisposable` holds in every
    /// instantiation.
    ///
    /// <b>The repair.</b> Both askers now walk
    /// (cref:GSharp.Core.CodeAnalysis.Binding.Binder.EnumerateForwardedParameterChain)
    /// — #4067's existing symbol walk, made `internal` — instead of each
    /// carrying its own narrower chain that read only `ClassConstraint`.
    /// It follows `TypeParameterBound` as well, and terminates on a
    /// visited set rather than a depth limit.
    ///
    /// <b>The base-class half is here too.</b> #4084's table calls the
    /// base-class-through-a-dependent-bound cell closed by #4102, and that is
    /// true of the G#-DECLARED generic `SatisfiesClassConstraint` serves.
    /// The IMPORTED generic type goes through
    /// `ClrOverloadResolution` instead, and was measured STILL red on the
    /// parent — `class Fwd[TBase SchemeOptions, TDerived TBase] :
    /// SchemeConstrained[TDerived]` reported `GS0580`. It is a row
    /// here, and a correction is posted on the issue.
    ///
    /// The DIRECT-bound spelling stays green beside them as the thing
    /// this must not break.
    @Fact
    func ADependentBoundForwardsTheBoundingParametersConstraints() {
        const Dependent = `package P
import System
import HelperLib2

func callIt[TBase DisposableBase, TDerived TBase]() string {
    return Probes.NeedsDisposable[TDerived]()
}

Console.WriteLine(callIt[DisposableBase, DisposableBase]())`
        const DependentAtAType = `package P
import System
import HelperLib2

class Forwarded[TBase DisposableBase, TDerived TBase] : DisposableConstrained[TDerived] {
}

Console.WriteLine(Forwarded[DisposableBase, DisposableBase]().Tag)`
        const DependentBaseClassAtAType = `package P
import System
import HelperLib2

class Forwarded[TBase SchemeOptions, TDerived TBase] : SchemeConstrained[TDerived] {
}

Console.WriteLine(Forwarded[SchemeOptions, SchemeOptions]().Tag)`
        const Direct = `package P
import System
import HelperLib2

func callIt[TBase DisposableBase]() string {
    return Probes.NeedsDisposable[TBase]()
}

Console.WriteLine(callIt[DisposableBase]())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4070_dep_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            for (name, source, expected) in[](string, string, string){
                ("Dependent", Dependent, "method-ok"),
                ("DependentAtAType", DependentAtAType, "i"),
                ("DependentBaseClassAtAType", DependentBaseClassAtAType, "s"),
                ("Direct", Direct, "method-ok")
            } {
                let path = Path.Combine(tempDir, name + ".dll")
                let log = Compile(tempDir, name + ".gs", source, path, "/target:exe", "/reference:" + libPath)
                Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
                Assert.DoesNotContain("GS0159", log, StringComparison.Ordinal)
                Assert.DoesNotContain("GS0580", log, StringComparison.Ordinal)
                Assert.True(File.Exists(path), (`'` + "$name" + `' must compile. Log:
` + "$log"))
                IlVerifier.Verify(path, []string{libPath})
                let (exit, output) = RunDotnet(path)
                Assert.True(exit == 0, (`'` + "$name" + `' must run. Exit ` + "$exit" + `:
` + "$output"))
                Assert.Equal(expected, output.Trim())
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Review finding (#4084): a LONG dependent chain is followed to its end.
    /// The shared walk carried a 32-element cap on top of its visited set, so
    /// a 40-link chain was TRUNCATED and its terminal bound reported
    /// unforwarded.
    /// @remarks The cap was belt-and-braces that turned out to be lossy, and it
    /// was load-bearing on a path it had not been on before: consolidating
    /// both askers onto `Binder.EnumerateForwardedParameterChain` gave
    /// the imported generic paths that walk's limit. Measured on this branch's
    /// parent `b4478875` and before the removal — a 40-link chain
    /// reported `GS0159` at an imported generic method (both the
    /// base-class and the interface bound) and `GS0580` at an imported
    /// generic type, while the 5-link control bound in all three.
    ///
    /// The cap was never needed for termination:
    /// `AddForwardedParameter` refuses a parameter already in the set, so
    /// the walk visits each DISTINCT parameter at most once and terminates on
    /// any graph, cyclic or not. A cycle is separately rejected at declaration
    /// by `GS0581`. The membership test is now a hash set on reference
    /// identity, so removing the bound does not make the walk quadratic.
    ///
    /// All three shapes are rows, at 40 links — comfortably past the old
    /// 32 — with the 5-link control beside them so a regression that broke
    /// SHORT chains would be caught too.
    @Fact
    func ALongDependentChainIsFollowedToItsEnd() {
        const Links = 40
        let tempDir = Directory.CreateTempSubdirectory("gs_4070_chain_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            for links in[]int32{5, Links} {
                for (name, source, expected) in[](string, string, string){
                    ("MethodClassBound", DependentChainMethod(links, "SchemeOptions", "NeedsScheme"), "scheme-ok"),
                    (
                        "MethodInterfaceBound",
                        DependentChainMethod(links, "DisposableBase", "NeedsDisposable"),
                        "method-ok"
                    ),
                    ("TypeConstruction", DependentChainType(links), "s")
                } {
                    let caseName = name + links.ToString()
                    let path = Path.Combine(tempDir, caseName + ".dll")
                    let log = Compile(tempDir, caseName + ".gs", source, path, "/target:exe", "/reference:" + libPath)
                    Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
                    Assert.DoesNotContain("GS0159", log, StringComparison.Ordinal)
                    Assert.DoesNotContain("GS0580", log, StringComparison.Ordinal)
                    Assert.True(
                        File.Exists(path),
                        (`a ` + "$links" + `-link dependent chain must bind at '` + "$name" + `'. Log:
` + "$log")
                    )
                    IlVerifier.Verify(path, []string{libPath})
                    let (exit, output) = RunDotnet(path)
                    Assert.True(exit == 0, (`'` + "$caseName" + `' must run. Exit ` + "$exit" + `:
` + "$output"))
                    Assert.Equal(expected, output.Trim())
                }
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The overload question, measured rather than reasoned about: BOTH
    /// spellings of one call now pick the constrained generic candidate, which
    /// is what `csc` picks for both (issue #4086).
    /// @remarks Monotonicity says no program the CLR refuses is newly accepted; it
    /// does not by itself say which candidate wins once a constrained one
    /// becomes applicable, and that is the one risk a monotone widening of an
    /// overload-resolution filter genuinely carries. Measured with rebuilt
    /// compilers at each step:
    ///
    /// ```xmldoc
    /// <list type="table">
    /// <item><description><c>Take[T](v)</c> explicit — <c>csc</c>
    /// <c>generic-disposable</c>; before #4070 <c>GS0159</c>; since #4070
    /// <c>generic-disposable</c>. An explicit type argument removes the
    /// non-generic <c>Take(object)</c> from the candidate set entirely, so
    /// there was no winner to flip.</description></item>
    /// <item><description><c>Take(v)</c> inferred — <c>csc</c>
    /// <c>generic-disposable</c>; before this change <c>object</c>, because
    /// the caller's <c>T</c> erased to <c>System.Object</c> and both
    /// candidates then looked like identity conversions; here
    /// <c>generic-disposable</c>. This is the row #4086 filed, and flipping it
    /// is the acceptance test for that issue.</description></item>
    /// </list>
    /// ```
    ///
    /// The two spellings of one call now agree with each other and with
    /// `csc`, which is exactly what #4086 asked for.
    @Fact
    func TheConstrainedOverloadIsReachedAndBothSpellingsAgree() {
        const Explicit = `package P
import System
import HelperLib2

func callIt[T DisposableBase](value T) string {
    return Overloads.Take[T](value)
}

Console.WriteLine(callIt[DisposableBase](DisposableBase()))`
        const Inferred = `package P
import System
import HelperLib2

func callIt[T DisposableBase](value T) string {
    return Overloads.Take(value)
}

Console.WriteLine(callIt[DisposableBase](DisposableBase()))`
        let tempDir = Directory.CreateTempSubdirectory("gs_4070_ovl_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let explicitPath = Path.Combine(tempDir, "Explicit.dll")
            let explicitLog = Compile(
                tempDir,
                "Explicit.gs",
                Explicit,
                explicitPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.True(File.Exists(explicitPath), (`the explicit spelling must compile. Log:
` + "$explicitLog"))
            IlVerifier.Verify(explicitPath, []string{libPath})
            let (explicitExit, explicitOutput) = RunDotnet(explicitPath)
            Assert.True(explicitExit == 0, (`the explicit spelling must run. Exit ` + "$explicitExit" + `:
` + "$explicitOutput"))
            Assert.Equal("generic-disposable", explicitOutput.Trim())
            let inferredPath = Path.Combine(tempDir, "Inferred.dll")
            let inferredLog = Compile(
                tempDir,
                "Inferred.gs",
                Inferred,
                inferredPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.True(File.Exists(inferredPath), (`the inferred spelling must compile. Log:
` + "$inferredLog"))
            IlVerifier.Verify(inferredPath, []string{libPath})
            let (inferredExit, inferredOutput) = RunDotnet(inferredPath)
            Assert.True(inferredExit == 0, (`the inferred spelling must run. Exit ` + "$inferredExit" + `:
` + "$inferredOutput"))
            Assert.Equal("generic-disposable", inferredOutput.Trim())
            Assert.Equal(explicitOutput.Trim(), inferredOutput.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4083, CLOSED: a BASE-CLASS constraint at an imported generic
    /// method (`where T : SchemeOptions`) is forwarded by a type
    /// parameter carrying that very bound, in the imported spelling, the
    /// same-compilation spelling, and through a dependent bound.
    /// @remarks <b>What was measured on the parent</b> (`origin/main` @
    /// `26df552b`): all three reported `GS0159 Cannot find function
    /// NeedsScheme.` The failure mode is #4070's, one bound-kind over, but
    /// a different arm of the loop — the non-interface FALLTHROUGH, which
    /// every base-class constraint of every imported generic method takes. A
    /// `TypeParameterSymbol` argument matched none of the symbolic arms,
    /// so the erased `System.Object` placeholder was asked whether it
    /// derives from `SchemeOptions`, said no, and the candidate was
    /// silently FILTERED — the author saw "cannot find function" where the
    /// real answer was "the constraint is satisfied". `csc` accepts all
    /// three.
    ///
    /// <b>The repair is #4070's, symmetrically.</b> The generic-TYPE
    /// construction path has walked the parameter's own class chain since
    /// #4037; that walk is now
    /// `TypeParameterSatisfiesClrClassBound` and the method path calls
    /// the SAME one. It is deliberately NOT a call to its parent
    /// `TypeParameterSatisfiesClrBound`, whose `object`/
    /// `ValueType` early-out would be a false ACCEPT here: on this path a
    /// `System.ValueType` bound is the metadata shadow of
    /// `where T : struct`, settled by the special-constraint arms
    /// before the type-bound loop is reached.
    ///
    /// The new arm carries #4070's guard — the UNSUBSTITUTED bound must
    /// mention no type parameter — so a CRTP base bound
    /// (`where T : Base<T>`) cannot be "proved" on the erased
    /// vector. The INTERFACE spelling stays green beside these as the thing
    /// this must not break.
    @Fact
    func AClassBoundForwardsABaseClassConstraintAtAGenericMethod() {
        const ImportedBound = `package P
import System
import HelperLib2

func callIt[T SchemeOptions]() string {
    return Probes.NeedsScheme[T]()
}

Console.WriteLine(callIt[SchemeOptions]())`
        const SameCompilationBound = `package P
import System
import HelperLib2

class MyScheme : SchemeOptions {
}

func callIt[T MyScheme]() string {
    return Probes.NeedsScheme[T]()
}

Console.WriteLine(callIt[MyScheme]())`
        const DependentBound = `package P
import System
import HelperLib2

func callIt[U SchemeOptions, T U]() string {
    return Probes.NeedsScheme[T]()
}

Console.WriteLine(callIt[SchemeOptions, SchemeOptions]())`
        const InterfaceSpelling = `package P
import System
import HelperLib2

func callIt[T DisposableBase]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[DisposableBase]())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4070_base_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            for (name, source, expected) in[](string, string, string){
                ("ImportedBound", ImportedBound, "scheme-ok"),
                ("SameCompilationBound", SameCompilationBound, "scheme-ok"),
                ("DependentBound", DependentBound, "scheme-ok"),
                ("InterfaceSpelling", InterfaceSpelling, "method-ok")
            } {
                let path = Path.Combine(tempDir, name + ".dll")
                let log = Compile(tempDir, name + ".gs", source, path, "/target:exe", "/reference:" + libPath)
                Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
                Assert.DoesNotContain("GS0159", log, StringComparison.Ordinal)
                Assert.True(File.Exists(path), (`'` + "$name" + `' must compile. Log:
` + "$log"))
                IlVerifier.Verify(path, []string{libPath})
                let (exit, output) = RunDotnet(path)
                Assert.True(exit == 0, (`'` + "$name" + `' must run. Exit ` + "$exit" + `:
` + "$output"))
                Assert.Equal(expected, output.Trim())
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The generic-TYPE path and the generic-METHOD path now answer the SAME
    /// question the same way, in one program. That equality is the whole point
    /// of #4070: `class Forwarded[T DisposableBase] : DisposableConstrained[T]`
    /// bound on the parent while `Probes.NeedsDisposable[T]()` did not.
    @Fact
    func TheTypePathAndTheMethodPathNowAgree() {
        const Source = `package P
import System
import HelperLib2

func viaMethod[T DisposableBase]() string {
    return Probes.NeedsDisposable[T]()
}

func viaMethodRefused[T SchemeOptions]() string {
    return Probes.Unconstrained[T]()
}

Console.WriteLine(viaMethod[DisposableBase]())
Console.WriteLine(viaMethodRefused[SchemeOptions]())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4070_agree_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "Agree.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS0159", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`both paths must bind. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the program must run. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal([]string{"method-ok", "unconstrained-ok"}, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. The issue's own library, plus
        /// the shapes needed to exercise each arm of the walk and each rejection
        /// that must stay a rejection.
        private const LibrarySource string = (`namespace HelperLib2;

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

// Issue #4083/#4084: the BASE-CLASS twin of ` + "`" + `DisposableConstrained` + "`" + `,
// so the dependent bound can be asked of a class bound at a generic
// TYPE as well as at a generic method.
public class SchemeConstrained<T>
    where T : SchemeOptions
{
    public string Tag { get; set; } = "s";
}

// A SELF-REFERENTIAL interface bound. ` + "`" + `IEquatable<T>` + "`" + ` mentions the
// definition's own parameter, so it cannot be answered on the erased
// vector — both ` + "`" + `IEquatable<T>` + "`" + ` and a same-compilation
// ` + "`" + `IEquatable<GsEq>` + "`" + ` project to ` + "`" + `IEquatable<object>` + "`" + `.
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
}`)

        /// Every shape that must now bind, compile, IL-verify and run. Each of
        /// these reported `GS0159` on the parent unless marked as a control.
        /// @returns Case name, G# source, expected stdout lines.
        func NowBinding() sequence[[]object] {
            // THE ISSUE'S OWN REPRO, verbatim. GS0159 on the parent.
            yield[]object{"the-issues-repro-a-class-bound-forwards-an-imported-interface", `package P
import System
import HelperLib2

func callIt[T DisposableBase]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[DisposableBase]())`, []string{"method-ok"}}
            // The interface INHERITED from the bound's own base one level up. This
            // arm lands on `IsAssignableByName` over the bound's CLR type rather
            // than on the parameter's own interface list.
            yield[]object{"an-interface-inherited-from-the-bounds-base", `package P
import System
import HelperLib2

func callIt[T DerivedDisposable]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[DerivedDisposable]())`, []string{"method-ok"}}
            // A SAME-COMPILATION class bound. The bound has no CLR type during
            // binding, so the walk must fall through to
            // `ErasedSymbolSatisfiesInterfaceConstraint`'s StructSymbol arm and
            // read the symbol's own base chain.
            yield[]object{"a-same-compilation-class-bound-forwards-through-its-imported-base", `package P
import System
import HelperLib2

class MyDisp : DisposableBase {
}

func callIt[T MyDisp]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[MyDisp]())`, []string{"method-ok"}}
            // A SAME-COMPILATION class implementing the imported interface
            // DIRECTLY — the `ImplementedClrInterfaces` loop rather than the
            // `ImportedBaseType` fallback.
            yield[]object{"a-same-compilation-class-bound-implementing-the-interface-directly", `package P
import System
import HelperLib2

class MyMarker : IMarker {
}

func callIt[T MyMarker]() string {
    return Probes.NeedsMarker[T]()
}

Console.WriteLine(callIt[MyMarker]())`, []string{"marker-ok"}}
            // A SECOND interface, so the rule is not `IDisposable`-shaped. An
            // imported user-defined interface rather than a BCL one.
            yield[]object{"a-second-imported-interface-through-an-imported-class-bound", `package P
import System
import HelperLib2

func callIt[T MarkerBase]() string {
    return Probes.NeedsMarker[T]()
}

Console.WriteLine(callIt[MarkerBase]())`, []string{"marker-ok"}}
            // Two DIFFERENT imported interfaces forwarded by two different class
            // bounds in one program, so the rule is not a single-shape accident
            // and one call site does not prime a cache the other reads.
            yield[]object{"two-interfaces-forwarded-by-two-class-bounds-in-one-program", `package P
import System
import HelperLib2

func viaDisposable[T DisposableBase]() string {
    return Probes.NeedsDisposable[T]()
}

func viaMarker[T MarkerBase]() string {
    return Probes.NeedsMarker[T]()
}

Console.WriteLine(viaDisposable[DisposableBase]())
Console.WriteLine(viaMarker[MarkerBase]())`, []string{"method-ok", "marker-ok"}}
            // THE OVERLOAD row. Monotonicity guarantees no program the CLR refuses
            // is newly accepted, but it does not by itself say which candidate
            // WINS once a constrained one becomes applicable, so that was measured
            // rather than reasoned about — see
            // TheConstrainedOverloadIsReachedAndBothSpellingsAgree for the full
            // before/after table. On the parent this EXPLICIT spelling
            // reported `GS0159: Cannot find function Take.` — an explicit type
            // argument removes the non-generic `Take(object)` from the candidate
            // set entirely, so there was no winner to flip — and it now picks
            // `Take[T](T)`, which is what `csc` picks for the same source
            // (measured by running it).
            yield[]object{"a-newly-reachable-constrained-overload-binds-as-csc-picks-it", `package P
import System
import HelperLib2

func callIt[T DisposableBase](value T) string {
    return Overloads.Take[T](value)
}

Console.WriteLine(callIt[DisposableBase](DisposableBase()))`, []string{"generic-disposable"}}
            // CONTROL — the #2617 shape this arm was built for: a
            // same-compilation CLASS (not a type parameter) as the type argument
            // of an interface-constrained imported generic method. Unchanged by
            // this edit; pinned so a regression in the arm's original job is
            // caught here.
            yield[]object{"control-the-2617-shape-a-same-compilation-class-argument", `package P
import System
import HelperLib2

class MyMarker2 : IMarker {
}

Console.WriteLine(Probes.NeedsMarker[MyMarker2]())`, []string{"marker-ok"}}
            // A CONSTRUCTED interface bound whose arguments are all CONCRETE. The
            // new arm is guarded on the UNSUBSTITUTED constraint mentioning no type
            // parameter, and this one does not, so it still forwards:
            // `[T StringBag]` over `StringBag : List<string>` proves
            // `where T : IEnumerable<string>`. The guard is narrow, and this row is
            // what says so.
            yield[]object{"a-constructed-interface-bound-over-concrete-arguments-still-forwards", `package P
import System
import HelperLib2

func callIt[T StringBag]() string {
    return Probes.NeedsStringSeq[T]()
}

Console.WriteLine(callIt[StringBag]())`, []string{"seq-ok"}}
            // CONTROL — a SELF-REFERENTIAL bound carried by the type parameter
            // ITSELF (`[T IEquatable[T]]`) is answered by the pre-existing arm,
            // which runs BEFORE the new one, so the guard cannot reach it. This is
            // the legitimate spelling of the shape the rejection rows refuse, and
            // it must stay green.
            yield[]object{"control-a-self-referential-bound-on-the-parameter-itself-still-forwards", `package P
import System
import HelperLib2

func callIt[T IEquatable[T]]() string {
    return Probes.NeedsEquatable[T]()
}

Console.WriteLine(callIt[MyEq]())`, []string{"eq-ok"}}
            // CONTROL — an UNCONSTRAINED imported generic method called with a
            // type parameter. The commonest shape in the corpus; it must not have
            // acquired an answer it did not have.
            yield[]object{"control-an-unconstrained-imported-generic-method", `package P
import System
import HelperLib2

func callIt[T]() string {
    return Probes.Unconstrained[T]()
}

Console.WriteLine(callIt[string]())`, []string{"unconstrained-ok"}}
            // CONTROL — note 3's shape. `Task.ContinueWith[TResult](Func[Task,
            // TResult])` has one concrete nested position beside one open one, and
            // a per-position rewrite of this erasure gate has broken it TWICE.
            // Green here so any future edit to this checker trips over it in this
            // file too.
            yield[]object{"control-task-continuewith-keeps-its-one-concrete-and-one-open-position", `package P
import System
import System.Threading.Tasks

let t = Task.CompletedTask
let c = t.ContinueWith[string](func(prev Task) string { return "cw" })
Console.WriteLine(c.Result)`, []string{"cw"}}
            // CONTROL — a generic method whose constraint is satisfied through the
            // type parameter's own INTERFACE bound, which is the path that already
            // worked. It must keep working: the new arm runs only after the
            // existing one has declined.
            yield[]object{"control-an-interface-bound-still-forwards-directly", `package P
import System
import HelperLib2

func callIt[T IMarker]() string {
    return Probes.NeedsMarker[T]()
}

Console.WriteLine(callIt[MarkerBase]())`, []string{"marker-ok"}}
        }

        /// Every shape the checker must keep refusing. A class bound proves only
        /// the interfaces that class actually implements, so an unrelated bound
        /// (or none) is still not a forwarding.
        /// @returns Case name, G# source.
        func StillRefused() sequence[[]object] {
            // No bound at all. `T` can be `int32`, which is not `IDisposable`.
            yield[]object{"an-unconstrained-type-parameter-forwards-nothing", `package P
import System
import HelperLib2

func callIt[T]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[DisposableBase]())`}
            // A class bound that implements a DIFFERENT interface.
            yield[]object{"a-class-bound-implementing-a-different-interface", `package P
import System
import HelperLib2

func callIt[T MarkerBase]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[MarkerBase]())`}
            // A class bound implementing NO interface at all.
            yield[]object{"a-class-bound-implementing-no-interface", `package P
import System
import HelperLib2

func callIt[T SchemeOptions]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[SchemeOptions]())`}
            // A SAME-COMPILATION class bound implementing nothing. The symbolic
            // arm of the walk must decline as firmly as the reflective one.
            yield[]object{"a-same-compilation-class-bound-implementing-nothing", `package P
import System
import HelperLib2

class Plain {
}

func callIt[T Plain]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[Plain]())`}
            // A SELF-REFERENTIAL interface bound reached through an IMPORTED class
            // bound. `[T MyEq]` proves `IEquatable[MyEq]`, NOT `IEquatable[T]` for
            // every subtype of `MyEq` — `IEquatable<T>` is invariant. `csc` reports
            // `CS0311` on the C# equivalent (measured by compiling it), so this
            // must stay refused.
            yield[]object{"a-self-referential-interface-bound-through-an-imported-class-bound", `package P
import System
import HelperLib2

func callIt[T MyEq]() string {
    return Probes.NeedsEquatable[T]()
}

Console.WriteLine(callIt[MyEq]())`}
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
            yield[]object{"a-self-referential-interface-bound-through-a-same-compilation-class-bound", `package P
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

Console.WriteLine(callIt[GsEq]())`}
            // The same skip one interface over, so it is not `IEquatable`-shaped.
            yield[]object{"a-self-referential-comparable-bound-through-an-imported-class-bound", `package P
import System
import HelperLib2

func callIt[T MyCmp]() string {
    return Probes.NeedsComparable[T]()
}

Console.WriteLine(callIt[MyCmp]())`}
            // An INTERFACE bound that is not the one the definition asks for.
            yield[]object{"an-interface-bound-that-is-the-wrong-interface", `package P
import System
import HelperLib2

func callIt[T IMarker]() string {
    return Probes.NeedsDisposable[T]()
}

Console.WriteLine(callIt[MarkerBase]())`}
            // Issue #4083's negatives. An UNBOUND parameter proves nothing, so the
            // new base-class arm must not admit it.
            yield[]object{"an-unbound-parameter-does-not-forward-a-base-class-constraint", `package P
import System
import HelperLib2

func callIt[T]() string {
    return Probes.NeedsScheme[T]()
}

Console.WriteLine(callIt[SchemeOptions]())`}
            // A class bound that is not the base class the definition asks for.
            yield[]object{"a-class-bound-that-is-the-wrong-base-class", `package P
import System
import HelperLib2

func callIt[T DisposableBase]() string {
    return Probes.NeedsScheme[T]()
}

Console.WriteLine(callIt[DisposableBase]())`}
            // Issue #4084's negative. A dependent bound forwards the bounding
            // parameter's constraints and NOTHING ELSE, so a chain that ends in a
            // class implementing the wrong interface is still refused.
            yield[]object{"a-dependent-bound-whose-chain-does-not-reach-the-interface", `package P
import System
import HelperLib2

func callIt[TBase MarkerBase, TDerived TBase]() string {
    return Probes.NeedsDisposable[TDerived]()
}

Console.WriteLine(callIt[MarkerBase, MarkerBase]())`}
        }

        /// Builds `func callIt[T0 root, T1 T0, … Tn Tn-1]()` calling the
        /// named imported probe with the LAST parameter, so the bound is only
        /// reachable by walking the whole chain.
        /// @param links The number of dependent links after the root.
        /// @param rootBound The root parameter's class bound.
        /// @param probe The imported probe to call.
        /// @returns The G# source.
        private func DependentChainMethod(links int32, rootBound string, probe string) string {
            let parameters = StringBuilder("T0 ").Append(rootBound)
            let arguments = StringBuilder(rootBound)
            for var i = 1; i <= links; i++ {
                parameters.Append(", T").Append(i).Append(" T").Append(i - 1)
                arguments.Append(", ").Append(rootBound)
            }
            return (`package P
import System
import HelperLib2

func callIt[` + "$parameters" + `]() string {
    return Probes.` + "$probe" + `[T` + "$links" + `]()
}

Console.WriteLine(callIt[` + "$arguments" + `]())`)
        }

        /// The generic-TYPE spelling of (cref:DependentChainMethod): the
        /// chain's last parameter is the argument of an imported constrained
        /// generic type.
        /// @param links The number of dependent links after the root.
        /// @returns The G# source.
        private func DependentChainType(links int32) string {
            let parameters = StringBuilder("T0 SchemeOptions")
            let arguments = StringBuilder("SchemeOptions")
            for var i = 1; i <= links; i++ {
                parameters.Append(", T").Append(i).Append(" T").Append(i - 1)
                arguments.Append(", SchemeOptions")
            }
            return (`package P
import System
import HelperLib2

class Fwd[` + "$parameters" + `] : SchemeConstrained[T` + "$links" + `] {
}

Console.WriteLine(Fwd[` + "$arguments" + `]().Tag)`)
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

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
