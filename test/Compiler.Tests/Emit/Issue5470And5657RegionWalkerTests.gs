// <copyright file="Issue5470And5657RegionWalkerTests.cs" company="GSharp">
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

/// Regression coverage for issues #5470 and #5657 (ADR-0213):
/// - #5470: bare property and field accesses reached through the default-interface and inherited-CLR fallbacks in
///   `ExpressionBinder.gs` resolve in `ResolveRegionWrites` with the same effect as `this.P` and `this.P = 1`.
/// - #5657: loop and backward-jump conversion sites use the one `ConversionsRunUserCode` classification for every
///   fact, keeping mutable globals, closure-assigned locals and member-bearing paths across conversion-free
///   declarations, assignments, conditions and returns while rejecting sites that can run a user conversion or
///   structural projection.
open class Issue5470And5657RegionWalkerTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5470_5657-" + Guid.NewGuid().ToString("N"))
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
            yield[]object{"dim_bare_getter_in_loop_and_span_removes_global_and_ref_facts_5470", `import System
class C { }
class State {
    shared {
        var Item C? = C()
    }
}
interface IReader {
    prop P int32 { get; }
    func ReadInLoop(ref item C?) int32 {
        if item == nil { return 0 }
        var n = 0
        while n < 2 {
            let b C = item
            let v = P
            n = n + 1
        }
        return n
    }
    func ReadInSpan(ref item C?) int32 {
        if item == nil { return 0 }
        var n = 0
        Again:
        let b C = item
        let v = P
        n = n + 1
        if n < 2 { goto Again }
        return n
    }
}
class BadReader : IReader {
    prop P int32 {
        get {
            State.Item = nil
            return 1
        }
    }
}
let r IReader = BadReader{}
Console.WriteLine(r.ReadInLoop(ref State.Item) + r.ReadInSpan(ref State.Item))`, "GS0155@14:23 GS0155@24:19", "reject", ""}
            yield[]object{"dim_bare_setter_in_loop_and_span_removes_global_and_ref_facts_5470", `import System
class C { }
class State {
    shared {
        var Item C? = C()
    }
}
interface IWriter {
    prop P int32 { get; set; }
    func WriteInLoop(ref item C?) int32 {
        if item == nil { return 0 }
        var n = 0
        while n < 2 {
            let b C = item
            P = 1
            n = n + 1
        }
        return n
    }
    func WriteInSpan(ref item C?) int32 {
        if item == nil { return 0 }
        var n = 0
        Again:
        let b C = item
        P = 1
        n = n + 1
        if n < 2 { goto Again }
        return n
    }
}
class BadWriter : IWriter {
    prop P int32 {
        get -> 1
        set { State.Item = nil }
    }
}
let w IWriter = BadWriter{}
Console.WriteLine(w.WriteInLoop(ref State.Item) + w.WriteInSpan(ref State.Item))`, "GS0155@14:23 GS0155@24:19", "reject", ""}
            yield[]object{"inherited_clr_bare_getter_in_loop_and_span_removes_global_and_ref_facts_5470", `import System
class C { }
open class BaseError : Exception {
    func ReadInLoop(ref item C?) int32 {
        if g == nil || item == nil { return 0 }
        var n = 0
        while n < 2 {
            let a C = g
            let b C = item
            let m = Message
            n = n + 1
        }
        return n
    }
    func ReadInSpan(ref item C?) int32 {
        if g == nil || item == nil { return 0 }
        var n = 0
        Again:
        let a C = g
        let b C = item
        let m = Message
        n = n + 1
        if n < 2 { goto Again }
        return n
    }
}
class BadError : BaseError {
    override prop Message string {
        get {
            g = nil
            return "boom"
        }
    }
}
var g C? = C()
var s C? = C()
let err BaseError = BadError()
Console.WriteLine(err.ReadInLoop(ref s) + err.ReadInSpan(ref s))`, "GS0155@8:23 GS0155@9:23 GS0155@19:19 GS0155@20:19", "reject", ""}
            yield[]object{"inherited_clr_bare_setter_in_loop_and_span_removes_global_and_ref_facts_5470", `import System
class C { }
open class BaseError : Exception {
    func WriteInLoop(ref item C?) int32 {
        if g == nil || item == nil { return 0 }
        var n = 0
        while n < 2 {
            let a C = g
            let b C = item
            HelpLink = "doc"
            n = n + 1
        }
        return n
    }
    func WriteInSpan(ref item C?) int32 {
        if g == nil || item == nil { return 0 }
        var n = 0
        Again:
        let a C = g
        let b C = item
        HelpLink = "doc"
        n = n + 1
        if n < 2 { goto Again }
        return n
    }
}
class BadError : BaseError {
    override prop HelpLink string? {
        get -> nil
        set { g = nil }
    }
}
var g C? = C()
var s C? = C()
let err BaseError = BadError()
Console.WriteLine(err.WriteInLoop(ref s) + err.WriteInSpan(ref s))`, "GS0155@8:23 GS0155@9:23 GS0155@19:19 GS0155@20:19", "reject", ""}
            yield[]object{"control_inherited_stable_clr_getter_and_non_open_auto_property_keep_ref_fact_5470", `import System
import System.Collections.Generic
class MyList : List[int32] {
    func SumInLoop(ref text string?) int32 {
        if text == nil { return 0 }
        var n = 0
        while text.Length > 0 && n < 2 {
            n = n + Count + 1
        }
        return n
    }
    func SumInSpan(ref text string?) int32 {
        if text == nil { return 0 }
        var n = 0
        Again:
        n = n + text.Length + Count
        if n < 3 { goto Again }
        return n
    }
}
class ClosedHolder {
    prop Auto int32 { get; set; }
    func ReadAutoInLoop(ref text string?) int32 {
        if text == nil { return 0 }
        var n = 0
        while text.Length > 0 && n < 2 {
            n = n + Auto + 1
        }
        return n
    }
}
var s string? = "ab"
let list = MyList()
list.Add(10)
let holder = ClosedHolder{}
holder.Auto = 2
Console.WriteLine(list.SumInLoop(ref s))
Console.WriteLine(list.SumInSpan(ref s))
Console.WriteLine(holder.ReadAutoInLoop(ref s))`, "", "run", "2|3|3"}
            yield[]object{"issue_5657_repro_and_conversion_free_sites_keep_global_fact", `import System
class C {
    var Value int32
}
func Run() C {
    if g == nil { return C() }
    while true {
        let n = 1
        return g
    }
    return C()
}
func RunSpan() int32 {
    if g == nil { return 0 }
    var k = 0
    Again:
    let step = 1
    let typedStep int32 = step
    var copy int32 = 0
    copy = typedStep
    k = k + 1
    if k < 2 { goto Again }
    return g.Value + k
}
var g C? = C{Value: 42}
Console.WriteLine(Run().Value)
Console.WriteLine(RunSpan())`, "", "run", "42|44"}
            yield[]object{"conversion_free_loop_sites_keep_closure_assigned_and_member_path_facts_5657", `import System
class C {
    var Value int32
}
class Box {
    let Item C?
    init(item C?) { Item = item }
}
func RunLoop(box Box) int32 {
    var local C? = C{Value: 10}
    let clear = func() { local = nil }
    if local == nil || box.Item == nil { return 0 }
    var k = 0
    while k < 3 {
        let delta = 1
        let same int32 = delta
        var copy int32 = 0
        copy = same
        k = k + 1
    }
    let total = local.Value + box.Item.Value + k
    if k < 0 { clear() }
    return total
}
func RunSpan(box Box) int32 {
    var local C? = C{Value: 4}
    let clear = func() { local = nil }
    var k = 0
    if local != nil && box.Item != nil {
        Again:
        let extra = 1
        var copy2 int32 = 0
        copy2 = extra
        k = k + 1
        if k < 2 { goto Again }
        let total = local.Value + box.Item.Value + k
        if k < 0 { clear() }
        return total
    }
    return 0
}
Console.WriteLine(RunLoop(Box(C{Value: 20})))
Console.WriteLine(RunSpan(Box(C{Value: 20})))`, "", "run", "33|26"}
            yield[]object{"control_user_conversion_and_projection_in_loop_remove_global_and_captured_facts_5657", `import System
class C { }
struct Source {
    var Raw int32
}
struct Target {
    var Raw int32
}
func operator implicit(s Source) Target {
    g = nil
    return Target{Raw: s.Raw}
}
class ProjSrc {
    prop Name string {
        get {
            g = nil
            return "n"
        }
    }
}
class ProjDst {
    var Name string = "d"
}
func WithDeclaration(s Source) int32 {
    if g == nil { return 0 }
    var k = 0
    while k < 2 {
        let a C = g
        let t Target = s
        k = k + 1
    }
    return k
}
func WithAssignment(s Source) int32 {
    var local C? = C()
    let clear = func() { local = nil }
    if local == nil { return 0 }
    var t Target = Target{Raw: 0}
    var k = 0
    while k < 2 {
        let a C = local
        t = s
        k = k + 1
    }
    if k < 0 { clear() }
    return k
}
func WithProjection(src ProjSrc) int32 {
    if g == nil { return 0 }
    var k = 0
    while k < 2 {
        let a C = g
        let dst ProjDst = src
        k = k + 1
    }
    return k
}
var g C? = C()
Console.WriteLine(WithDeclaration(Source{Raw: 1}) + WithAssignment(Source{Raw: 1}) + WithProjection(ProjSrc{}))`, "GS0155@28:19 GS0155@41:19 GS0155@52:19", "reject", ""}
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
