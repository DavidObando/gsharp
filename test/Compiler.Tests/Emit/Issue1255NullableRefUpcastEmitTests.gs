// <copyright file="Issue1255NullableRefUpcastEmitTests.cs" company="GSharp">
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

/// Issue #1255: a nullable→nullable implicit reference conversion `T? -> U?`
/// (where `T` derives from or implements `U`) must bind AND emit. Both
/// sides share the underlying reference's CLR representation, so the upcast is a
/// metadata-only no-op (null stays null, a non-null value reference-upcasts).
/// These tests prove a real value round-trips through a nullable base/interface
/// slot and that null is preserved without an NRE on the upcast itself.
open class Issue1255NullableRefUpcastEmitTests {
    @Fact
    func NullableClassUpcast_NonNullValue_RoundTrips() {
        let source = `package Test
import System

open class Base { func Tag() int32 { return 5 } }
class Derived : Base { func Extra() int32 { return 9 } }

func Read(b Base?) int32 {
    if b != nil {
        return b.Tag()
    }
    return -1
}

let d Derived? = Derived()
Console.WriteLine(Read(d))`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func NullableClassUpcast_NullValue_StaysNull() {
        let source = `package Test
import System

open class Base { func Tag() int32 { return 5 } }
class Derived : Base { func Extra() int32 { return 9 } }

func Read(b Base?) int32 {
    if b != nil {
        return b.Tag()
    }
    return -1
}

let d Derived? = nil
Console.WriteLine(Read(d))`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}", output)
    }

    @Fact
    func NullableInterfaceUpcast_NonNullValue_RoundTrips() {
        let source = `package Test
import System

interface IBox { func Size() int32; }
class AppleListBox : IBox { func Size() int32 { return 42 } }

func Read(box IBox?) int32 {
    if box != nil {
        return box.Size()
    }
    return -1
}

let a AppleListBox? = AppleListBox()
Console.WriteLine(Read(a))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NullableInterfaceUpcast_NullValue_StaysNull() {
        let source = `package Test
import System

interface IBox { func Size() int32; }
class AppleListBox : IBox { func Size() int32 { return 42 } }

func Read(box IBox?) int32 {
    if box != nil {
        return box.Size()
    }
    return -1
}

let a AppleListBox? = nil
Console.WriteLine(Read(a))`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}", output)
    }

    @Fact
    func NullableClassUpcast_LetTarget_RoundTrips() {
        let source = `package Test
import System

open class Base { func Tag() int32 { return 5 } }
class Derived : Base {}

let d Derived? = Derived()
let b Base? = d
Console.WriteLine(b != nil)`
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

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1255_").FullName
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
