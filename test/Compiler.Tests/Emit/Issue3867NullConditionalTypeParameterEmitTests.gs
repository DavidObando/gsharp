// <copyright file="Issue3867NullConditionalTypeParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3867 — a null-conditional access whose receiver is an OPEN type
/// parameter (`func F[T](v T)` then `v?.M()`) probed the receiver with
/// a bare `brtrue` over the raw `!!T` stack slot. `!!T` is not a
/// branchable object reference, so:
/// - ilverify rejected the body with `StackUnexpected` (7 of the 19 findings in the migrated
/// `test/Core.Tests`, issue #3863); and
/// - at runtime the null probe degenerated into a VALUE test, so `F[int32](0)` silently took the nil
/// path and produced `nil` instead of calling the member on `0`.
/// The receiver is now boxed before the probe, exactly as csc lowers
/// `v?.M()` (ECMA-335 §III.4.1: boxing an unconstrained type parameter
/// yields `null` only for an empty `Nullable<T>`, a real object
/// reference for any other value type, and the reference itself for a reference
/// type).
///
/// The `Nullable<user value type>` arm of the same probe already had
/// coverage in `Issue1475NullConditionalUserValueTypeEmitTests`; these
/// tests pin the open-type-parameter arm. Every test EXECUTES the emitted
/// assembly — ilverify alone would have accepted a body that still answered
/// `nil` for a zero-valued struct.
open class Issue3867NullConditionalTypeParameterEmitTests {
    /// The runtime half: a zero-valued `int32` flowing through
    /// `value?.ToString()` on an unconstrained `T` must render
    /// `"0"`. Before the fix this printed `<nil>` — a silent
    /// wrong answer that compiled clean.
    @Fact
    func EndToEnd_UnconstrainedTypeParameter_ZeroValuedStruct_IsNotNil() {
        let source = `package N3867A
import System
class C3867A {
    shared {
        func Render[T](value T) string {
            return value?.ToString() ?? "<nil>"
        }
    }
}
func Main() {
    Console.WriteLine(C3867A.Render[int32](0))
    Console.WriteLine(C3867A.Render[int32](7))
    Console.WriteLine(C3867A.Render[string]("hi"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}7${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    /// A user struct type argument whose default instance is all-zero: the same
    /// value test that swallowed `int32(0)` swallows it too. Also proves
    /// the boxed probe still dispatches through `constrained. !!T` to the
    /// struct's own `ToString` rather than boxing away the override.
    @Fact
    func EndToEnd_UnconstrainedTypeParameter_ZeroValuedUserStruct_IsNotNil() {
        let source = `package N3867B
import System
struct Pt3867B {
    var X int32
    override func ToString() string {
        return "Pt(" + this.X.ToString() + ")"
    }
}
class C3867B {
    shared {
        func Render[T](value T) string {
            return value?.ToString() ?? "<nil>"
        }
    }
}
func Main() {
    Console.WriteLine(C3867B.Render[Pt3867B](Pt3867B{X: 0}))
    Console.WriteLine(C3867B.Render[Pt3867B](Pt3867B{X: 5}))
}`
        let output = CompileAndRun(source)
        Assert.Equal("Pt(0)${Environment.NewLine}Pt(5)${Environment.NewLine}", output)
    }

    /// Anti-vacuity guard for the two tests above: a REFERENCE type argument
    /// must still take the nil path when the value really is nil. A "box
    /// everything and always branch" fix would pass the tests above and fail
    /// this one.
    @Fact
    func EndToEnd_UnconstrainedTypeParameter_NilReference_StillTakesNilPath() {
        let source = `package N3867C
import System
class C3867C {
    shared {
        func Render[T](value T) string {
            return value?.ToString() ?? "<nil>"
        }
    }
}
func Main() {
    var s string? = nil
    Console.WriteLine(C3867C.Render[string?](s))
    Console.WriteLine(C3867C.Render[string?]("here"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("<nil>${Environment.NewLine}here${Environment.NewLine}", output)
    }

    /// The instance-member shape the migrated `test/Core.Tests` handler
    /// fixtures actually use: a generic method on a STRUCT whose body discards
    /// the result of a call taking `value?.ToString()`. This is the exact
    /// body that produced `StackUnexpected` on
    /// `PrefixedInterpolatedStringHandler::AppendFormatted(!!0)`.
    @Fact
    func EndToEnd_GenericMethodOnStruct_AppendsZeroValuedStruct() {
        let source = `package N3867D
import System
import System.Text
struct H3867D {
    var builder StringBuilder
    func AppendFormatted[T](value T) {
        this.builder.Append(value?.ToString())
    }
    override func ToString() string {
        return this.builder.ToString()
    }
}
func Main() {
    var h = H3867D{builder: StringBuilder()}
    h.AppendFormatted[int32](0)
    h.AppendFormatted[string]("x")
    Console.WriteLine(h.ToString())
}`
        let output = CompileAndRun(source)
        Assert.Equal("0x${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3867_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) {
                    // Best-effort temp cleanup; a locked file must not fail the test.

                } catch (UnauthorizedAccessException) {
                    // Best-effort temp cleanup.

                }
            }
        }
    }
}
