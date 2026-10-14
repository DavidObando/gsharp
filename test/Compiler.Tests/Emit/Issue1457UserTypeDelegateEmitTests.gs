// <copyright file="Issue1457UserTypeDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1457 — a `func` literal / lambda whose signature mentions a
/// same-compilation user type (especially a user value type such as a
/// `data struct`) was realised with the wrong delegate type. A LINQ
/// `Sum<TSource>(IEnumerable<TSource>, Func<TSource,long>)`
/// bound with `TSource = SampleEntry` emitted `Func<object,int64>`
/// instead of `Func<SampleEntry,int64>`, forcing an unverifiable
/// `object -> SampleEntry` unbox (GS9998) — or, after a naive unbox patch,
/// an ilverify `StackUnexpected` + runtime segfault. The fix preserves the
/// same-compilation user type in the erased-adapter slots so the delegate reifies
/// through the `Func`N`/`Action`N` TypeSpec path (ADR-0087 §3 R6),
/// matching the reified generic call site.
open class Issue1457UserTypeDelegateEmitTests {
    @Fact
    func EndToEnd_SumOverUserValueTypeSelector_Runs() {
        let source = `package Probe1457a
import System
import System.Linq
import System.Collections.Generic

data struct SampleEntryA(FrameCount uint32, FrameDelta uint32)

func Main() {
    let lst = List[SampleEntryA]()
    lst.Add(SampleEntryA(1, 2))
    let s = uint32(lst.Sum((e SampleEntryA) -> e.FrameCount))
    Console.WriteLine(s)
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_WhereAndSelectOverUserValueType_Runs() {
        let source = `package Probe1457b
import System
import System.Linq
import System.Collections.Generic

data struct EntryB(Id uint32, Name string)

func Main() {
    let lst = List[EntryB]()
    lst.Add(EntryB(1, "alpha"))
    lst.Add(EntryB(2, "beta"))
    let filtered = lst.Where((e EntryB) -> e.Id > 1u).ToList()
    Console.WriteLine(filtered.Count)
    let names = lst.Select((e EntryB) -> e.Name).ToList()
    Console.WriteLine(names[0])
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}alpha${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SumOverUserReferenceType_Runs() {
        let source = `package Probe1457c
import System
import System.Linq
import System.Collections.Generic

class WidgetC {
    var Cost int32
    init(c int32) { this.Cost = c }
}

func Main() {
    let widgets = List[WidgetC]()
    widgets.Add(WidgetC(10))
    widgets.Add(WidgetC(20))
    let total = widgets.Sum((w WidgetC) -> w.Cost)
    Console.WriteLine(total)
}`
        let output = CompileAndRun(source)
        Assert.Equal("30${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FuncLiteralStoredInVariableThenInvoked_Runs() {
        let source = `package Probe1457d
import System

data struct PointD(X int32, Y int32)

func Main() {
    let f = (p PointD) -> p.X + p.Y
    Console.WriteLine(f(PointD(3, 4)))
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1457_exe_").FullName
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
                } catch { }
            }
        }
    }
}
