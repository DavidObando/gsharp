// <copyright file="Issue568UsingLetUserIDisposableTests.cs" company="GSharp">
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

/// Issue #568: `using let` on a G# class that implements
/// `IDisposable` was rejected with GS0119 because
/// `ConversionClassifier.TryBuildDisposeCall` could not find the
/// `Dispose()` method — the user class had no CLR type yet. The fix
/// adds a user-type path that probes `StructSymbol.TryGetMethodIncludingInherited`.
open class Issue568UsingLetUserIDisposableTests {
    @Fact
    func UsingLet_GSharpClassImplementingIDisposable_CallsDispose() {
        let source = `package Probe
import System

class Fixture : IDisposable {
    func Dispose() {
        Console.WriteLine("disposed")
    }
}

func test() {
    using let f = Fixture{}
    Console.WriteLine("inside")
}
test()`
        let output = CompileAndRun(source)
        Assert.Equal("inside${Environment.NewLine}disposed${Environment.NewLine}", output)
    }

    @Fact
    func UsingLet_GSharpClassInheritsDispose_FromBaseClass() {
        // A G# class whose base class provides Dispose should also work.
        let source = `package Probe
import System

open class BaseDisp : IDisposable {
    func Dispose() {
        Console.WriteLine("base-dispose")
    }
}

class Child : BaseDisp {
}

func test() {
    using let c = Child{}
    Console.WriteLine("used")
}
test()`
        let output = CompileAndRun(source)
        Assert.Equal("used${Environment.NewLine}base-dispose${Environment.NewLine}", output)
    }

    @Fact
    func UsingLet_NonDisposableType_StillReportsGS0119() {
        let source = `package Probe
import System

using let x = 42
Console.WriteLine(x)`
        let errors = CompileExpectingErrors(source)
        Assert.Contains(errors, (e string) -> e.Contains("GS0119"))
    }

    @Fact
    func UsingLet_GSharpClassInheritsDispose_FromImportedBaseClass() {
        // Issue #2148: a G# class deriving from an imported IDisposable CLR base
        // (MemoryStream : Stream : IDisposable) must be usable in a `using`
        // statement — the inherited Dispose lives on the imported base's CLR type.
        let source = `package Probe
import System
import System.IO

open class MyStream : MemoryStream {
    init() : base() {}
}

func test() {
    using let s = MyStream()
    s.WriteByte(1)
    Console.WriteLine("used")
}
test()`
        let output = CompileAndRun(source)
        Assert.Equal("used${Environment.NewLine}", output)
    }

    @Fact
    func AwaitUsingLet_GSharpClassInheritsDisposeAsync_FromImportedBaseClass() {
        // Issue #2148: the same fallback applies to `await using` — a G# class
        // deriving from an imported IAsyncDisposable base (Stream implements
        // IAsyncDisposable) resolves the inherited DisposeAsync on the CLR base.
        let source = `package Probe
import System
import System.IO

open class MyAsyncStream : MemoryStream {
    init() : base() {}
}

async func test() {
    await using let s = MyAsyncStream()
    s.WriteByte(1)
    Console.WriteLine("aused")
}
test().GetAwaiter().GetResult()`
        let output = CompileAndRun(source)
        Assert.Equal("aused${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue568_").FullName
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue568_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
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
