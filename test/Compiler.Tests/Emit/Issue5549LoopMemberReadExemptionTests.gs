// <copyright file="Issue5549LoopMemberReadExemptionTests.cs" company="GSharp">
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

/// Regression coverage for issue #5549 (ADR-0213 W5):
/// - A member read in a loop or backward-jump span is exempt from W5 (`RunsUserCodeOnMemberRead`) when its receiver
///   resolves at the region's entry scope without a type test in the region and the member is on the R16 stable
///   imported getter list (`IsStableClrAccessor`) or is a field or auto property of a type that cannot have a
///   subclass (a value type or a class that is neither `open` nor `sealed`).
/// - Control 1 (`q5d` and `DerivedList : List[int32]`): a type test on the receiver inside the region disables the
///   exemption.
/// - Control 2: a field or auto property of an `open` or `sealed` class is not exempt.
/// - Control 3: an unlisted imported getter (`Lazy<int>.Value`) is not exempt.
open class Issue5549LoopMemberReadExemptionTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5549-" + Guid.NewGuid().ToString("N"))
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
            yield[]object{"stable_imported_getters_in_loop_and_span_keep_facts_5549", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Holder {
    let Item C?
    init(item C?) { Item = item }
}

func RunLoop(s string, sb StringBuilder, arr []int32, list List[int32], opt int32?, holder Holder) int32 {
    var x C? = C{Value: 3}
    let clear = func() { x = nil }
    if x == nil || g == nil || holder.Item == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        if opt.HasValue {
            total = total + x.Value + g.Value + holder.Item.Value + s.Length + sb.Length + arr.Length + list.Count + 1
        }
    }
    clear()
    return total
}

func RunSpan(s string, sb StringBuilder, holder Holder) int32 {
    var x C? = C{Value: 3}
    let clear = func() { x = nil }
    if x == nil || g == nil || holder.Item == nil { return 0 }
    var total = 0
    var i = 0
    Again:
    total = total + x.Value + g.Value + holder.Item.Value + s.Length + sb.Length
    i = i + 1
    if i < 2 { goto Again }
    clear()
    return total
}

var g C? = C{Value: 2}
let sb = StringBuilder("ab")
let arr = []int32{10, 20}
let list = List[int32]{30}
let holder = Holder(C{Value: 4})
Console.WriteLine(RunLoop("xyz", sb, arr, list, 5, holder))
Console.WriteLine(RunSpan("xyz", sb, holder))`, "", "run", "36|28"}
            yield[]object{"non_hideable_fields_and_auto_properties_in_loop_and_span_keep_facts_5549", `import System

enum Color {
    Red = 1,
    Blue = 2
}
struct Point {
    var X int32
}
class Box {
    var Value int32 = 5
    prop Auto int32 { get; set; }
}
class C {
    var Value int32 = 1
}

func RunLoop(box Box, pt Point, pair (A int32, B int32)) int32 {
    var x C? = C{Value: 3}
    let clear = func() { x = nil }
    if x == nil || g == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        total = total + x.Value + g.Value + box.Value + box.Auto + pt.X + pair.A
        if Color.Red == Color.Blue { total = total + 100 }
    }
    clear()
    return total
}

func RunSpan(box Box, pt Point) int32 {
    var x C? = C{Value: 3}
    let clear = func() { x = nil }
    if x == nil || g == nil { return 0 }
    var total = 0
    var i = 0
    Again:
    total = total + x.Value + g.Value + box.Value + box.Auto + pt.X
    i = i + 1
    if i < 2 { goto Again }
    clear()
    return total
}

var g C? = C{Value: 2}
Console.WriteLine(RunLoop(Box{Auto: 6}, Point{X: 4}, (7, 8)))
Console.WriteLine(RunSpan(Box{Auto: 6}, Point{X: 4}))`, "", "run", "54|40"}
            yield[]object{"control1_type_test_on_receiver_in_loop_and_span_disables_exemption_5549", `import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
open class Base {
    var X int32 = 1
}
class Derived : Base {
    let clear () -> void
    init(c () -> void) { clear = c }
    prop X int32 {
        get {
            clear()
            return 1
        }
    }
}
class DerivedList : List[int32] {
    let clear () -> void
    init(c () -> void) { clear = c }
    prop Count int32 {
        get {
            clear()
            return 1
        }
    }
}

func RunHiddenFieldInLoop(n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    let b Base = Derived(clear)
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value
        if b is Derived {
            total = total + b.X
        }
    }
    return total
}

func RunHiddenStableGetterInLoop(n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    let items List[int32] = DerivedList(clear)
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value
        if items is DerivedList {
            total = total + items.Count
        }
    }
    return total
}

func RunHiddenStableGetterInSpan(n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    let items List[int32] = DerivedList(clear)
    if x == nil { return 0 }
    var total = 0
    var i = 0
    Again:
    total = total + x.Value
    if items is DerivedList {
        total = total + items.Count
    }
    i = i + 1
    if i < n { goto Again }
    return total
}

Console.WriteLine(RunHiddenFieldInLoop(2) + RunHiddenStableGetterInLoop(2) + RunHiddenStableGetterInSpan(2))`, "GS0158@38:27 GS0158@53:27 GS0158@69:23", "reject", ""}
            yield[]object{"control2_field_on_open_or_sealed_hierarchy_class_rejected_5549", `import System

class C {
    var Value int32 = 1
}
open class OpenBox {
    var Value int32 = 1
}
sealed class SealedBox {
    var Value int32 = 1
}

func RunOpenInLoop(b OpenBox, n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil || g == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value + g.Value + b.Value
    }
    clear()
    return total
}

func RunSealedInLoop(b SealedBox, n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value + b.Value
    }
    clear()
    return total
}

var g C? = C{}
Console.WriteLine(RunOpenInLoop(OpenBox{}, 2) + RunSealedInLoop(SealedBox{}, 2))`, "GS0158@19:27 GS0158@19:37 GS0158@31:27", "reject", ""}
            yield[]object{"control3_unlisted_imported_getter_lazy_value_rejected_5549", `import System

class C {
    var Value int32 = 1
}

func RunLoop(n int32) int32 {
    var x C? = C{}
    let lazy = Lazy[int32](() -> {
        x = nil
        g = nil
        return 1
    })
    if x == nil || g == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value + g.Value + lazy.Value
    }
    return total
}

func RunSpan(n int32) int32 {
    var x C? = C{}
    let lazy = Lazy[int32](() -> {
        x = nil
        return 1
    })
    if x == nil { return 0 }
    var total = 0
    var i = 0
    Again:
    total = total + x.Value + lazy.Value
    i = i + 1
    if i < n { goto Again }
    return total
}

var g C? = C{}
Console.WriteLine(RunLoop(2) + RunSpan(2))`, "GS0158@17:27 GS0158@17:37 GS0158@32:23", "reject", ""}
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
