// <copyright file="Issue1268StaticVirtualGenericInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// ADR-0089 / issue #1268 — end-to-end emit + execution of static-virtual
/// interface members dispatched through a type parameter whose constraint is a
/// *constructed generic* interface (the self-referential
/// `T : IData[T]` shape used by generic-math-style code). Validates that:
/// - the consumer's `constrained. !!T call` targets a MemberRef parented at the constructed interface's
/// TypeSpec (issue #1268 emit fix);
/// - the implementer's `MethodImpl` rows pair its static override against the constructed-interface
/// slot, so the runtime resolves the body (no `TypeLoadException`);
/// - both static-virtual methods and get-only / get-set properties work.
/// Each test compiles a concrete implementer, IL-verifies, executes, and
/// asserts the runtime value produced by the implementer's body.
open class Issue1268StaticVirtualGenericInterfaceEmitTests {
    @Fact
    func StaticVirtualMethod_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected() {
        let source = `package Probe
import System

interface IData[TData IData[TData]] {
    shared {
        func Size() int32;
    }
}

struct TrackNumber : IData[TrackNumber] {
    shared {
        func Size() int32 { return 11 }
    }
}

func Use[T IData[T]](w T) int32 {
    return T.Size()
}

func Main() {
    Console.WriteLine(Use(TrackNumber{}))
}`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}", output)
    }

    @Fact
    func StaticVirtualGetOnlyProperty_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected() {
        let source = `package Probe
import System

interface IData[TData IData[TData]] {
    shared {
        prop SizeInBytes int32 { get; }
    }
}

struct TrackNumber : IData[TrackNumber] {
    shared {
        prop SizeInBytes int32 { get { return 7 } }
    }
}

func Use[T IData[T]](w T) int32 {
    return T.SizeInBytes
}

func Main() {
    Console.WriteLine(Use(TrackNumber{}))
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func StaticVirtualGetSetProperty_ThroughSelfReferentialGenericConstraint_RunsAndReturnsExpected() {
        let source = `package Probe
import System

interface IData[TData IData[TData]] {
    shared {
        prop Tag int32 { get; set }
    }
}

struct TrackNumber : IData[TrackNumber] {
    shared {
        prop Tag int32 { get { return 42 } set { } }
    }
}

func Use[T IData[T]](w T) int32 {
    return T.Tag
}

func Main() {
    Console.WriteLine(Use(TrackNumber{}))
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func StaticVirtualMember_ThroughNonSelfReferentialGenericConstraint_RunsAndReturnsExpected() {
        let source = `package Probe
import System

interface IData[X] {
    shared {
        func Size() int32;
    }
}

struct TrackNumber : IData[int32] {
    shared {
        func Size() int32 { return 99 }
    }
}

func Use[T IData[int32]](w T) int32 {
    return T.Size()
}

func Main() {
    Console.WriteLine(Use(TrackNumber{}))
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1268_exe_").FullName
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
                IlVerifier.Verify(
                    dllPath,
                    ignoredErrorCodes: IlVerifier.KnownIssues.StaticVirtualInterface,
                    ignoredErrorScope: "<Program>\\.Use$$"
                )
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
                } catch { }
            }
        }
    }
}
