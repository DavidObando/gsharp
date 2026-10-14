// <copyright file="Issue1833EnumConstraintViolationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.IO
import Xunit

/// Issue #1833 (follow-up review note on PR #1832 / #1601): a value-type-erased
/// type argument that is `struct`-constrained but <b>not</b>
/// `Enum`-constrained — a concrete non-enum user struct, or a bare
/// `[T struct]` type parameter — passed to a BCL generic method whose
/// type parameter carries a real `System.Enum` base-class constraint
/// (`Enum.IsDefined<TEnum>`) must be rejected by the compiler with a
/// clear `GS0152` constraint-violation diagnostic at bind time. Before the
/// fix, `ClrOverloadResolution.SatisfiesGenericConstraints` unconditionally
/// treated any `System.Enum`-named base constraint as satisfied once the
/// argument was classified as a value-type-erased symbol, so the candidate
/// bound through overload resolution and only failed later — at CLR
/// verification/emit, or as a runtime crash — instead of failing cleanly here
/// at `gsc` compile time.
///
/// This is an end-to-end compiler-driver test (mirrors
/// `Issue1601GenericEnumTryParseForwardEmitTests.CompileAndRun`): it
/// invokes (cref:Program.Main(string[])) exactly as the `gsc` CLI
/// does and asserts the process reports a non-zero exit with the GS0152
/// diagnostic — never a PE emitted at all, and never an unhandled exception
/// (which would surface as a non-graceful crash instead of a diagnostic).
open class Issue1833EnumConstraintViolationEmitTests {
    @Fact
    func ConcreteNonEnumStruct_EnumIsDefined_FailsCompileWithConstraintDiagnostic_NotCrash() {
        const source = `package Probe
import System

struct Point1833A {
    var X int32
    var Y int32
}

var pt = Point1833A(1, 2)
var ok = Enum.IsDefined[Point1833A](pt)`
        let (exitCode, stdout, stderr) = Compile(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0152", stdout + stderr)
        Assert.DoesNotContain("GS9999", stdout + stderr)
        Assert.DoesNotContain("Unhandled exception", stdout + stderr)
    }

    @Fact
    func StructOnlyTypeParameter_ForwardedToEnumIsDefined_FailsCompileWithConstraintDiagnostic() {
        const source = `package Probe
import System

func Check1833B[T struct](v T) bool {
    return Enum.IsDefined[T](v)
}`
        let (exitCode, stdout, stderr) = Compile(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0152", stdout + stderr)
        Assert.DoesNotContain("GS9999", stdout + stderr)
        Assert.DoesNotContain("Unhandled exception", stdout + stderr)
    }

    shared {
        private func Compile(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1833_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (compileExit, compileOut.ToString(), compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
