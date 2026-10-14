// <copyright file="Issue4223EnclosingTypeParameterReificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #4223: reify enclosing type parameters for generic and non-generic local functions. The
/// exact repros from the issue, plus the wider matrix its Definition of Done calls out that isn't
/// already covered by (cref:Issue1940GenericLocalFunctionEnclosingTypeParameterTests) (the
/// generic-own-type-parameter case) or
/// (cref:Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests)
/// (the non-generic case): a local function combining its OWN type parameters with a reference to an
/// ENCLOSING one (the new capability this issue adds —
/// `UserTokenResolver.TryPromoteNonCapturingGenericLambda`
/// now clones referenced enclosing type parameters as additional method type parameters alongside a
/// local's own declared list, rather than only when the local declares none), an own type parameter's
/// CONSTRAINT that references an enclosing one, ordinal independence (the enclosing type parameter is
/// not always slot 0), and the sync/async/iterator routes verified independently.
open class Issue4223EnclosingTypeParameterReificationTests {
    @Fact
    func GenericLocalCombiningOwnAndEnclosingTypeParameter_ExactIssueRepro_CompilesAndRunsWithoutGS0468() {
        // The issue's first repro, verbatim (modulo the print call): a generic
        // local function's OWN parameter list combines an unrelated own type
        // parameter T with the enclosing method's U.
        let source = `package P
func Outer[U](seed U) U {
    let Keep[T] = func(ignored T, value U) U { return value }
    return Keep(1, seed)
}
Console.WriteLine(Outer("ok"))`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func GenericLocalCombiningOwnAndEnclosingTypeParameter_MultipleInstantiations_RunsCorrectlyPerType() {
        // Same shape as the issue's first repro, instantiated with three
        // DIFFERENT type arguments in the same process to prove the reified
        // enclosing type parameter is genuinely per-instantiation, not a
        // value baked in at the first call.
        let source = `package P
func Outer[U](seed U) U {
    let Keep[T] = func(ignored T, value U) U { return value }
    return Keep(1, seed)
}
Console.WriteLine(Outer("ok"))
Console.WriteLine(Outer(42))
Console.WriteLine(Outer(3.5))`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}42${Environment.NewLine}3.5${Environment.NewLine}", output)
    }

