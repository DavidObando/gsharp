// <copyright file="Issue4010NilLiteralAtOpenParameterTests.cs" company="GSharp">
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

/// Issue #4010: a bare `nil` literal at an OPEN non-nullable parameter was
/// accepted for every shape, where every CLOSED spelling reports
/// `GS0154`.
/// @remarks <b>Cause.</b> The `ContainsTypeParameter` bypass in
/// `OverloadResolver.CallBinding`'s argument loop — the same clause #3988
/// amended in #3999. When the substituted parameter type still mentions a type
/// parameter, `Conversion.Classify` is not asked at all. #3988 taught the
/// clause to look at a `NullableTypeSymbol` ARGUMENT; a bare `nil`
/// literal has type `TypeSymbol.Null`, not a nullable annotation, so that
/// gate never saw it and the argument again flowed through unchecked.
///
/// <b>Fix.</b> A `nil` argument is routed to
/// `Conversion.Classify` whether or not the parameter is open. That is not
/// a closed-world judgement smuggled into an open pair: `Classify(nil, X)`
/// answers from the nil rule of `Conversion.Classify` (the old predicate was removed by #4316), which
/// decides on `X`'s SYMBOL KIND alone — a G#-declared class, an interface,
/// a reference-CONSTRAINED type parameter and any nullable target accept
/// `nil`; a `chan[T]`, `[]T`, `map[K,V]`,
/// `sequence[T]`, `[4]T`, `(T) -> T` and an UNCONSTRAINED
/// `T` do not. So the OPEN spelling now answers exactly what the CLOSED
/// spelling already answered, which is the whole content of the change.
///
/// <b>Unsound, not merely silent.</b> Measured on the parent:
/// `takesMap[K, V](nil)` forwarded out of a generic and instantiated at
/// `[string, int32]` compiled with NO diagnostic, IL-verified
/// (`dotnet ilverify`: <i>All Classes and Methods … Verified</i>, on the
/// parent's own output), and threw `NullReferenceException` when the
/// callee read `m.Count`.
///
/// <b>The issue's DIRECT form was already rejected, and the issue is
/// corrected here.</b> `takesMap[string, int32](nil)` written at a closed
/// instantiation reports `GS0154` on the parent: the substituted parameter
/// is `map[string,int32]`, which mentions no type parameter, so the bypass
/// is not taken. The unsound form is the FORWARDED one, where the substituted
/// parameter stays open. A correction was posted on the issue
/// (comment 5559871459).
///
/// <b>Three shapes beyond the four the issue named also change.</b> An
/// unconstrained `T`, a fixed array `[4]T` and a function type
/// `(T) -> T` were silently accepting `nil` at their OPEN
/// spellings too. All three are red rows here, and each one's CLOSED sibling
/// was already `GS0154` on the parent — measured, not assumed.
///
/// <b>The green rows are the point.</b> `nil` still reaches every
/// null-tolerant OPEN shape: a reference-constrained `[T class]` (and it
/// genuinely arrives — the callee compares it against `nil`), an open
/// `T?`, an open `chan[T]?`, a G#-declared open class
/// `Node[T]` and an open interface `IThing[T]`. Real values still
/// forward through open `map` and `chan` parameters and are read back
/// out, so a gate that had become timid would show as a wrong number rather
/// than merely as a compile error.
open class Issue4010NilLiteralAtOpenParameterTests {
    /// A `nil` literal at an OPEN non-nullable parameter now reports the
    /// same `GS0154` its closed sibling always did.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func ANilLiteralAtANonNullableParameter_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4010_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every legitimate neighbour still compiles, IL-verifies, runs, and prints
    /// what it always did.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("LegitimateCases")
    func ALegitimateNeighbour_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4010_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
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

