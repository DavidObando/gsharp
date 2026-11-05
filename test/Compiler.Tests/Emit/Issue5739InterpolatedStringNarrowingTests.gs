// <copyright file="Issue5739InterpolatedStringNarrowingTests.cs" company="GSharp">
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

/// Regression coverage for issue #5739 (ADR-0208 R11, R12, R15): an interpolated string with a hole of a type other
/// than `string` or a built-in value type calls `ToString()`, which can run user code and clear narrowed mutable
/// globals and member-bearing paths in straight-line statements, `if` conditions, `defer` arguments, loops, and
/// backward-jump spans, while keeping primitive/`string` hole interpolations and `ref`/`out` parameter narrowings
/// under amendment A3.
open class Issue5739InterpolatedStringNarrowingTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5739-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(tempDir)
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
            Assert.True(
                expectedDiagnostics == actualDiagnostics,
                "${name}: expected [${expectedDiagnostics}] but found [${actualDiagnostics}]. Log:\n${log}"
            )
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
                .ToArray()
            Assert.NotEmpty(lines)
            Assert.Equal(expectedOutput, string.Join("|", lines))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func Rows_AreNonEmptyAndDistinct() {
        let names = Rows().Select((row[]object) -> cast[string](row[0])).ToArray()
        Assert.NotEmpty(names)
        Assert.Equal(names.Length, names.Distinct(StringComparer.Ordinal).Count())
    }

    shared {
        private const RunTimeout int32 = 30000

        public func Rows() IEnumerable[[]object] {
            yield[]object{"interpolation_tostring_removes_global_fact", `import System
class C {
    var Value int32 = 1
}
class Box {
    override func ToString() string {
        g = nil
        return "box"
    }
}
func Run(b Box) int32 {
    if g == nil { return 0 }
    let s = "$b"
    return g.Value + s.Length
}
var g C? = C{}
Console.WriteLine(Run(Box{}))`, "GS0158@14:14", "reject", ""}
            yield[]object{"interpolation_tostring_removes_member_path_fact", `import System
class C {
    var Value int32 = 1
}
class Holder {
    let Field C?
    init(field C?) { Field = field }
}
class Box {
    override func ToString() string {
        gHolder = Holder(nil)
        return "box"
    }
}
func Run(holder Holder, b Box) int32 {
    if holder.Field == nil { return 0 }
    let s = "$b"
    return holder.Field.Value + s.Length
}
var gHolder Holder = Holder(C{})
Console.WriteLine(Run(gHolder, Box{}))`, "GS0158@18:25", "reject", ""}
            yield[]object{"interpolation_in_if_condition_removes_global_and_member_path_facts", `import System
class C {
    var Value int32 = 1
}
class Holder {
    let Field C?
    init(field C?) { Field = field }
}
class Box {
    override func ToString() string {
        g = nil
        return "box"
    }
}
func RunGlobal(b Box) int32 {
    if g != nil {
        if "$b" == "box" {
            return g.Value
        }
        return g.Value
    }
    return 0
}
func RunMember(holder Holder, b Box) int32 {
    if holder.Field != nil {
        if "$b" == "box" {
            return holder.Field.Value
        }
        return holder.Field.Value
    }
    return 0
}
var g C? = C{}
Console.WriteLine(RunGlobal(Box{}) + RunMember(Holder(C{}), Box{}))`, "GS0158@18:22 GS0158@20:18 GS0158@27:33 GS0158@29:29", "reject", ""}
            yield[]object{"interpolation_in_loop_and_backward_jump_span_removes_global_and_member_path_facts", `import System
class C {
    var Value int32 = 1
}
class Holder {
    let Field C?
    init(field C?) { Field = field }
}
class Box {
    override func ToString() string {
        g = nil
        return "box"
    }
}
func InLoopHeader(b Box) int32 {
    while g != nil && "$b" == "box" {
        return g.Value
    }
    return 0
}
func InLoopBody(holder Holder, b Box, flag bool) int32 {
    while flag {
        if g != nil && holder.Field != nil {
            let s = "$b"
            return g.Value + holder.Field.Value + s.Length
        }
        return 0
    }
    return 0
}
func AcrossLoopEntry(holder Holder, b Box) int32 {
    if g == nil || holder.Field == nil { return 0 }
    var i = 0
    while i < 2 {
        let v = g.Value + holder.Field.Value
        let s = "$b"
        i = i + v + s.Length
    }
    return i
}
func InSpanAndAcrossSpanEntry(holder Holder, b Box, flag bool) int32 {
    if g == nil || holder.Field == nil { return 0 }
    var i = 0
    Again:
    let v = g.Value + holder.Field.Value
    let s = "$b"
    if g != nil && holder.Field != nil {
        let inner = "$b"
        i = i + g.Value + holder.Field.Value + inner.Length
    }
    i = i + v + s.Length
    if flag && i < 2 { goto Again }
    return i
}
var g C? = C{}
Console.WriteLine(InLoopHeader(Box{}) + InLoopBody(Holder(C{}), Box{}, true) + AcrossLoopEntry(Holder(C{}), Box{}) + InSpanAndAcrossSpanEntry(Holder(C{}), Box{}, true))`, "GS0158@17:18 GS0158@25:22 GS0158@25:43 GS0158@35:19 GS0158@35:40 GS0158@45:15 GS0158@45:36 GS0158@49:19 GS0158@49:40", "reject", ""}
            yield[]object{"interpolation_in_defer_argument_removes_global_and_member_path_facts", `import System
class C {
    var Value int32 = 1
}
class Holder {
    let Field C?
    init(field C?) { Field = field }
}
class Box {
    override func ToString() string {
        g = nil
        return "box"
    }
}
func Consume(s string) { }
func Run(holder Holder, b Box) int32 {
    if g == nil || holder.Field == nil { return 0 }
    defer Consume("$b")
    return g.Value + holder.Field.Value
}
var g C? = C{}
Console.WriteLine(Run(Holder(C{}), Box{}))`, "GS0158@19:14 GS0158@19:35", "reject", ""}
            yield[]object{"control_primitive_and_string_holes_keep_global_and_member_path_facts", `import System
class C {
    var Value int32 = 4
}
class Holder {
    let Field C?
    init(field C?) { Field = field }
}
func Run(holder Holder, n int32, flag bool, ch char, str string) int32 {
    var captured C? = C{Value: 5}
    let clear = func() { captured = nil }
    if g == nil || holder.Field == nil || captured == nil { return 0 }
    let s1 = "$n $flag $ch"
    let s2 = "$str"
    if "$n" == "0" || "$str" == "" {
        return 0
    }
    return g.Value + holder.Field.Value + captured.Value + s1.Length + s2.Length
}
var g C? = C{Value: 3}
Console.WriteLine(Run(Holder(C{Value: 6}), 42, true, 'x', "ok"))`, "", "run", "25"}
            yield[]object{"control_ref_parameter_kept_across_interpolation_tostring_A3", `import System
class Box {
    override func ToString() string -> "box"
}
func Consume(s string) { }
func Run(ref text string?, b Box) int32 {
    if text == nil { return 0 }
    let s = "$b"
    defer Consume("$b")
    if "$b" == "box" {
        var i = 0
        while i < 2 {
            i = i + text.Length
            let loopStr = "$b"
            i = i + loopStr.Length
        }
        Again:
        let spanStr = "$b"
        if i < 12 {
            i = i + text.Length + spanStr.Length
            goto Again
        }
        return text.Length + s.Length + i
    }
    return 0
}
var item string? = "hi"
Console.WriteLine(Run(ref item, Box{}))`, "", "run", "20"}
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
                } catch (InvalidOperationException) { }
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
