// <copyright file="Issue6_6EnumLiftedNullableArithmeticEmitTests.cs" company="GSharp">
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

/// Bug-overview item 6.6: §6.1 × §11.10 composition — lifted nullable
/// enum arithmetic. Verifies that enum arithmetic operators automatically
/// compose with the lifted-nullable binary arm.
open class Issue6_6EnumLiftedNullableArithmeticEmitTests {
    @Fact
    func EnumNullable_Plus_UnderlyingNullable_BothPresent() {
        let source = `package P
import System

var a System.DayOfWeek? = DayOfWeek.Monday
var b int32? = int32(2)
Console.WriteLine(a + b)`
        Assert.Equal("Wednesday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumNullable_Plus_UnderlyingNullable_LeftNull() {
        let source = `package P
import System

var a System.DayOfWeek? = nil
var b int32? = int32(2)
Console.WriteLine(a + b)`
        Assert.Equal(Environment.NewLine, CompileAndRun(source))
    }

    @Fact
    func EnumNullable_Plus_UnderlyingNullable_RightNull() {
        let source = `package P
import System

var a System.DayOfWeek? = DayOfWeek.Monday
var b int32? = nil
Console.WriteLine(a + b)`
        Assert.Equal(Environment.NewLine, CompileAndRun(source))
    }

    @Fact
    func EnumNullable_Minus_EnumNullable_BothPresent() {
        let source = `package P
import System

var a System.DayOfWeek? = DayOfWeek.Friday
var b System.DayOfWeek? = DayOfWeek.Monday
Console.WriteLine(a - b)`
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumNullable_Minus_EnumNullable_LeftNull() {
        let source = `package P
import System

var a System.DayOfWeek? = nil
var b System.DayOfWeek? = DayOfWeek.Monday
Console.WriteLine(a - b)`
        Assert.Equal(Environment.NewLine, CompileAndRun(source))
    }

    @Fact
    func EnumNullable_Minus_UnderlyingNullable_BothPresent() {
        let source = `package P
import System

var a System.DayOfWeek? = DayOfWeek.Friday
var b int32? = int32(1)
Console.WriteLine(a - b)`
        Assert.Equal("Thursday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UnderlyingNullable_Plus_EnumNullable_BothPresent() {
        let source = `package P
import System

var a int32? = int32(3)
var b System.DayOfWeek? = DayOfWeek.Monday
Console.WriteLine(a + b)`
        Assert.Equal("Thursday${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EnumNullable_Mixed_NonNullable_Underlying() {
        let source = `package P
import System

var a System.DayOfWeek? = DayOfWeek.Monday
Console.WriteLine(a + int32(4))`
        Assert.Equal("Friday${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        // ── Helpers (same pattern as Issue574 / Issue6_6 arithmetic) ───────
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue6_6_lifted_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
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

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