    @Fact
    func GenericLocalReferencingEnclosingTypeParameter_NotOrdinalZero_RunsCorrectly() {
        // Definition-of-done coverage: the enclosing type parameter is NOT
        // the enclosing method's first (ordinal 0) type parameter. Guards
        // against an implementation that only works by ordinal coincidence.
        let source = `package P
func Outer[A, U](a A, seed U) U {
    let Keep[T] = func (ignored T, value U) U { return value }
    return Keep(true, seed)
}
Console.WriteLine(Outer(1, "ok"))
Console.WriteLine(Outer("x", 42))`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func GenericLocalOwnTypeParameterConstraintReferencesEnclosingTypeParameter_RunsCorrectly() {
        // Definition-of-done coverage: "constraints that reference other
        // parameters". `Keep`'s own `T` is constrained by `IComparable[U]`,
        // U owned by the enclosing method — previously this failed to even
        // BIND (GS0113 "Type 'U' doesn't exist"), because the type-parameter
        // list's constraint clause bound in a scope that hadn't yet merged in
        // the enclosing type parameters.
        let source = `package P
import System

func Outer[U IComparable[U]](seed U) bool {
    let Keep[T IComparable[U]] = func (x T, y U) bool {
        return x.CompareTo(y) == 0
    }
    return Keep(seed, seed)
}
Console.WriteLine(Outer(5))
Console.WriteLine(Outer("hi"))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_ExactIssueRepro_CompilesAndRunsWithoutGS0468() {
        // The issue's second repro, verbatim (modulo the print call): even a
        // NON-generic local function referencing only the enclosing U.
        let source = `package P
func Outer[U](seed U) U {
    let Keep = func(value U) U { return value }
    return Keep(seed)
}
Console.WriteLine(Outer("ok"))`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericArrowLocalFunction_ExactIssueRepro_CompilesAndRunsWithoutGS0468() {
        // The issue's explicit callout: "Changing the G# declaration to `let
        // Keep = (value U) -> value` also produced GS0468. Arrow syntax is
        // not a workaround for this case."
        let source = `package P
func Outer[U](seed U) U {
    let Keep = (value U) -> value
    return Keep(seed)
}
Console.WriteLine(Outer("ok"))`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func GenericLocalNestedTwoLevelsReferencingOutermostTypeParameter_RunsCorrectly() {
        // Definition-of-done coverage: "multiple nesting levels". A THIRD
        // level deeper than Issue1940's own nested-local-function test, and
        // this one is actually CALLED (not merely declared) with the real
        // outer value threaded through — Middle and Innermost are both
        // zero-capture (Innermost receives the outer value as its own T
        // parameter rather than closing over it).
        let source = `package P
func Outer[T](seed T) {
    let Middle = func() {
        let Innermost = func(x T) T {
            return x
        }
        Console.WriteLine(Innermost(seed))
    }
    Middle()
}
Outer("deep")
Outer(99)`
        let output = CompileAndRun(source)
        Assert.Equal("deep${Environment.NewLine}99${Environment.NewLine}", output)
    }

    @Fact
    func GenericLocalInsideGenericClassMethodReferencingClassTypeParameter_RunsCorrectly() {
        // Definition-of-done coverage: "enclosing class ... parameters",
        // combined with the local's OWN parameter, for a NON-generic-own-TP
        // local declared inside a generic class's method.
        let source = `package P
class Box[U] {
    func Run(x U) U {
        let Echo = func (y U) U { return y }
        return Echo(x)
    }
}
let b1 = Box[string]{}
Console.WriteLine(b1.Run("hi"))
let b2 = Box[int32]{}
Console.WriteLine(b2.Run(7))`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func GenericLocalIterator_ReferencesEnclosingTypeParameter_RunsCorrectlyForMultipleTypes() {
        // Definition-of-done coverage: "Verify sync, async and iterator
        // routes independently". A zero-capture, non-generic-own-TP local
        // function whose body `yield`s the enclosing type parameter type —
        // the synthesized iterator state machine must itself be generic over
        // the same reified enclosing type parameter.
        let source = `package P
import System.Collections.Generic

func Outer[U](a U, b U) {
    let Pair = func (x U, y U) IEnumerable[U] {
        yield x
        yield y
    }
    for v in Pair(a, b) {
        Console.WriteLine(v)
    }
}
Outer("a", "b")
Outer(1, 2)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "a${Environment.NewLine}b${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}",
            output
        )
    }

    @Fact
    func GenericLocalAsync_ReferencesEnclosingTypeParameterOnlyInReturnType_RunsCorrectlyForMultipleTypes() {
        // Definition-of-done coverage: the ASYNC route, verified
        // independently rather than inferred from the sync pass.
        // ReflectionMetadataEmitter.RegisterStateMachineEnclosingGenerics now
        // aliases each ORIGINAL enclosing type parameter promoted by
        // TryPromoteNonCapturingGenericLambda onto the async state machine's
        // own class slot — the same fix RegisterGeneratedGenericRemaps
        // already applied for the analogous ITERATOR state machine (issue
        // #810 + #2118). The local takes no U-typed PARAMETER: a pre-existing,
        // #4223-independent defect in the erased-delegate-adapter's parameter
        // UNBOXING conversion for a value-type async parameter (confirmed to
        // reproduce identically for an already-legal CAPTURING async lambda,
        // with or without this issue's fix) would otherwise mask whether the
        // enclosing-type-parameter reification itself is correct; returning
        // `default` isolates that reification from the unrelated defect.
        let source = `package P
func Outer[U]() U {
    let Echo = async func () U {
        return default
    }
    return Echo().Result
}
Console.WriteLine(Outer[string]())
Console.WriteLine(Outer[int32]())`
        let output = CompileAndRun(source)
        Assert.Equal("${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func GenericLocalShadowingSameNameAsEnclosingAndReferencingADifferentEnclosingParameter_RunsCorrectly() {
        // Definition-of-done coverage: "same-spelled parameters with
        // different owners". `Keep`'s own `U` SHADOWS Outer's `U` (a
        // distinct symbol — referencing `U` inside `Keep` resolves to
        // Keep's own, exactly like Issue1940's
        // GenericLocalFunction_ShadowingSameNameAsEnclosingTypeParameter_CompilesAndRunsWithoutGS0468),
        // while Keep ALSO references Outer's OTHER (differently named) type
        // parameter `A` — proving the shadow does not also block reification
        // of a genuinely enclosing parameter under a different name.
        let source = `package P
func Outer[A, U](a A, seed U) U {
    let Keep[U] = func (x U, y A) U {
        return x
    }
    return Keep(seed, a)
}
Console.WriteLine(Outer(1, "shadowed"))
Console.WriteLine(Outer("x", 123))`
        let output = CompileAndRun(source)
        Assert.Equal("shadowed${Environment.NewLine}123${Environment.NewLine}", output)
    }

    @Fact
    func CapturingGenericLocalOwnConstraintReferencingEnclosingTypeParameter_StillReportsGS0468() {
        // The one combination issue #4223 explicitly leaves unsupported (see
        // the Issue1940 test-class remarks): a CAPTURING generic local
        // function whose OWN type parameter's constraint references an
        // enclosing type parameter. Confirmed by direct repro: before this
        // diagnostic was restored for exactly this shape, it compiled clean
        // but threw System.TypeLoadException on the synthesized closure class
        // the moment `Outer` executed (the constraint's GenericParamConstraint
        // row still names the ORIGINAL enclosing `U`, which the closure class
        // never redeclares). The non-capturing sibling of this shape is
        // covered by GenericLocalOwnTypeParameterConstraintReferencesEnclosingTypeParameter_RunsCorrectly
        // above and works correctly.
        let source = `package P
import System

func Outer[U IComparable[U]](seed U) bool {
    var count = 0
    let Keep[T IComparable[U]] = func (x T, y U) bool {
        count = count + 1
        return x.CompareTo(y) == 0
    }
    return Keep(seed, seed)
}
Outer(5)`
        let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0468", stdout + stderr)
    }

    @Fact
    func CapturingGenericLocalReferencingEnclosingTypeParameterInOwnSignature_StillReportsGS0468() {
        // A CAPTURING generic local function whose own parameter/return type
        // (not merely a constraint) directly references an enclosing type
        // parameter is likewise unsupported — the capturing path (issue
        // #4221/#4252) hosts the local's own type parameters on a
        // synthesized closure class's Invoke method, and that path has not
        // been extended to also reify a referenced ENCLOSING type parameter
        // for a GENERIC-own-type-parameter local (only the non-generic
        // capturing case — Issue2016's
        // NonGenericLocalFunction_CapturesOuterVariableAndReferencesEnclosingTypeParameterInOwnParameter_CompilesAndRunsWithoutGS0468
        // — already worked, via the unrelated pre-#4221 ordinary closure
        // path). Confirmed by direct repro: this compiled clean but crashed
        // (TypeLoadException) before this diagnostic was restored for it.
        let source = `package P
func Outer[U](seed U) U {
    var count = 0
    let Keep[T] = func (x T, y U) U {
        count = count + 1
        return y
    }
    return Keep(1, seed)
}
Outer("hi")`
        let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0468", stdout + stderr)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string, expectSuccess bool)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4223_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                if !expectSuccess {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
