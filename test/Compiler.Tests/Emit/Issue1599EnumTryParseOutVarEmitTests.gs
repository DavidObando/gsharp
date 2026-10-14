// <copyright file="Issue1599EnumTryParseOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1599: a generic BCL method whose type parameter carries a value-type
/// (`where T : struct`) constraint — canonically
/// `Enum.TryParse<TEnum>(string, out TEnum)` and its
/// `(string, bool, out TEnum)` overload — invoked with a SAME-COMPILATION
/// user enum both crashed the compiler with an internal `GS9999`
/// ((cref:System.Collections.Generic.KeyNotFoundException)) on the inline
/// `out var` form and failed to resolve at all (`GS0159`) with a
/// pre-declared receiver.
///
/// Root cause: overload resolution closes the method over a value-type
/// placeholder (because the user enum has no reference-context CLR type), and
/// that placeholder leaked into the inline `out var` local's type. The fix
/// recovers the out-parameter pointee from the explicit type-argument symbols
/// (generalizing to any value-type-constrained generic + `out var`) and
/// makes a pre-declared by-ref argument over a same-compilation user value type
/// match the value-type-constrained generic parameter.
///
/// These are end-to-end emit + execution tests: they compile via `gsc` and
/// run the produced assembly, asserting the parse succeeds and the recovered
/// value is the correct enum member (observed via `ToString()`, which for a
/// real emitted enum yields the member name). Each test uses a UNIQUE enum name
/// so the name-keyed FunctionTypeSymbol cache does not bleed across the shared
/// in-process test host.
open class Issue1599EnumTryParseOutVarEmitTests {
    @Fact
    func InlineOutVar_UserEnum_ResolvesBindsAndRuns_NoGS9999() {
        // Exact shape of the minimal repro from the issue.
        const source = `package Probe
import System

enum Palette1599A { Crimson, Emerald }

var ok = Enum.TryParse[Palette1599A]("Emerald", out var result)
Console.WriteLine(ok)
Console.WriteLine(result.ToString())`
        Assert.Equal("True${Environment.NewLine}Emerald${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InlineOutVar_UserEnum_ParseFailure_ReturnsFalse() {
        const source = `package Probe
import System

enum Palette1599B { Crimson, Emerald }

var ok = Enum.TryParse[Palette1599B]("Nope", out var result)
Console.WriteLine(ok)`
        Assert.Equal("False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InlineOutVar_IgnoreCaseOverload_Resolves() {
        // The three-argument `(string, bool ignoreCase, out TEnum)` overload.
        const source = `package Probe
import System

enum Palette1599C { Crimson, Emerald }

var ok = Enum.TryParse[Palette1599C]("emerald", true, out var result)
Console.WriteLine(ok)
Console.WriteLine(result.ToString())`
        Assert.Equal("True${Environment.NewLine}Emerald${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PreDeclaredReceiver_UserEnum_Resolves_NoGS0159() {
        // The pre-declared-receiver variant that previously failed with GS0159.
        const source = `package Probe
import System

enum Palette1599D { Crimson, Emerald }

var r Palette1599D = Palette1599D.Crimson
var ok = Enum.TryParse[Palette1599D]("Emerald", out r)
Console.WriteLine(ok)
Console.WriteLine(r.ToString())`
        Assert.Equal("True${Environment.NewLine}Emerald${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func BclEnum_TryParse_StillWorks_Regression() {
        // Control: a value-type constraint over a real BCL enum keeps working
        // (it is closed over the real CLR type, not the placeholder).
        const source = `package Probe
import System

var ok = Enum.TryParse[DayOfWeek]("Friday", out var d)
Console.WriteLine(ok)
Console.WriteLine(d.ToString())`
        Assert.Equal("True${Environment.NewLine}Friday${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1599_").FullName
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
                IlVerifier.Verify(outPath, nil, Array.Empty[string]())
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
                } catch {
                    // ignored

                }
            }
        }
    }
}