    /// A reference-constrained `[T class]` parameter still accepts a
    /// `nil` literal at an OPEN call site, and the `nil` genuinely
    /// ARRIVES: the callee compares the parameter against `nil` and takes
    /// the nil branch, so a change that had merely stopped emitting the
    /// argument would print `2`.
    /// @remarks <b>This row used to skip <c>IlVerifier</c>; #4027 fixed the emit
    /// defect and the skip is gone.</b> The IL the compiler emitted for the
    /// call was `ldnull` at a slot typed `!!0`, which ILVerify
    /// rejects: `[StackUnexpected] [found Nullobjref 'NullReference']
    /// [expected value 'T']`. That was a PRE-EXISTING emit defect, not a
    /// consequence of #4010's change — `Classify(nil, [T class])` is
    /// `Implicit` (via
    /// the nil rule of `Conversion.Classify` (the old predicate was removed by #4316)'s
    /// reference-constrained arm) before and after it, so the argument reached
    /// emit by the same path and the same bytes came out. It was filed as
    /// #4027 and the row was kept unverified because it is the control that
    /// stops #4010's gate from becoming timid. #4027 lowers a `nil` at a
    /// bare open type-parameter slot to `default(T)`, so the call site now
    /// emits `ldloca.s N; initobj !!T; ldloc.N` — the same shape
    /// `csc` emits for the equivalent C# — and this row verifies. The
    /// run-and-print assertion is unchanged, so the `nil` must still
    /// ARRIVE: `default(T)` at a `[T class]` slot is the null
    /// reference in every instantiation.
    @Fact
    func AReferenceConstrainedTypeParameterStillAcceptsNil_AndTheNilArrives() {
        const Source = `package Demo
import System

func takesClassT[T class](x T?) int32 { if x == nil { return 1 } else { return 2 } }
func fwdClassT[T class]() int32 { return takesClassT[T](nil) }

Console.WriteLine(fwdClassT[string]())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4010_cls_").FullName
        try {
            let appPath = Path.Combine(tempDir, "ClassConstrained.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`a reference-constrained slot must still accept nil. Log:
` + "$appLog"))
            // #4027: no longer exempt. This assembly IL-verifies.
            IlVerifier.Verify(appPath, Array.Empty[string]())
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the case must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("1", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The `nil` arguments that must now be refused.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // The issue's four shapes, each at an OPEN parameter. All four compiled
            // with NO diagnostic on the parent.
            yield[]object{"an-open-channel-parameter-rejects-a-nil-literal", `package Demo
import System

func takesChan[T](c chan[T]) int32 { return 1 }
func nilChan[T]() int32 { return takesChan[T](nil) }

Console.WriteLine("x")`, "GS0154"}
            yield[]object{"an-open-slice-parameter-rejects-a-nil-literal", `package Demo
import System

func takesSlice[T](s []T) int32 { return 1 }
func nilSlice[T]() int32 { return takesSlice[T](nil) }

Console.WriteLine("x")`, "GS0154"}
            yield[]object{"an-open-map-parameter-rejects-a-nil-literal", `package Demo
import System

func takesMap[K, V](m map[K, V]) int32 { return 1 }
func nilMap[K, V]() int32 { return takesMap[K, V](nil) }

Console.WriteLine("x")`, "GS0154"}
            yield[]object{"an-open-sequence-parameter-rejects-a-nil-literal", `package Demo
import System

func takesSeq[T](s sequence[T]) int32 { return 1 }
func nilSeq[T]() int32 { return takesSeq[T](nil) }

Console.WriteLine("x")`, "GS0154"}
            // Three shapes the issue did not name, found by sweeping the OPEN
            // spellings. Each one's CLOSED sibling was already GS0154 on the
            // parent, so these are the same hole, not a widening.
            yield[]object{"an-open-unconstrained-type-parameter-rejects-a-nil-literal", `package Demo
import System

func takesBareT[T](x T) int32 { return 1 }
func fwdBareT[T]() int32 { return takesBareT[T](nil) }

Console.WriteLine("x")`, "GS0154"}
            yield[]object{"an-open-fixed-array-parameter-rejects-a-nil-literal", `package Demo
import System

func takesFixed[T](a [4]T) int32 { return 1 }
func fwdFixed[T]() int32 { return takesFixed[T](nil) }

Console.WriteLine("x")`, "GS0154"}
            yield[]object{"an-open-function-type-parameter-rejects-a-nil-literal", `package Demo
import System

func takesFunc[T](f (T) -> T) int32 { return 1 }
func fwdFunc[T]() int32 { return takesFunc[T](nil) }

Console.WriteLine("x")`, "GS0154"}
            // THE SOUNDNESS ROW. On the parent this compiled, IL-verified, ran, and
            // threw NullReferenceException at `m.Count`.
            yield[]object{"the-forwarded-nil-that-reached-a-real-dereference-is-now-a-compile-error", `package Demo
import System

func takesMap[K, V](m map[K, V]) int32 { return m.Count }
func forwardMap[K, V]() int32 { return takesMap[K, V](nil) }

let n int32 = forwardMap[string, int32]()
Console.WriteLine(n)`, "GS0154"}
            // The CLOSED controls the issue lists. Rejected before and after — the
            // rows that establish what "the open spelling now agrees with the
            // closed one" is agreeing WITH.
            yield[]object{"control-the-closed-channel-spelling-was-always-rejected", `package Demo
import System

func takesClosedChan(c chan[int32]) int32 { return 1 }
Console.WriteLine(takesClosedChan(nil))`, "GS0154"}
            yield[]object{"control-the-closed-map-spelling-was-always-rejected", `package Demo
import System

func takesClosedMap(m map[string, int32]) int32 { return 1 }
Console.WriteLine(takesClosedMap(nil))`, "GS0154"}
            // The issue's own DIRECT form, whose diagnosis the issue got wrong: a
            // closed instantiation mentions no type parameter, so the bypass was
            // never taken and this reported GS0154 on the parent too.
            yield[]object{"control-the-direct-closed-instantiation-was-always-rejected", `package Demo
import System

func takesMap[K, V](m map[K, V]) int32 { return m.Count }

let n int32 = takesMap[string, int32](nil)
Console.WriteLine(n)`, "GS0154"}
        }

        /// Every legitimate neighbour that must keep binding.
        /// @returns Case name, G# source, expected stdout lines.
        func LegitimateCases() sequence[[]object] {
            // `nil` still reaches every null-tolerant OPEN shape. The
            // reference-constrained `[T class]` arm is exercised by its own
            // compile-verify-and-run fact below rather than here, because it also
            // asserts the value that ARRIVES. It used to skip verification for a
            // pre-existing emit defect; #4027 fixed that and the skip is gone.
            yield[]object{"control-nil-still-reaches-every-null-tolerant-open-shape", `package Demo
import System

func takesNullableT[T](x T?) int32 { return 3 }
func fwdNullableT[T]() int32 { return takesNullableT[T](nil) }

func takesNullableChan[T](c chan[T]?) int32 { return 4 }
func fwdNullableChan[T]() int32 { return takesNullableChan[T](nil) }

class Node[T] { public var V T }
func takesNode[T](n Node[T]?) int32 { return 5 }
func fwdNode[T]() int32 { return takesNode[T](nil) }

interface IThing[T] { func Do() int32; }
func takesIface[T](i IThing[T]?) int32 { return 6 }
func fwdIface[T]() int32 { return takesIface[T](nil) }

Console.WriteLine(fwdNullableT[int32]())
Console.WriteLine(fwdNullableChan[int32]())
Console.WriteLine(fwdNode[int32]())
Console.WriteLine(fwdIface[int32]())`, []string{"3", "4", "5", "6"}}
            // The gate must not become timid: a REAL map forwarded through the very
            // open parameter the repro used still binds, and its contents are read
            // back out, so a wrong argument would print a wrong number rather than
            // merely verify.
            yield[]object{"control-a-real-map-still-forwards-through-the-open-parameter", `package Demo
import System

func countMap[K, V](m map[K, V]) int32 { return m.Count }
func forwardReal[K, V](m map[K, V]) int32 { return countMap[K, V](m) }

let real = map[string, int32]{}
real["a"] = 1
real["b"] = 2
Console.WriteLine(forwardReal[string, int32](real))`, []string{"2"}}
            // The channel spelling of the same control, and it MOVES A VALUE: the
            // relay sends through an open `chan[T]` parameter and the caller reads
            // the value back, so a dropped or mis-shaped argument would deadlock or
            // print the wrong number.
            yield[]object{"control-a-real-channel-still-moves-a-value-through-the-open-parameter", `package Demo
import System

func sendOne[T](c chan[T], v T) {
    c <- v
}

func relay[T](c chan[T], v T) {
    sendOne[T](c, v)
}

let ch = chan[int32](1)
relay[int32](ch, 41)
let got = <-ch
Console.WriteLine(got)`, []string{"41"}}
            // The remedy the diagnostic leaves the author for a genuinely optional
            // slot: annotate the parameter. Kept green so the change cannot be read
            // as "an open channel can never be absent".
            yield[]object{"control-the-annotation-remedy-accepts-nil-and-narrows-back-to-a-value", `package Demo
import System

func maybeCount[K, V](m (map[K, V])?) int32 {
    if m != nil {
        return 10
    }

    return 20
}

func fwdNil[K, V]() int32 { return maybeCount[K, V](nil) }

let real = map[string, int32]{}
real["a"] = 1
Console.WriteLine(fwdNil[string, int32]())
Console.WriteLine(maybeCount[string, int32](real))`, []string{"20", "10"}}
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
