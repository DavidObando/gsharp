// <copyright file="Issue3988NullableArgumentAtOpenGSharpParameterTests.cs" company="GSharp">
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

/// Issue #3988: a nullable argument was SILENTLY ACCEPTED at a non-nullable
/// G#-declared parameter whenever the substituted parameter type still
/// mentioned a type parameter — `chan[T]?` at `chan[T]`,
/// `([]T)?` at `[]T`, `T?` at a reference-constrained
/// `T` — where the closed spellings correctly reported GS0154.
/// @remarks <b>The issue's diagnosis was wrong, and this suite records the
/// correction.</b> #3988 blamed `OverloadResolver.IsReferenceLikeType`,
/// "the null-safety gate that attributes GS0154". That gate was REMOVED by
/// issue #1627 — the comment at `OverloadResolver.Candidates.cs`'s
/// convertibility filter says so — and the predicate now feeds only the
/// empty-candidate-set diagnostic-attribution fallback. Unifying it, alone,
/// was measured to change nothing at all: the repro compiled exactly as
/// before.
///
/// <b>The actual cause</b> is a deliberate bypass in
/// `OverloadResolver.CallBinding.cs`'s argument-conversion loop: when the
/// substituted parameter type still contains a type parameter,
/// `Conversion.Classify` is not consulted at all and the argument flows
/// through unchecked. That is defensible for the general lattice — an open
/// pair has no closed answer to give — but it also swallowed the one rule that
/// needs no closed answer. Kotlin-model null safety is a pure SHAPE question,
/// and both halves of it are decidable on an open type: `chan[T]` is a
/// reference in every instantiation, and a `[T class]` parameter is one by
/// constraint. The bypass now makes an exception for exactly that gate.
///
/// <b>Why the predicate still had to be unified.</b> The gate the bypass
/// now consults IS `IsNullableReferenceGateRejected`, which bottoms out on
/// `IsReferenceLikeType` — the stale mirror #3988 named. Left as a copy it
/// listed neither channels nor slices nor delegates nor reference-constrained
/// type parameters, so the restored gate would have fired for none of the kinds
/// that reach it. So both halves of the issue are load-bearing, in the opposite
/// order from the one it described: the mirror is not the cause, but it is the
/// oracle, and it now DELEGATES to `Conversion.IsReferenceLikeTarget`
/// rather than restating it.
///
/// <b>A fourth copy, and why it is in scope.</b>
/// `StatementBinder.Narrowing.IsReferenceLikeType` says it mirrors the
/// same rule and had drifted the same way. That became load-bearing the moment
/// this diagnostic started firing, because the diagnostic names narrowing as a
/// remedy: measured with only the overload-resolution half applied,
/// `var s chan[T]? = nil; s = source; takesOpen[T](s)` reported GS0154
/// with no way to satisfy it — ASSIGNMENT narrowing did not lift a structural
/// shape, though CONDITION narrowing did. Both remedy rows are asserted.
///
/// <b>What this deliberately does not reach.</b> `map[K, V]?` and
/// `(sequence[T])?` are still accepted at their non-nullable parameters,
/// because `Conversion.IsReferenceLikeTarget` ITSELF omits those two
/// symbol kinds — the same drift one layer deeper, in the original rather than
/// a copy, and a change to every `map` and `sequence` conversion in
/// the language. Issue #3997.
///
/// <b>Soundness.</b> This was not merely a missing diagnostic. Measured
/// on the parent commit, `fOpen[int32](nil)` compiled, IL-verified, and
/// threw `ChannelClosedException: close of nil channel` at run time — a
/// `nil` reaching a non-nullable `chan[T]` slot with the compiler
/// silent. The `NilFlowsIntoTheNonNullableSlot` case pins that.
///
/// <b>Discrimination (ADR-0154).</b> The seven behavioural rejection rows
/// are the point of the fix: each is a spelling that compiled without a word
/// before it. Two further rejection rows are labelled `control-…` because
/// they were rejected on the parent as well — a closed pair such as
/// `D?` at `D` never reaches the bypass, so named delegates and
/// structural function types were never affected and are not what this turned
/// red. The
/// control rows are what holds the fix to its scope — an UNCONSTRAINED
/// `T?` stays ungated (its `T?` erases to `Nullable<T>`
/// and keeps the value-type rules), `!!` and a nullable-typed parameter
/// are the remedies the diagnostic points at, and both compile, IL-verify and
/// RUN, asserting the program's own stdout with a value moved through the
/// channel.
open class Issue3988NullableArgumentAtOpenGSharpParameterTests {
    /// The rejected spellings report GS0154, name the offending nullable type,
    /// and never reach the emitter.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the case must report.
    /// @param expectedType A type spelling the diagnostic must name.
    @Theory
    @MemberData("RejectedCases")
    func ANullableArgumentAtANonNullableParameter_IsRejected(
        name string,
        source string,
        expectedId string,
        expectedType string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3988_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
            Assert.Contains(expectedType, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The accepted spellings compile, IL-verify, run, and print exactly what
    /// they claim.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func TheRemediesAndTheUngatedShapes_CompileVerifyAndRun(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3988_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile:
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

    /// The soundness witness. On the parent commit this program compiled with
    /// NO diagnostic, IL-verified, and threw at run time — a `nil` flowing
    /// into a non-nullable `chan[T]` slot. The bug was never merely a
    /// missing message.
    @Fact
    func NilFlowsIntoTheNonNullableSlot_AndIsNowACompileError() {
        const Source = `package P
import System

func takesOpen[T](c chan[T]) int32 {
    c.Close()
    return 1
}

func fOpen[T](source chan[T]?) int32 {
    return takesOpen[T](source)
}

Console.WriteLine("before")
Console.WriteLine(fOpen[int32](nil))
Console.WriteLine("after")`
        let tempDir = Directory.CreateTempSubdirectory("gs_3988_nil_").FullName
        try {
            let appPath = Path.Combine(tempDir, "NilIntoNonNullable.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.False(
                File.Exists(appPath),
                "a `nil` reaching a non-nullable `chan[T]` parameter must be a compile error, not a\n" +
                    "run-time `ChannelClosedException: close of nil channel`. Log:\n" +
                    appLog
            )
            Assert.Contains("GS0154", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Review finding (Copilot on PR #3999): the null-safety gate is a SHAPE
    /// test, and shape alone does not establish that dropping the `?`
    /// would make the call work. Where it would not, GS0154 named a parameter
    /// the argument could never satisfy and prescribed `!!`, which cannot
    /// help.
    /// @remarks Two things are asserted. The call must NOT report GS0154, because
    /// nullability is not why it failed; and it must NOT report GS0266 either,
    /// because there is no ambiguity to disambiguate — the first attempt at
    /// this fix declined the gate and fell through to exactly that false
    /// ambiguity, which is why the truthful GS0267 is asserted by id.
    ///
    /// The defect is OLDER than the predicate unification that exposed
    /// it: the `string?` row misattributed identically on the parent commit,
    /// through the `ClrType` fallback that has answered for `string`
    /// since #1552. Both are repaired.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @InlineData("an-open-nullable-channel-against-unrelated-overloads", `package P
import System

func f(ch chan[string]) int32 {
    return 1
}

func f(xs []string) int32 {
    return 2
}

func caller[T](c chan[T]?) int32 {
    return f(c)
}

Console.WriteLine("x")`)
    @InlineData("a-closed-nullable-channel-against-unrelated-overloads", `package P
import System

func f(ch chan[string]) int32 {
    return 1
}

func f(xs []string) int32 {
    return 2
}

func caller(c chan[int32]?) int32 {
    return f(c)
}

Console.WriteLine("x")`)
    @InlineData("a-nullable-string-against-unrelated-overloads-the-pre-existing-case", `package P
import System

func g(a chan[string]) int32 {
    return 1
}

func g(b []int32) int32 {
    return 2
}

func caller(s string?) int32 {
    return g(s)
}

Console.WriteLine("x")`)
    func WhenDroppingTheAnnotationCannotHelp_TheDiagnosticDoesNotBlameNullability(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3988_attr_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS0154", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0266", appLog, StringComparison.Ordinal)
            Assert.Contains("GS0267", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The other half of the same rule: when dropping the annotation WOULD make
    /// the call work, GS0154 must still be exactly what is reported, naming the
    /// parameter and both types. The narrowing above must not have made the
    /// gate timid.
    @Fact
    func WhenDroppingTheAnnotationWouldHelp_Gs0154IsStillReported() {
        const Source = `package P
import System

func f(ch chan[string]) int32 {
    return 1
}

func f(xs []string) int32 {
    return 2
}

func caller(c chan[string]?) int32 {
    return f(c)
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_3988_attr_ok_").FullName
        try {
            let appPath = Path.Combine(tempDir, "GateStillFires.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`the call must not compile. Log:
` + "$appLog"))
            Assert.Contains("GS0154", appLog, StringComparison.Ordinal)
            Assert.Contains("chan[string]?", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as deadlocked.
        private const RunTimeout int32 = 60_000

        /// The rows that must be REJECTED. The behavioural ones compiled with NO
        /// diagnostic at all on the parent commit, while their closed siblings
        /// reported GS0154 — that asymmetry is the issue. The rows named
        /// `control-…` were rejected on the parent too, and are carried to
        /// record what this fix did NOT turn red.
        /// @remarks Review finding (Copilot on PR #3999): an earlier version of this comment
        /// said named delegates and structural function types "were never affected",
        /// which was too broad and is corrected here. Only the CLOSED pair was
        /// already rejected — a `D?` at a `D` parameter mentions no type
        /// parameter, so it never reaches the bypass and
        /// `Conversion.Classify` answered it all along. An OPEN generic
        /// delegate `D[T]? -> D[T]` and an open structural function
        /// `((T) -> T)? -> (T) -> T` DO leave the substituted parameter open,
        /// so they take the bypass and it is this fix that rejects them. Both are
        /// now behavioural rows, measured red on the parent.
        /// @returns Name, source, and the diagnostic the case must report.
        func RejectedCases() sequence[[]object] {
            // The reported repro. `takesOpen[T](chan[T])` is reached with a
            // `chan[T]?`; the closed sibling below it already errored.
            yield[]object{"the-reported-repro-a-nullable-open-channel-at-an-open-channel-parameter", `package P
import System

func takesOpen[T](c chan[T]) int32 {
    return 1
}

func fOpen[T](source chan[T]?) int32 {
    return takesOpen[T](source)
}

Console.WriteLine("x")`, "GS0154", "chan[T]?"}
            // The same call with the type argument INFERRED rather than written,
            // so the fix cannot be an artefact of the explicit-type-argument path.
            yield[]object{"an-inferred-type-argument-reaches-the-same-gate", `package P
import System

func takesOpen[T](c chan[T]) int32 {
    return 1
}

func fInferred[T](source chan[T]?) int32 {
    return takesOpen(source)
}

Console.WriteLine("x")`, "GS0154", "chan[T]?"}
            // A SLICE over an open element — the second symbol kind the mirror
            // omitted. `([]int32)?` already errored; `([]T)?` did not.
            yield[]object{"a-nullable-slice-over-an-open-element-is-rejected", `package P
import System

func takesSlice[T](s []T) int32 {
    return 1
}

func fSlice[T](source ([]T)?) int32 {
    return takesSlice[T](source)
}

Console.WriteLine("x")`, "GS0154", "[]T"}
            // A reference-CONSTRAINED type parameter is provably a reference type,
            // so `T?` at `T` is the same Kotlin-model violation. This is the row
            // most likely to appear in existing code — see the release note.
            yield[]object{"a-nullable-reference-constrained-type-parameter-is-rejected", `package P
import System

func takesRefT[T class](v T) int32 {
    return 1
}

func fRefT[T class](v T?) int32 {
    return takesRefT[T](v)
}

Console.WriteLine("x")`, "GS0154", "T?"}
            // A fixed array and a rectangular array over an open element are the
            // same hole in the same predicate, and were silently accepted too.
            yield[]object{"a-nullable-fixed-array-over-an-open-element-is-rejected", `package P
import System

func takesFixed[T](a [4]T) int32 {
    return 1
}

func fFixed[T](a ([4]T)?) int32 {
    return takesFixed[T](a)
}

Console.WriteLine("x")`, "GS0154", "[4]T"}
            // The parameter's openness is what the bypass keys on, so an
            // OVERLOADED generic callee must still attribute GS0154 rather than
            // degrading to a bare "no overload is applicable".
            yield[]object{"an-overloaded-generic-callee-still-attributes-gs0154", `package P
import System

func over[T](c chan[T]) int32 {
    return 1
}

func over[T](c chan[T], n int32) int32 {
    return 2
}

func fOverloaded[T](source chan[T]?) int32 {
    return over[T](source)
}

Console.WriteLine("x")`, "GS0154", "chan[T]?"}
            // An OPEN generic named delegate. `D[T]` still mentions a type
            // parameter, so the substituted parameter takes the bypass this fix
            // changes — this is the delegate arm of the unified predicate reached
            // where the `ClrType` fallback cannot answer.
            yield[]object{"an-open-generic-delegate-is-rejected", `package P
import System

delegate D[T](x T) T;

func takesD[T](d D[T]) int32 {
    return 1
}

func fD[T](d D[T]?) int32 {
    return takesD[T](d)
}

Console.WriteLine("x")`, "GS0154", "D[T]?"}
            // An OPEN structural function type, likewise.
            yield[]object{"an-open-structural-function-type-is-rejected", `package P
import System

func takesFn[T](f (T) -> T) int32 {
    return 1
}

func fFn[T](f ((T) -> T)?) int32 {
    return takesFn[T](f)
}

Console.WriteLine("x")`, "GS0154", "((T) -> T)?"}
            // A named DELEGATE was ALREADY rejected on the parent — a `D?` at a
            // `D` parameter is a closed pair, so it never reached the bypass and
            // `Conversion.Classify` (whose predicate always named delegates)
            // answered it. Carried as a rejection row precisely to record that the
            // delegate arm of the unified predicate is NOT what this fix turned
            // red, and must not regress.
            yield[]object{"control-a-nullable-named-delegate-was-always-rejected", `package P
import System

delegate D(x int32) int32;

func takesDelegate(d D) int32 {
    return 1
}

func fDelegate(d D?) int32 {
    return takesDelegate(d)
}

Console.WriteLine("x")`, "GS0154", "D?"}
            // The DIRECTIONAL spellings are the same rule: an `out chan[T]?` is
            // still a nullable reference.
            yield[]object{"a-nullable-directional-open-channel-is-rejected", `package P
import System

func takesWriter[T](c out chan[T]) int32 {
    return 1
}

func fWriter[T](source out chan[T]?) int32 {
    return takesWriter[T](source)
}

Console.WriteLine("x")`, "GS0154", "out chan[T]?"}
            // The closed spelling, which ALREADY reported GS0154 — carried as a
            // rejection row so the fix cannot silently stop reporting it.
            yield[]object{"control-the-closed-spelling-was-always-rejected", `package P
import System

func takesClosed(c chan[int32]) int32 {
    return 1
}

func fClosed(source chan[int32]?) int32 {
    return takesClosed(source)
}

Console.WriteLine("x")`, "GS0154", "chan[int32]?"}
        }

        /// The rows that must still COMPILE, RUN, and print. They hold the fix to
        /// its scope: the remedies the diagnostic names still work, an
        /// unconstrained `T?` is deliberately NOT gated, and a legitimately
        /// non-nullable open channel is untouched.
        /// @returns Name, source, and the expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // Remedy 1, the one the issue names: `!!`.
            yield[]object{"control-the-bang-bang-remedy-works-and-moves-a-value", `package P
import System

func takesOpen[T](c chan[T], v T) int32 {
    c <- v
    return 41
}

func fBang[T](source chan[T]?, v T) int32 {
    return takesOpen[T](source!!, v)
}

let ch = chan[int32](2)
Console.WriteLine(fBang[int32](ch, 9))
Console.WriteLine(<-ch)`, []string{"41", "9"}}
            // Remedy 2: declare the parameter nullable. A nullable TARGET keeps
            // going through the lifted rules and is not gated.
            yield[]object{"control-a-nullable-typed-parameter-accepts-the-nullable-argument", `package P
import System

func takesNullable[T](c chan[T]?) int32 {
    return 42
}

func fNullable[T](source chan[T]?) int32 {
    return takesNullable[T](source)
}

Console.WriteLine(fNullable[int32](chan[int32](1)))`, []string{"42"}}
            // An UNCONSTRAINED `T?` must stay ungated: `Conversion.IsReferenceLikeTarget`
            // deliberately answers false for it (its `T?` erases to `Nullable<T>`
            // and it keeps the value-type rules), so the gate must not fire.
            yield[]object{"control-an-unconstrained-nullable-type-parameter-is-not-gated", `package P
import System

func takesAnyT[T](v T) int32 {
    return 43
}

func fAnyT[T](v T?) int32 {
    return takesAnyT[T](v)
}

Console.WriteLine(fAnyT[int32](7))`, []string{"43"}}
            // A non-nullable open channel is what the vast majority of code
            // writes, and is untouched. The value moves through, so a dropped or
            // mis-viewed handle would print the wrong number rather than merely
            // compile.
            yield[]object{"control-a-non-nullable-open-channel-still-binds-and-moves-a-value", `package P
import System

func takesOpen[T](c chan[T], v T) int32 {
    c <- v
    return 44
}

func fPlain[T](source chan[T], v T) int32 {
    return takesOpen[T](source, v)
}

let ch = chan[int32](2)
Console.WriteLine(fPlain[int32](ch, 12))
Console.WriteLine(<-ch)`, []string{"44", "12"}}
            // ASSIGNMENT narrowing is the same remedy through the other door, and
            // it is the one the FOURTH stale copy of the predicate
            // (`StatementBinder.Narrowing.IsReferenceLikeType`) did not lift for a
            // structural shape. Measured with only the overload-resolution half of
            // this fix applied, this program reported GS0154 with no way to satisfy
            // it — the diagnostic named a remedy that did not work. Unifying that
            // copy too is what makes this row green.
            yield[]object{"control-assignment-narrowing-lifts-an-open-channel-and-satisfies-the-parameter", `package P
import System

func takesOpen[T](c chan[T], v T) int32 {
    c <- v
    return 46
}

func fAssigned[T](source chan[T], v T) int32 {
    var s chan[T]? = nil
    s = source
    return takesOpen[T](s, v)
}

let ch = chan[int32](2)
Console.WriteLine(fAssigned[int32](ch, 14))
Console.WriteLine(<-ch)`, []string{"46", "14"}}
            // Smart-cast narrowing is the third remedy and is untouched by the
            // gate: inside the `!= nil` branch the local's type is no longer
            // nullable, so nothing is dropped.
            yield[]object{"control-smart-cast-narrowing-still-satisfies-the-parameter", `package P
import System

func takesOpen[T](c chan[T], v T) int32 {
    c <- v
    return 45
}

func fNarrowed[T](source chan[T]?, v T) int32 {
    var s = source
    if s != nil {
        return takesOpen[T](s, v)
    }

    return 0
}

let ch = chan[int32](2)
Console.WriteLine(fNarrowed[int32](ch, 13))
Console.WriteLine(<-ch)`, []string{"45", "13"}}
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
            // A wrong channel handle fails by DEADLOCKING rather than erroring, so
            // read asynchronously and bound the wait.
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s (deadlock).")
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
