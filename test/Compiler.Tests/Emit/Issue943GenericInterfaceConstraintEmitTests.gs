// <copyright file="Issue943GenericInterfaceConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #943 end-to-end coverage: a type-parameter constraint that names a
/// constructed generic CLR interface — e.g. `func Max[T IComparable[T]](...)`
/// — now parses, binds (so instance members of the constrained interface are
/// available on values of `T`), and emits verifiable IL with a
/// `constrained.`-prefixed `callvirt` plus a matching
/// `GenericParamConstraint` row. These tests round-trip each scenario
/// through compile → IL-verify → run, and assert the constraint is actually
/// enforced (a non-satisfying type argument is a binding error, GS0152).
open class Issue943GenericInterfaceConstraintEmitTests {
    @Fact
    func Max_With_IComparableConstraint_Roundtrips_Int32() {
        let source = `package P
import System

func Max[T IComparable[T]](a T, b T) T {
    if a.CompareTo(b) > 0 { return a }
    return b
}

Console.WriteLine(Max[int32](3, 7))
Console.WriteLine(Max[int32](10, 2))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}10${Environment.NewLine}", output)
    }

    @Fact
    func Max_With_IComparableConstraint_Roundtrips_String() {
        let source = `package P
import System

func Max[T IComparable[T]](a T, b T) T {
    if a.CompareTo(b) > 0 { return a }
    return b
}

Console.WriteLine(Max[string]("apple", "banana"))
Console.WriteLine(Max[string]("zebra", "yak"))`
        let output = CompileAndRun(source)
        Assert.Equal("banana${Environment.NewLine}zebra${Environment.NewLine}", output)
    }

    @Fact
    func AreEqual_With_IEquatableConstraint_Roundtrips() {
        let source = `package P
import System

func AreEqual[T IEquatable[T]](a T, b T) bool {
    return a.Equals(b)
}

Console.WriteLine(AreEqual[int32](5, 5))
Console.WriteLine(AreEqual[int32](5, 6))
Console.WriteLine(AreEqual[string]("hi", "hi"))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func Max_With_NonComparableTypeArgument_IsBindingError() {
        let source = `package P
import System

struct Box {
    var value int32
}

func Max[T IComparable[T]](a T, b T) T {
    if a.CompareTo(b) > 0 { return a }
    return b
}

var x = Box{value: 1}
var y = Box{value: 2}
var z = Max[Box](x, y)`
        let diagnostics = CompileExpectingFailure(source)
        Assert.Contains("GS0152", diagnostics)
        Assert.Contains("does not satisfy", diagnostics)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue943_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // Best-effort cleanup; ignore.

                }
            }
        }

        private func CompileExpectingFailure(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue943_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                let combined = compileOut.ToString() + compileErr.ToString()
                Assert.True(compileExit != 0, "expected compile to fail but it succeeded: $combined")
                return combined
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // Best-effort cleanup; ignore.

                }
            }
        }
    }
}
