// <copyright file="Issue1475NullConditionalUserValueTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1475 — a null-conditional access `recv?.Member` whose result is a
/// value-type `Nullable<T>` where `T` is a user-declared value
/// type (enum or struct, with no runtime `ClrType`) previously emitted
/// `ldnull` for the receiver-null branch instead of
/// `default(Nullable<T>)`. That produced unverifiable IL
/// (`StackUnexpected`/`PathStackUnexpected`: "found Nullobjref,
/// expected value 'System.Nullable`1<...>'") and an
/// `InvalidProgramException` at runtime. BCL value-type underlyings
/// (e.g. `int32?`) already worked.
/// - Facet A — `?.` yielding `Nullable<user-enum>`: the minimal repro; null receiver then non-null.
/// - Facet B — `?.` yielding `Nullable<user-STRUCT>`, proving the fix generalises to struct
/// underlyings, not just enums.
/// - Facet C — chained `a?.b?.c` where the intermediate is already a `Nullable<userT>` (ADR-0073 /
/// #710): the not-null branch must NOT double-wrap.
/// Each test uses a UNIQUE package + user-type names because the in-process emit
/// tests share a process and a name-keyed type cache.
open class Issue1475NullConditionalUserValueTypeEmitTests {
    @Fact
    func EndToEnd_FacetA_NullConditionalUserEnum_Runs() {
        let source = `package N1475A
import System
enum ColA1475 { Red; Green }
class InnerA1475 {
    prop C ColA1475 { get; init; }
}
class BoxA1475 {
    var inner InnerA1475?
    prop ColorOpt ColA1475? -> inner?.C
}
func Main() {
    let b = BoxA1475()
    Console.WriteLine(b.ColorOpt == nil)
    b.inner = InnerA1475() { C = ColA1475.Green }
    Console.WriteLine(b.ColorOpt == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetB_NullConditionalUserStruct_Runs() {
        let source = `package N1475B
import System
struct PtB1475 {
    var X int32
    var Y int32
}
class InnerB1475 {
    prop P PtB1475 { get; init; }
}
class BoxB1475 {
    var inner InnerB1475?
    prop PointOpt PtB1475? -> inner?.P
}
func Main() {
    let b = BoxB1475()
    Console.WriteLine(b.PointOpt == nil)
    b.inner = InnerB1475() { P = PtB1475{X: 3, Y: 4} }
    Console.WriteLine(b.PointOpt == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetC_ChainedNullConditionalUserStruct_NoDoubleWrap_Runs() {
        let source = `package N1475C
import System
struct PtC1475 {
    var X int32
    var Y int32
}
class InnerC1475 {
    prop P PtC1475 { get; init; }
}
class MidC1475 {
    var inner InnerC1475?
    prop PointOpt PtC1475? -> inner?.P
}
class BoxC1475 {
    var mid MidC1475?
    prop Chained PtC1475? -> mid?.PointOpt
}
func Main() {
    let b = BoxC1475()
    Console.WriteLine(b.Chained == nil)
    let m = MidC1475()
    m.inner = InnerC1475() { P = PtC1475{X: 3, Y: 4} }
    b.mid = m
    Console.WriteLine(b.Chained == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1475_exe_").FullName
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
