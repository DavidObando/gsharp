// <copyright file="Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests.cs" company="GSharp">
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

/// Issue #2016 / issue #4223: the non-generic sibling of #1940. A NON-generic local function
/// (`let Name = func (...) ... {...}`, no `[T, ...]` of its own) that captures no outer
/// variables is hoisted to a top-level static method (issue #1469's zero-capture fast path) UNLESS
/// it is nested inside a user type purely for accessibility
/// (`ClosureEmitter.SynthesizeClosures`). Before issue #2118 / #4223, a direct reference to an
/// enclosing type parameter in the local function's OWN parameter type, return type, or body had no
/// corresponding CLR slot on that hoisted method and silently emitted invalid IL that crashed at run
/// time with (cref:BadImageFormatException) — GS0468 (issue #2016) turned that into a
/// compile-time diagnostic instead of fixing the capability. Issue #4223 finishes the job:
/// `UserTokenResolver.TryPromoteNonCapturingGenericLambda` (issue #2118) now reifies every
/// referenced enclosing type parameter as an additional method type parameter of the hoisted method,
/// so these shapes compile AND run correctly — GS0468 no longer fires for them. These tests assert
/// the positive capability (correct compilation and runtime behavior, verified across multiple type
/// arguments where the shape allows it) and retain the diagnostic only for genuinely unsupported
/// shapes (a CAPTURING local function, tested separately).
open class Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests {
    @Fact
    func NonGenericLocalFunction_ParameterReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468() {
        let source = `package P

func Outer[U](seed U) U {
    let Local = func (x U) U {
        return x
    }
    Console.WriteLine(Local(seed))
    return seed
}
Outer("hi")
Outer(42)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_VarDeclared_ParameterReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468() {
        // Follow-up review of #2024: the original #2016 fix's gate only fired
        // for `let`-bound locals (`syntax.Keyword?.Kind == SyntaxKind.LetKeyword`).
        // A `var`-declared local function of the exact same zero-capture shape
        // bypassed the diagnostic entirely and reproduced the ORIGINAL #2016
        // crash (compiles clean, then BadImageFormatException at run time) —
        // the emitter's zero-capture hoisting path doesn't distinguish let/var.
        // Issue #4223 makes the shape itself correct, so `var` and `let` both
        // compile and run the same way.
        let source = `package P

func Outer[U](seed U) U {
    var Local = func (x U) U {
        return x
    }
    Console.WriteLine(Local(seed))
    return seed
}
Outer("hi")
Outer(42)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_ConstDeclared_ParameterReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468() {
        // Same zero-capture shape via `const` — the third variable-declaration
        // keyword. The check keys off the bound initializer being a
        // BoundFunctionLiteralExpression, not the declaring keyword, so all
        // three (`let`/`var`/`const`) must be covered.
        let source = `package P

func Outer[U](seed U) U {
    const Local = func (x U) U {
        return x
    }
    Console.WriteLine(Local(seed))
    return seed
}
Outer("hi")
Outer(42)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericAsyncLocalFunction_ParameterReferencesEnclosingMethodTypeParameter_StillReportsGS0468() {
        // Follow-up review of #2024: an earlier revision short-circuited this
        // check for `literal.Function.IsAsync`, assuming an async local
        // function's state-machine hoisting reifies the enclosing type
        // parameter safely. Verified false AT THE TIME: the zero-capture async
        // local function's kickoff method was the un-parameterized top-level
        // static method, and its synthesized state-machine struct never
        // re-declared the enclosing type parameter either.
        //
        // Issue #4223 fixes the BODY/RETURN-TYPE shape of this for real (see
        // NonGenericAsyncLocalFunction_BodyOrReturnTypeReferencesEnclosingMethodTypeParameter_RunsCorrectlyForMultipleTypes
        // below): ReflectionMetadataEmitter.RegisterStateMachineEnclosingGenerics
        // now aliases each ORIGINAL enclosing type parameter promoted by
        // TryPromoteNonCapturingGenericLambda onto the state machine's own
        // class slot (mirroring the analogous ITERATOR fix already applied by
        // RegisterGeneratedGenericRemaps).
        //
        // This exact PARAMETER-referencing shape is a different, still-unsafe
        // route: it goes through the async "erased delegate" adapter (predates
        // #2118, used whenever a function-literal's declared type mentions an
        // open type parameter), not through RegisterStateMachineEnclosingGenerics.
        // That adapter's parameter-unboxing conversion has a confirmed defect
        // for a value-typed instantiation — confirmed by direct repro: this
        // exact source, if allowed to compile, runs `Outer("hi")` successfully
        // but throws `NullReferenceException` for `Outer(42)` (identical to an
        // already-legal CAPTURING async lambda of the same shape, so the
        // adapter defect itself is pre-existing and unrelated to #4223 — but
        // relaxing GS0468 here would trade this shape's previous compile-time
        // rejection for a runtime crash on a per-instantiation basis, which the
        // issue's own guidance rules out: "Relax GS0468 only for routes with
        // proven valid emission"). GS0468 is retained for exactly this
        // combination (see LambdaBinder.CheckAsyncNonGenericLocalFunctionEnclosingTypeParameterInParameter).
        let source = `package P

func Outer[U](seed U) U {
    let Local = async func (x U) U {
        return x
    }
    return Local(seed).Result
}
Outer("hi")`
        let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0468", stdout + stderr)
    }

    @Fact
    func NonGenericAsyncLocalFunction_BodyOrReturnTypeReferencesEnclosingMethodTypeParameter_RunsCorrectlyForMultipleTypes() {
        // The safe sibling of the still-rejected parameter-referencing shape
        // above: the enclosing type parameter appears only in the RETURN type
        // and the BODY (a local variable declaration), never in Local's own
        // parameter list, so this does not touch the async erased-delegate
        // adapter at all. Verified for both a reference type and a VALUE type
        // instantiation to rule out the exact defect the parameter-referencing
        // shape hits.
        let source = `package P

func Outer[U](seed U) U {
    let Local = async func () U {
        let z U = seed
        return z
    }
    return Local().Result
}
Console.WriteLine(Outer("hi"))
Console.WriteLine(Outer(42))`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_ReturnTypeReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468() {
        let source = `package P

func Outer[U]() U {
    let Local = func () U {
        return default
    }
    return Local()
}
Console.WriteLine(Outer[string]())
Console.WriteLine(Outer[int32]())`
        let output = CompileAndRun(source)
        Assert.Equal("${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_BodyReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468() {
        let source = `package P

func Outer[U]() {
    let Local = func () {
        let z U = default
        Console.WriteLine(z)
    }
    Local()
}
Outer[string]()
Outer[int32]()`
        let output = CompileAndRun(source)
        Assert.Equal("${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_ReferencesEnclosingGenericClassTypeParameter_CompilesAndRunsWithoutGS0468() {
        let source = `package P

class Box[U] {
    func Run(seed U) {
        let Local = func (x U) U {
            return x
        }
        Console.WriteLine(Local(seed))
    }
}
let b1 = Box[string]{}
b1.Run("hi")
let b2 = Box[int32]{}
b2.Run(7)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_CapturesOuterVariableAndReferencesEnclosingTypeParameterInOwnParameter_CompilesAndRunsWithoutGS0468() {
        // A NON-generic local function that BOTH captures an outer variable
        // AND directly references an enclosing type parameter in its OWN
        // parameter type routes through ClosureEmitter's ordinary (pre-#4221)
        // capturing closure path — SynthesizeDisplayClass already reifies any
        // enclosing type parameter referenced by the literal's parameters,
        // return type, or body, regardless of capture status. Must not
        // false-positive.
        let source = `package P

func Outer[U](seed U) U {
    var count = 0
    let Local = func (x U) U {
        count = count + 1
        return x
    }
    Console.WriteLine(Local(seed))
    return seed
}
Console.WriteLine(Outer("hi"))
Console.WriteLine(Outer(7))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "hi${Environment.NewLine}hi${Environment.NewLine}7${Environment.NewLine}7${Environment.NewLine}",
            output
        )
    }

    @Fact
    func NonGenericLocalFunction_NoEnclosingGeneric_CompilesAndRunsWithoutGS0468() {
        // No enclosing generic method/class in scope at all — must not false-positive.
        let source = `package P

func Foo() int32 {
    let Local = func (x int32) int32 {
        return x
    }
    return Local(42)
}
Console.WriteLine(Foo())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_CapturesOuterVariableOfEnclosingTypeParameterType_CompilesAndRunsWithoutGS0468() {
        // A local function that CAPTURES an outer variable (of the enclosing type
        // parameter's type) routes through the already-reified closure path
        // (issues #1477/#1512), not the zero-capture fast path — must not
        // false-positive.
        let source = `package P

func Outer[U](seed U) U {
    let Echo = func () {
        var z U = seed
        Console.WriteLine(z)
    }
    Echo()
    return seed
}
Console.WriteLine(Outer("hi"))`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericLocalFunction_InNonGenericClassMemberReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468() {
        // The zero-capture local function is nested inside a NON-generic user
        // type (for accessibility, issue #1469); that nested display class is
        // already reified over the enclosing generic method's own type
        // parameter, so this genuinely compiles and runs correctly — must not
        // false-positive.
        let source = `package P

class Box {
    func Run[U](seed U) {
        let Local = func (x U) U {
            return x
        }
        Console.WriteLine(Local(seed))
    }
}
let b = Box{}
b.Run("hi")`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_2016_").FullName
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
