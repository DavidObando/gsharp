// <copyright file="Issue4067UnforwardedGsDeclaredGenericBaseTests.cs" company="GSharp">
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

/// Issue #4067: a generic declaration that names its OWN type parameter as the
/// type argument of a <b>G#-DECLARED</b> constrained generic, without
/// forwarding the bound.
/// @remarks <b>The repro, re-measured on <c>origin/main</c> @ <c>7708be7d</c>
/// before anything was written.</b> `class Unf[T] : GsHandler[T]` over
/// `open class GsHandler[TOptions SchemeOptions]` compiled with no
/// diagnostic, and the emitted `extends` row named an instantiation that
/// is not provably valid for every `T`:
/// `[IL]: Error [UnsatisfiedMethodParentInst]: [gsbase.dll :
/// P.Unf`1::.ctor()][offset 0x00000001][found [P]P.GsHandler`1<T0>]
/// Method parent instantiation has unsatisfied class type parameter
/// constraints.`
///
/// <b>Root cause, and why it is NOT #4063's.</b> #4037 put the
/// implication rule — "T stands for every type its own bounds admit, so the
/// instantiation is valid exactly when T's constraint set IMPLIES the
/// definition's", C# §13.4.3, `csc`'s CS0314 — at
/// `Binder.ReportUnsatisfiedGenericTypeConstraint`, the one entry point
/// every user-facing `Type.MakeGenericType` construction funnels through.
/// A G#-DECLARED generic is never closed that way: the type-clause binder
/// resolves it by symbol substitution at
/// `StructSymbol.Construct` / `InterfaceSymbol.Construct` and never
/// builds a CLR open definition at all, so the construction reached NO
/// constraint checker. This is therefore a MISSING CHECK on a path that had
/// none — the opposite failure from #4063, which is a wrong RELATION on a path
/// that exists. The two issues do not share a root cause; they share only the
/// symptom, IL the CLR refuses.
///
/// <b>The rule is the symbolic twin, deliberately.</b>
/// `ClrOverloadResolution.TypeParameterForwardsDeclaredConstraints` asks
/// this of a reflective `Type`;
/// `Binder.TypeParameterForwardsUserDeclaredConstraints` asks the same
/// question of `TypeParameterSymbol.ClassConstraint` /
/// `InterfaceConstraint` / `ClrInterfaceConstraint` /
/// `HasReferenceTypeConstraint` / `HasValueTypeConstraint` /
/// `HasDefaultConstructorConstraint`, and both report `GS0580`.
///
/// <b>Two walks, and the difference was measured rather than assumed.</b>
/// A TYPE bound is implied by anything the parameter is provably an instance
/// of, so it is asked of the argument AND of every bound in its chain — that is
/// what makes `[T PingOptions]` forward `[TP IPing]` when
/// `PingOptions` implements `IPing`, which is the false rejection
/// #4037's own review caught in the imported twin. A SPECIAL constraint
/// (`struct` / `class` / `init()` / `unmanaged`) is a
/// property of the PARAMETER's declaration and is asked only of the type
/// parameters in the chain: a class bound with a public parameterless
/// constructor does NOT give the parameter `init()`, and accepting it
/// there would be a false accept the CLR then refuses.
///
/// <b>The chain arm is load-bearing, and it is what made this more than a
/// call to <c>Binder.SatisfiesConstraint</c>.</b> Measured on the parent:
/// `func f[U SchemeOptions, T U]() { GsHandler[T]{…} }` already reports a
/// FALSE `GS0152` on the struct-literal path, because
/// `SatisfiesClassConstraint` propagates through `ClassConstraint`
/// and not through #4043's `TypeParameterBound` slot. The equivalent base
/// clause `class Fwd[U SchemeOptions, T U] : GsHandler[T]` compiles,
/// IL-verifies and RUNS — also measured — so reusing that predicate unchanged
/// would have turned a legal program into a GS0580. It is a green row below.
/// The pre-existing struct-literal false rejection was filed as <b>#4091</b> and
/// has since been FIXED on `main`, which taught
/// `SatisfiesClassConstraint` itself to follow the
/// `TypeParameterBound` slot. This chain walk is therefore no longer the
/// only thing standing between that row and a false rejection — but it is still
/// what carries the SPECIAL constraints and the interface arms, which
/// `SatisfiesClassConstraint` does not answer, so it stays and the row
/// stays with it.
///
/// <b>What is still not asked, and it is pinned rather than described.</b>
/// Only a type argument that IS a type parameter. A composite open shape
/// (`GsList[[]T]`) has no forwarding question, and a declared bound that
/// mentions another of the definition's own parameters is the #4031/#4041
/// dependent shape, where answering on an unsubstituted parameter is precisely
/// what goes wrong. Each is a row rather than a sentence.
///
/// <b>Two shapes this class pinned as OPEN have since been closed by
/// #4089/#4090, and their rows moved rather than being deleted.</b> A
/// G#-declared generic INTERFACE was never reached (its own parameters resolve
/// their constraints only when its members bind — #2519), and a CLOSED
/// violating argument (`class Bad : GsHandler[Unrelated]`) is the OTHER
/// question, C#'s CS0311, which G# spells `GS0152`. Both were pinned here
/// as asserting rows telling whoever closed them to move them; they now live in
/// `Issue4089And4090GsDeclaredGenericTypeClauseConstraintTests`, which also
/// carries the third witness those two issues did not name — that this rule's
/// answer used to depend on SOURCE ORDER at a field type. The repair is a
/// deferral of WHEN the question is asked, not a change to the rule this class
/// describes, so every row below is unchanged.
///
/// <b>The asserting row this issue was filed with has been moved, not
/// deleted.</b> `Issue4037UnforwardedConstrainedGenericBaseTests` pinned
/// this gap as `AGsDeclaredConstrainedGenericBase_IsStillNotChecked`,
/// asserting that the program compiled and that ILVerify reported
/// `UnsatisfiedMethodParentInst`, with a message telling whoever closed
/// the issue to move it into that class's `UnforwardedConstraints` table.
/// It is now a row there, and the forwarded spelling that stood beside it is a
/// row in that class's `ForwardedAndSkippedShapes`. This class is the issue's
/// own repro and its full matrix.
///
/// <b>Blast radius.</b> This turns previously-compiling code into an
/// error. The whole `.gs` corpus was swept before and after: 197 files,
/// 170 of which emit an assembly under the sweep's reference set,
/// <b>0 occurrences of GS0580</b>.
open class Issue4067UnforwardedGsDeclaredGenericBaseTests {
    /// An instantiation of a G#-declared constrained generic whose type
    /// parameter does not forward the bound now reports `GS0580` at
    /// compile time — exactly once — instead of emitting IL that does not
    /// verify.
    /// @param name The case name.
    /// @param body The G# body appended to the shared prelude.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("UnforwardedConstraints")
    func AnUnforwardedGsDeclaredInstantiation_IsRefused(name string, body string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4067_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The CLOSED check must not be the one that fired: this is an open
            // instantiation, and GS0152 here would mean the erased placeholder
            // was asked a constraint — the #4016/#4031 defect.
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            // Issue #4032's lesson, inherited through #4037: assert the COUNT,
            // not the presence. A type clause is re-bound through several entry
            // points, so a per-call report would turn one violation into a count
            // that is a function of how many internal paths the binder took.
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

    /// Every forwarded spelling, every implication a bound genuinely carries,
    /// and every deliberately unasked position compiles, IL-verifies, runs and
    /// prints. These are the rows a false GS0580 would break.
    /// @param name The case name.
    /// @param body The G# body appended to the shared prelude.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("ForwardedConstraints")
    func AForwardedGsDeclaredInstantiation_CompilesVerifiesAndRuns(name string, body string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4067_ok_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe")
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal)
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

    /// The `GS0580` text names the author's own type parameter, the
    /// definition's parameter whose bound it fails, and the bound itself — so
    /// the reader can see that the fix is on the DECLARATION of `T` rather
    /// than at the instantiation.
    @Fact
    func TheDiagnosticNamesBothParametersAndTheBound() {
        const Body = `class Unf[T] : GsHandler[T] {
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4067_msg_").FullName
        try {
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + Body, appPath, "/target:exe")
            Assert.Contains("GS0580", appLog, StringComparison.Ordinal)
            Assert.Contains("'T'", appLog, StringComparison.Ordinal)
            Assert.Contains("'TOptions'", appLog, StringComparison.Ordinal)
            Assert.Contains("'SchemeOptions'", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The G#-declared constrained generics every row instantiates, plus the
        /// classes and interface their bounds name. Everything here is
        /// same-compilation: that is the whole point of the issue.
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

// A DEPENDENT bound: ` + "`" + `TB` + "`" + `'s bound names the definition's own ` + "`" + `TA` + "`" + `.
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
`)

        /// Every declaration that writes its own type parameter at a G#-declared
        /// constrained position it does not forward. Each of these compiled with no
        /// diagnostic on the parent and emitted IL that ILVerify refuses.
        /// @returns Case name, the G# body appended to the prelude, expected diagnostic id.
        func UnforwardedConstraints() sequence[[]object] {
            // The issue's own repro, verbatim.
            yield[]object{"the-issues-own-repro-a-gs-declared-constrained-base", `class Unf[T] : GsHandler[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // A bound that exists but does not imply the declared one.
            yield[]object{"a-class-bound-that-does-not-imply-the-declared-one", `class Unf[T Unrelated] : GsHandler[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // An INTERFACE bound does not imply a CLASS bound.
            yield[]object{"an-interface-bound-against-a-class-bound", `class Unf[T IPing] : GsHandler[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // ... and a CLASS bound does not imply an interface the class does not
            // carry. `SchemeOptions` does not implement `IPing`; `PingOptions`
            // does, and that spelling is a green row.
            yield[]object{"a-class-bound-against-an-interface-the-class-lacks", `class Unf[T SchemeOptions] : GsPing[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // The special constraints, one row each. `csc` reports CS0314 for all
            // three, and the CLR refuses all three.
            yield[]object{"an-unforwarded-default-constructor-constraint", `class Unf[T] : GsNew[T] {
}

Console.WriteLine("x")`, "GS0580"}
            yield[]object{"an-unforwarded-reference-type-constraint", `class Unf[T] : GsClass[T] {
}

Console.WriteLine("x")`, "GS0580"}
            yield[]object{"an-unforwarded-value-type-constraint", `class Unf[T] : GsStruct[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // A class bound gives the parameter reference-ness but NOT a public
            // parameterless constructor: this is the false accept the two-walk
            // split exists to prevent, and it is a red row rather than a comment.
            yield[]object{"a-class-bound-does-not-supply-a-default-constructor", `class Unf[T SchemeOptions] : GsNew[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // Review finding (#4092): the `unmanaged` branch. `struct` is NOT
            // `unmanaged` — a value type may hold a reference — so a forwarded
            // `struct` does not carry it, and this is the row that separates the
            // two flags.
            yield[]object{"an-unforwarded-unmanaged-constraint", `class Unf[T struct] : GsUnmanaged[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // Review finding (#4092): the `comparable` branch (ADR-0020's legacy
            // constraint), which has its own implication rule and had no row.
            yield[]object{"an-unforwarded-comparable-constraint", `class Unf[T] : GsComparable[T] {
}

Console.WriteLine("x")`, "GS0580"}
            // NOT only the base clause. `csc` reports CS0314 at a field type too,
            // which is why the check sits at the shared construction site rather
            // than in the base-clause binder.
            yield[]object{"a-field-typed-by-an-unforwarded-instantiation", `class Holder[T] {
    public var H GsHandler[T]
}

Console.WriteLine("x")`, "GS0580"}
            // ... and at a return type.
            yield[]object{"a-return-type-that-is-an-unforwarded-instantiation", `func take[T]() GsHandler[T] {
    return nil
}

Console.WriteLine("x")`, "GS0580"}
        }

        /// Every shape the rule must NOT reject: the forwarded spellings, the
        /// implications a forwarded bound genuinely carries, and the two positions
        /// the rule deliberately declines to ask about. A false GS0580 is a worse
        /// defect than the one being fixed.
        /// @returns Case name, the G# body appended to the prelude, expected stdout lines.
        func ForwardedConstraints() sequence[[]object] {
            // The issue's own control, verbatim.
            yield[]object{"the-issues-own-control-the-forwarded-spelling", `class Fwd[T SchemeOptions] : GsHandler[T] {
}

Console.WriteLine(Fwd[SchemeOptions]().Tag)`, []string{"g"}}
            // A DERIVED class bound implies the declared base bound.
            yield[]object{"a-derived-class-bound-implies-the-declared-base", `class Fwd[T DerivedOptions] : GsHandler[T] {
}

Console.WriteLine(Fwd[DerivedOptions]().Tag)`, []string{"g"}}
            // THE row that made this more than a call to `SatisfiesConstraint`:
            // the bound reaches the declared class through #4043's dependent-bound
            // slot rather than through `ClassConstraint`. Measured legal — it
            // compiles, IL-verifies and runs on the parent — so a checker that
            // could not see the chain would have turned it into a GS0580.
            yield[]object{"a-bound-forwarded-through-a-chain-of-type-parameters", `class Fwd[U SchemeOptions, T U] : GsHandler[T] {
}

Console.WriteLine(Fwd[SchemeOptions, SchemeOptions]().Tag)`, []string{"g"}}
            // A CLASS bound implies every interface that class carries. This is
            // #4037's own review defect, asked of the symbolic surface.
            yield[]object{"a-class-bound-implies-the-interfaces-it-carries", `class Fwd[T PingOptions] : GsPing[T] {
}

Console.WriteLine(Fwd[PingOptions]().Tag)`, []string{"p"}}
            // The interface bound spelled directly.
            yield[]object{"the-interface-bound-forwarded-directly", `class Fwd[T IPing] : GsPing[T] {
}

Console.WriteLine(Fwd[PingOptions]().Tag)`, []string{"p"}}
            // The special constraints, forwarded.
            yield[]object{"a-forwarded-default-constructor-constraint", `class Fwd[T init()] : GsNew[T] {
}

Console.WriteLine(Fwd[SchemeOptions]().Tag)`, []string{"n"}}
            yield[]object{"a-forwarded-reference-type-constraint", `class Fwd[T class] : GsClass[T] {
}

Console.WriteLine(Fwd[SchemeOptions]().Tag)`, []string{"c"}}
            yield[]object{"a-forwarded-value-type-constraint", `class Fwd[T struct] : GsStruct[T] {
}

Console.WriteLine(Fwd[int32]().Tag)`, []string{"s"}}
            // `struct` implies a public parameterless constructor at the CLR level
            // (ECMA-335 II.10.1.7), so it forwards `init()`.
            yield[]object{"a-value-type-constraint-implies-the-default-constructor-one", `class Fwd[T struct] : GsNew[T] {
}

Console.WriteLine(Fwd[int32]().Tag)`, []string{"n"}}
            // A CLASS bound proves reference-ness, so it forwards `class`.
            yield[]object{"a-class-bound-implies-the-reference-type-constraint", `class Fwd[T SchemeOptions] : GsClass[T] {
}

Console.WriteLine(Fwd[SchemeOptions]().Tag)`, []string{"c"}}
            // Review finding (#4092): the `unmanaged` branch, forwarded.
            yield[]object{"a-forwarded-unmanaged-constraint", `class Fwd[T unmanaged] : GsUnmanaged[T] {
}

Console.WriteLine(Fwd[int32]().Tag)`, []string{"u"}}
            // `unmanaged` is a value-type constraint, so it forwards BOTH `struct`
            // and — through `struct` — `init()`. Two rows, because the two flags
            // are read from different slots.
            yield[]object{"an-unmanaged-constraint-implies-the-value-type-one", `class Fwd[T unmanaged] : GsStruct[T] {
}

Console.WriteLine(Fwd[int32]().Tag)`, []string{"s"}}
            yield[]object{"an-unmanaged-constraint-implies-the-default-constructor-one", `class Fwd[T unmanaged] : GsNew[T] {
}

Console.WriteLine(Fwd[int32]().Tag)`, []string{"n"}}
            // Review finding (#4092): the `comparable` branch, forwarded.
            yield[]object{"a-forwarded-comparable-constraint", `class Fwd[T comparable] : GsComparable[T] {
}

Console.WriteLine(Fwd[int32]().Tag)`, []string{"k"}}
            // REVIEW FINDING (#4092), the serious half — a FALSE REJECTION on the
            // reviewed commit. A SAME-COMPILATION class that implements an
            // IMPORTED interface has no CLR type while binding, so the reflective
            // `SatisfiesClrInterfaceConstraint` returned false without ever
            // reading `DisposableSource`'s interface list and this reported
            // `GS0580` on a program `csc` and the CLR both accept. The arm now
            // falls back to `SourceSymbolImplementsImportedInterface`, which is
            // #4068's repair for the SAME defect on the dependent-bound path
            // rather than a fourth private copy of it.
            yield[]object{"review-a-source-class-bound-implies-the-imported-interface-it-implements", `class Fwd[T DisposableSource] : GsDisposable[T] {
}

Console.WriteLine(Fwd[DisposableSource]().Tag)`, []string{"d"}}
            // REVIEW FINDING (#4092), the second arm: the interface arrives
            // through an IMPORTED BASE, which a source class holds in its own slot
            // rather than in `BaseClass` — so the shared walk saw an empty
            // interface list for `class EnumerableSource : ArrayList` and rejected
            // it for not carrying `IEnumerable`, which `ArrayList` plainly does.
            yield[]object{"review-a-source-class-bound-implies-the-interface-its-imported-base-carries", `open class GsEnumerable[TE IEnumerable] {
    public var Tag string = "e"
}

class Fwd[T EnumerableSource] : GsEnumerable[T] {
}

Console.WriteLine(Fwd[EnumerableSource]().Tag)`, []string{"e"}}
            // SKIP: a COMPOSITE open argument has no forwarding question to ask.
            yield[]object{"control-a-composite-open-argument-is-not-asked", `class Composite[T] : GsList[[]T] {
}

Console.WriteLine(Composite[int32]().Tag)`, []string{"l"}}
            // SKIP: the declared bound MENTIONS another of the definition's own
            // parameters — #4031/#4041's dependent shape, where answering on an
            // unsubstituted parameter is exactly what goes wrong.
            yield[]object{"control-a-dependent-bound-is-not-asked", `class Dependent[A, B] {
    public var C GsPair[A, B]
}

Console.WriteLine("x")`, []string{"x"}}
            // SELF-REFERENCE: a constrained generic naming its OWN parameter at its
            // OWN position. The argument and the declared parameter are the same
            // symbol, so there is nothing to forward and the question is not asked
            // — a checker that asked it anyway would reject every recursive
            // declaration in the corpus.
            yield[]object{"control-a-definition-writing-its-own-parameter-at-its-own-position", `open class SelfRef[TS SchemeOptions] {
    public var Tag string = "r"
    public var Next SelfRef[TS]
}

Console.WriteLine(SelfRef[SchemeOptions]().Tag)`, []string{"r"}}
            // CRTP: the declared bound is a construction over the definition's own
            // parameter, so it MENTIONS a type parameter and the implication test
            // declines — the same skip as the dependent bound above, reached
            // through `ClassConstraint` rather than `TypeParameterBound`.
            yield[]object{"control-a-crtp-bound-is-not-asked", `open class Crtp[TC Crtp[TC]] {
    public var Tag string = "y"
}

class Node : Crtp[Node] {
}

Console.WriteLine(Node().Tag)`, []string{"y"}}
            // An unconstrained definition asks nothing of its arguments.
            yield[]object{"control-an-unconstrained-definition-asks-nothing", `class Plain[T] : GsList[T] {
}

Console.WriteLine(Plain[int32]().Tag)`, []string{"l"}}
            // A G#-declared generic INTERFACE, forwarded. Interfaces were outside
            // this rule's reach when this class was written; #4089 brought them in,
            // and the forwarded spelling must keep binding either way. The
            // UNforwarded spelling is now a red row in
            // Issue4089And4090GsDeclaredGenericTypeClauseConstraintTests.
            yield[]object{"a-forwarded-gs-declared-generic-interface", `class Holder[T SchemeOptions] {
    public var B IGsBox[T]
}

Console.WriteLine("x")`, []string{"x"}}
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
