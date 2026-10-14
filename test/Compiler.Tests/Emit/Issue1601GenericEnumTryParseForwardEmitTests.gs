// <copyright file="Issue1601GenericEnumTryParseForwardEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1601 (follow-up to #1599): a generic BCL method whose type parameter
/// carries a value-type/`struct` constraint — canonically
/// `Enum.TryParse<TEnum>(string, out TEnum)` — invoked with a caller
/// type argument that is itself an in-scope generic type parameter constrained
/// to `Enum`/`struct` must resolve, bind the inline `out var` to
/// that type parameter, and emit a verifiable generic method specification.
///
/// Root cause: the forwarded type parameter `TEnum` is not a real runtime
/// (cref:Type), so it erases to a `System.Object` placeholder in the
/// CLR type-argument vector. The placeholder classifies as a reference type, so
/// the value-type placeholder closure (added by #1599) was skipped and the
/// candidate was dropped — reported as `GS0159`, which cascaded to
/// `GS0125` on the inline `out var` local. The fix classifies a
/// value-type-constrained type parameter as a value-type-erased symbol, exactly
/// like a same-compilation user value type.
///
/// These are end-to-end emit + execution tests. The generic method is invoked
/// with a real BCL enum ((cref:DayOfWeek)) so it can be exercised at
/// runtime, asserting the parse succeeds and the recovered value is the correct
/// enum member (observed via `ToString()`). Each test uses UNIQUE
/// function/type names so the name-keyed FunctionTypeSymbol cache does not bleed
/// across the shared in-process test host.
open class Issue1601GenericEnumTryParseForwardEmitTests {
    @Fact
    func GenericForward_InlineOutVar_ResolvesBindsAndRuns_NoGS0159() {
        // The generic function forwards its own Enum/struct-constrained type
        // parameter to Enum.TryParse[TEnum] with an inline `out var`.
        const source = `package Probe
import System

func Show1601A[TEnum Enum struct](sample TEnum, arg string) TEnum {
    if !Enum.TryParse[TEnum](arg, out var result) {
        return sample
    }
    return result
}

var hit = Show1601A[DayOfWeek](DayOfWeek.Monday, "Friday")
Console.WriteLine(hit.ToString())
var miss = Show1601A[DayOfWeek](DayOfWeek.Monday, "Nope")
Console.WriteLine(miss.ToString())`
        Assert.Equal("Friday${Environment.NewLine}Monday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericForward_IgnoreCaseOverload_ResolvesBindsAndRuns() {
        // The three-argument `(string, bool ignoreCase, out TEnum)` overload.
        const source = `package Probe
import System

func Show1601B[TEnum Enum struct](sample TEnum, arg string) TEnum {
    if !Enum.TryParse[TEnum](arg, true, out var result) {
        return sample
    }
    return result
}

var hit = Show1601B[DayOfWeek](DayOfWeek.Monday, "friday")
Console.WriteLine(hit.ToString())`
        Assert.Equal("Friday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericForward_PreDeclaredReceiver_ResolvesBindsAndRuns_NoGS0159() {
        // The pre-declared receiver variant: `out r` where `r` is typed by the
        // value-type-constrained type parameter.
        const source = `package Probe
import System

func Show1601C[TEnum Enum struct](sample TEnum, arg string) TEnum {
    var r TEnum = sample
    if !Enum.TryParse[TEnum](arg, out r) {
        return sample
    }
    return r
}

var hit = Show1601C[DayOfWeek](DayOfWeek.Monday, "Friday")
Console.WriteLine(hit.ToString())`
        Assert.Equal("Friday${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1601_").FullName
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
