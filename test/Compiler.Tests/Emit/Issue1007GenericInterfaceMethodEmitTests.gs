// <copyright file="Issue1007GenericInterfaceMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit
import Xunit.Sdk

/// Issue #1007: a generic method declared inside an interface body —
/// `func Echo[T](x T) T;` — failed to parse, even though generic methods
/// parse fine on classes and as free functions. After the fix the
/// interface-member parser accepts the type-parameter list, the binder records
/// the method's generic arity, and the emitter writes a proper CLR generic
/// abstract slot (signature genericParameterCount + per-method
/// `GenericParam` rows). These tests compile and run an end-to-end
/// scenario where a class implements the generic interface method and a
/// top-level program invokes it through an interface-typed reference with an
/// explicit type argument, verifying behavior and that the emitted IL passes
/// `ilverify`.
open class Issue1007GenericInterfaceMethodEmitTests {
    @Fact
    func GenericInterfaceMethod_SingleTypeArg_ImplementedAndInvoked_Runs() {
        let source = `package P
import System

interface A {
    func Echo[T](x T) T;
}

class C : A {
    func Echo[T](x T) T { return x }
}

var a A = C()
Console.WriteLine(a.Echo[int32](42))
Console.WriteLine(a.Echo[string]("hi"))`
        Assert.Equal("42${Environment.NewLine}hi${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterfaceMethod_MultipleTypeArgs_ImplementedAndInvoked_Runs() {
        let source = `package P
import System

interface A {
    func Pair[T, U](a T, b U) U;
}

class C : A {
    func Pair[T, U](a T, b U) U { return b }
}

var a A = C()
Console.WriteLine(a.Pair[int32, string](1, "ok"))`
        Assert.Equal("ok${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterfaceMethod_NoParameters_ReturnsTypeArg_Runs() {
        // A bodyless generic interface method with no value parameters whose
        // type argument is supplied explicitly at the call site.
        let source = `package P
import System

interface A {
    func Make[T](seed T) T;
}

class C : A {
    func Make[T](seed T) T { return seed }
}

var a A = C()
Console.WriteLine(a.Make[int32](7))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterfaceMethod_ArityMismatchImplementation_StillRejectedGS0187() {
        // Negative guard: a same-name non-generic class method must not be
        // treated as implementing the generic interface slot.
        let source = `package P

interface A { func Echo[T](x T) T; }

class C : A {
    func Echo(x int32) int32 { return x }
}`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0187"))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1007_emit_").FullName
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
                } catch { }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1007_neg_").FullName
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
                        []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit != 0, (`expected gsc to report errors but it succeeded
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
