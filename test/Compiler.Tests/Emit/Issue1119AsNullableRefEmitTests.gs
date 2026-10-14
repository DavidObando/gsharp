// <copyright file="Issue1119AsNullableRefEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1119: reference-type `as T?` (nullable reference target) must bind
/// AND emit. Previously `EmitAsExpression` only unwrapped the
/// `NullableTypeSymbol` for value-type targets, so a reference-type
/// `as Derived?` tried to resolve an element-type token for `Derived?`
/// and crashed emit with `GS9998 'Cannot resolve element type token'`.
/// Reference nullability is not a distinct CLR type, so the `isinst` target
/// must strip the nullable annotation to the underlying reference type.
open class Issue1119AsNullableRefEmitTests {
    @Fact
    func As_NullableRefType_EmitsCleanly_NoGs9998() {
        // The exact repro from the issue, compiled as a library.
        let source = `package p
open class Base {}
class Derived : Base { func F() int32 { return 1 } }
class C { func G(b Base) Derived? { return b as Derived? } }`
        let (exitCode, stdout, stderr) = CompileLibraryRaw(source)
        Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        Assert.DoesNotContain("GS9998", stdout)
    }

    @Fact
    func As_NullableRefType_ReturnsInstance_WhenMatch() {
        let source = `package Test
import System

open class Base {}
class Derived : Base { func F() int32 { return 7 } }

let b Base = Derived()
let d = b as Derived?
Console.WriteLine(d == nil)
if d != nil {
    Console.WriteLine(d.F())
}`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func As_NullableRefType_ReturnsNull_WhenMismatch() {
        let source = `package Test
import System

open class Base {}
class Derived : Base { func F() int32 { return 7 } }

let b Base = Base()
let d = b as Derived?
Console.WriteLine(d == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func As_NonNullableRefType_StillEmits_Regression() {
        let source = `package Test
import System

open class Base {}
class Derived : Base { func F() int32 { return 7 } }

let b Base = Derived()
let d = (b as Derived)!!
Console.WriteLine(d.F())`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func As_NullableValueType_StillWorks_WhenMatch() {
        let source = `package Test
import System

let boxed object = 42
let result = boxed as Int32?
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func As_NullableValueType_StillWorks_WhenMismatch() {
        let source = `package Test
import System

let boxed object = "hello"
let result = boxed as Int32?
Console.WriteLine(result == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileLibraryRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1119_lib_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
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
                if compileExit == 0 {
                    IlVerifier.Verify(outPath)
                }
                return (compileExit, compileOut.ToString(), compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1119_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
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
                if compileExit != 0 {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
                IlVerifier.Verify(outPath)
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

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
