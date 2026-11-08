// <copyright file="Issue5239And5654NarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// ADR-0208 regression tests for issues #5239 (enclosing catch-filter invalidation
/// skips shadowing locals declared inside the protected `try` block) and #5654
/// (statement-level narrowing removals in a `then`-branch are journaled and
/// restored for the sibling `else`-branch).
open class Issue5239And5654NarrowingTests {
    @Theory
    @MemberData("Rows")
    func NarrowingProbes_ProduceExpectedDiagnosticsAndOutput(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5239_5654_").FullName
        try {
            let srcPath = Path.Combine(tempDir, name + ".gs")
            let outPath = Path.Combine(tempDir, name + ".dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            let log = compileOut.ToString() + compileErr.ToString()
            let actualDiagnostics = string.Join(
                " ",
                Regex
                    .Matches(log, `\((\d+),(\d+),\d+,\d+\): (?:error|warning) (GS\d+)`)
                    .Select((m Match) -> m.Groups[3].Value + "@" + m.Groups[1].Value + ":" + m.Groups[2].Value)
                    .Where((d string) -> !d.StartsWith("GS9100", StringComparison.Ordinal))
            )
            Assert.True(expectedDiagnostics == actualDiagnostics, "${name}: diagnostics changed. Log:\n${log}")
            if kind == "reject" {
                Assert.False(File.Exists(outPath), "${name} must not compile. Log:\n${log}")
                return
            }
            Assert.True(File.Exists(outPath), "${name} must compile. Log:\n${log}")
            IlVerifier.Verify(outPath)
            let (exit, stdout, stderr) = RunDotnet(outPath)
            Assert.True(exit == 0, "${name} must run to completion. Exit ${exit}:\n${stderr}")
            let lines = stdout
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
            Assert.Equal(expectedOutput, string.Join("|", lines))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 30000

        func Rows() IEnumerable[[]object] {
            yield []object{"r5239_shadowed_let_in_try_keeps_narrowing_in_inner_catch", `import System

func Get() string? { return "abc" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    try {
        let s string? = Get()
        if s == nil { return 0 }
        try {
            throw Exception("x")
        } catch {
            return s.Length
        }
    } catch (FormatException) when Clear(ref s) {
        return 0
    }
}
Console.WriteLine(Run())`, "", "run", "3"}
            yield []object{"r5239_shadowed_var_in_loop_inside_try_keeps_narrowing_W8", `import System

func Get() string? { return "abcd" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    try {
        var s string? = Get()
        if s == nil { return 0 }
        for var i = 0; i < 1; i++ {
            try {
                throw Exception("x")
            } catch {
                return s.Length
            }
        }
        return 0
    } catch (FormatException) when Clear(ref s) {
        return 0
    }
}
Console.WriteLine(Run())`, "", "run", "4"}
            yield []object{"r5239_control_outer_var_read_in_inner_catch_is_rejected", `import System

func Get() string? { return "abc" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    try {
        if s == nil { return 0 }
        try {
            throw Exception("x")
        } catch {
            return s.Length
        }
    } catch (FormatException) when Clear(ref s) {
        return 0
    }
}
Console.WriteLine(Run())`, "GS0158@15:22", "reject", ""}
            yield []object{"r5654_then_branch_assignment_does_not_remove_fact_for_else_branch", `import System

func Run(s string?, c bool) int32 {
    var t = s
    if t == nil { return 0 }
    if c {
        t = nil
    } else {
        return t.Length
    }
    return 0
}
Console.WriteLine(Run("abc", false))`, "", "run", "3"}
            yield []object{"r5654_if_let_then_branch_assignment_does_not_remove_fact_for_else_branch", `import System

func Run(s string?, maybe string?) int32 {
    var t = s
    if t == nil { return 0 }
    if let v = maybe {
        t = nil
    } else {
        return t.Length
    }
    return 0
}
Console.WriteLine(Run("abcd", nil))`, "", "run", "4"}
            yield []object{"r5654_control_read_after_if_else_when_then_assigns_nil_is_rejected", `import System

func Run(s string?, c bool) int32 {
    var t = s
    if t == nil { return 0 }
    if c {
        t = nil
    } else {
    }
    return t.Length
}
Console.WriteLine(Run("abc", true))`, "GS0158@10:14", "reject", ""}
            yield []object{"r5654_short_circuit_condition_block_in_then_branch_does_not_remove_fact_for_else_branch", `import System

func Run(s string?, c bool, k int32) int32 {
    var t = s
    if t == nil { return 0 }
    if c {
        if k == 1 && ({
            t = nil
            false
        }) {
        }
    } else if k == 0 {
        return t.Length
    }
    return 0
}
Console.WriteLine(Run("abcde", false, 0))`, "", "run", "5"}
            yield []object{"r5654_control_condition_block_before_else_branch_is_rejected", `import System

func Run(s string?, k int32) int32 {
    var t = s
    if t == nil { return 0 }
    if ({
        t = nil
        false
    }) && k == 1 {
    } else if k == 0 {
        return t.Length
    }
    return 0
}
Console.WriteLine(Run("abc", 0))`, "GS0158@11:18", "reject", ""}
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Stdout string, Stderr string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "", "timed out after ${RunTimeout / 1000}s.")
            }
            return (process.ExitCode, stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
