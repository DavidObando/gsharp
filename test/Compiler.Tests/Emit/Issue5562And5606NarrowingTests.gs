// <copyright file="Issue5562And5606NarrowingTests.cs" company="GSharp">
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

/// Regression coverage for ADR-0208 issues #5562 (a synthesized default constructor call with no user code keeps
/// by-reference parameter narrowing) and #5606 (pattern-proof check walks only `isExpr.Pattern`, and condition
/// true/false external-callable alias states are carried into `if`, `if init;`, and `if let` branches).
open class Issue5562And5606NarrowingTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5562-5606-" + Guid.NewGuid().ToString("N"))
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
            yield[]object{"r5562_default_ctor_call_keeps_out_parameter_narrowing", `import System

class Mixed {
    var Id int32
}
open class Demo {
    shared {
        private func Pick() string? -> "hello"

        func Run(out text string?) int32 {
            text = Pick()
            if text == nil {
                return 0
            }
            let made = Mixed()
            return made.Id + text.Length
        }
    }
}
var s string? = nil
Console.WriteLine(Demo.Run(out s))`, "", "run", "5"}
            yield[]object{"r5562_default_ctor_call_in_pattern_keeps_ref_parameter_narrowing", `import System

class Mixed {
    var Id int32
}
func Run(ref text string?) int32 {
    if text is string { Length: Mixed().Id + 4 } {
        return text.Length
    }
    return 0
}
var s string? = "abcd"
Console.WriteLine(Run(ref s))`, "", "run", "4"}
            yield[]object{"r5562_control_explicit_ctor_call_removes_ref_parameter_narrowing", `import System

class Box {
    shared {
        var Clear (() -> void)?
    }
}
class WithCtor {
    var Id int32
    init() {
        Box.Clear?()
    }
}
func Run(ref text string?) int32 {
    if text == nil {
        return 0
    }
    let made = WithCtor()
    return made.Id + text.Length
}
var s string? = "abc"
Console.WriteLine(Run(ref s))`, "GS0158@19:27", "reject", ""}
            yield[]object{"r5562_control_field_initializer_ctor_call_removes_ref_parameter_narrowing", `import System

func Touch() int32 -> 1
class WithFieldInit {
    var Id int32 = Touch()
}
func Run(ref text string?) int32 {
    if text == nil {
        return 0
    }
    let made = WithFieldInit()
    return made.Id + text.Length
}
var s string? = "abc"
Console.WriteLine(Run(ref s))`, "GS0158@12:27", "reject", ""}
            yield[]object{"r5562_control_imported_base_ctor_call_removes_ref_parameter_narrowing", `import System

open class Base : Exception {
}
class Derived : Base {
    var Id int32
}
func Run(ref text string?) int32 {
    if text == nil {
        return 0
    }
    let made = Derived()
    return made.Id + text.Length
}
var s string? = "abc"
Console.WriteLine(Run(ref s))`, "GS0158@13:27", "reject", ""}
            yield[]object{"r5562_control_deep_ctor_hierarchy_removes_ref_parameter_narrowing", `import System

class Box {
    shared {
        var Clear (() -> void)?
    }
}
open class C0 { init() { Box.Clear?() } }
open class C1 : C0 {}
open class C2 : C1 {}
open class C3 : C2 {}
open class C4 : C3 {}
open class C5 : C4 {}
open class C6 : C5 {}
open class C7 : C6 {}
open class C8 : C7 {}
open class C9 : C8 {}
open class C10 : C9 {}
open class C11 : C10 {}
open class C12 : C11 {}
open class C13 : C12 {}
open class C14 : C13 {}
open class C15 : C14 {}
open class C16 : C15 {}
open class C17 : C16 {}
open class C18 : C17 {}
open class C19 : C18 {}
open class C20 : C19 {}
open class C21 : C20 {}
open class C22 : C21 {}
open class C23 : C22 {}
open class C24 : C23 {}
open class C25 : C24 {}
open class C26 : C25 {}
open class C27 : C26 {}
open class C28 : C27 {}
open class C29 : C28 {}
open class C30 : C29 {}
open class C31 : C30 {}
open class C32 : C31 {}
open class C33 : C32 {}
open class C34 : C33 {}
open class C35 : C34 {}
open class C36 : C35 {}
open class C37 : C36 {}
open class C38 : C37 {}
open class C39 : C38 {}
open class C40 : C39 {}
open class C41 : C40 {}
open class C42 : C41 {}
open class C43 : C42 {}
open class C44 : C43 {}
open class C45 : C44 {}
open class C46 : C45 {}
open class C47 : C46 {}
open class C48 : C47 {}
open class C49 : C48 {}
open class C50 : C49 {}
open class C51 : C50 {}
open class C52 : C51 {}
open class C53 : C52 {}
open class C54 : C53 {}
open class C55 : C54 {}
open class C56 : C55 {}
open class C57 : C56 {}
open class C58 : C57 {}
open class C59 : C58 {}
open class C60 : C59 {}
open class C61 : C60 {}
open class C62 : C61 {}
open class C63 : C62 {}
class C64 : C63 {
    var Id int32
}
func Run(ref text string?) int32 {
    if text == nil {
        return 0
    }
    let made = C64()
    return made.Id + text.Length
}
var s string? = "abc"
Console.WriteLine(Run(ref s))`, "GS0158@80:27", "reject", ""}
            yield[]object{"r5562_control_lambda_in_earlier_field_initializer_removes_ref_parameter_narrowing", `import System

class Box {
    shared {
        var G string? = "abc"
    }
    var Probe (ref string?) -> int32 = func(ref text string?) int32 {
        if text == nil {
            return 0
        }
        let _ = Box()
        return text.Length
    }
    var Id int32 = ({
        G = nil
        1
    })
}
let b = Box()
Console.WriteLine(b.Probe(ref Box.G))`, "GS0158@12:21", "reject", ""}
            yield[]object{"r5606_if_condition_gained_alias_carried_into_then_branch", `import System

func Run(callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if (action = callback) is {} a {
        let first = action()
        if x is action() {
            return first.Length + x.Length + a().Length
        }
    }
    return 0
}
Console.WriteLine(Run(() -> "abc"))`, "", "run", "9"}
            yield[]object{"r5606_if_condition_gained_alias_carried_into_else_branch_under_or", `import System

func Run(flag bool, callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if flag || (action = callback) is not {} {
        return 0
    } else {
        let first = action()
        if x is action() {
            return first.Length + x.Length
        }
    }
    return 0
}
Console.WriteLine(Run(false, () -> "abc"))`, "", "run", "6"}
            yield[]object{"r5606_if_init_condition_gained_alias_carried_into_branches", `import System

func Run(callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if var seed = 1; (action = callback) is {} a {
        let first = action()
        if x is action() {
            return seed + first.Length + x.Length
        }
    } else {
        let second = action()
        return second.Length + x.Length
    }
    return 0
}
Console.WriteLine(Run(() -> "abc"))`, "", "run", "7"}
            yield[]object{"r5606_if_let_initializer_and_guard_gained_alias_carried_into_branches", `import System

func Run(maybe int32?, callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    var total = 0
    if let v = maybe && (action = callback) is {} a {
        let first = action()
        if x is action() {
            total += v + first.Length + x.Length
        }
    }
    var action2 = func() string {
        x = nil
        return "z"
    }
    let none int32? = nil
    if let u = ({
        action2 = callback
        none
    }) {
        total += u
    } else {
        let second = action2()
        if x is action2() {
            total += second.Length + x.Length
        }
    }
    return total
}
Console.WriteLine(Run(4, () -> "abc"))`, "", "run", "16"}
            yield[]object{"r5606_if_let_two_clauses_with_else_gained_alias_in_then_branch", `import System

func Run(first int32?, second int32?, callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if let a = first, let b = second && (action = callback) is {} c {
        let s = action()
        if x is action() {
            return a + b + s.Length + x.Length
        }
    } else {
        return 1
    }
    return 0
}
Console.WriteLine(Run(2, 5, () -> "abc"))`, "", "run", "13"}
            yield[]object{"r5606_control_or_condition_unassigned_path_rejects_in_then_branch", `import System

func Run(flag bool, callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if flag || (action = callback) is {} a {
        action()
        return x.Length
    }
    return 0
}
Console.WriteLine(Run(true, () -> "abc"))`, "GS0158@14:18", "reject", ""}
            yield[]object{"r5606_control_and_condition_unassigned_path_rejects_in_else_branch", `import System

func Run(flag bool, callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if flag && (action = callback) is {} a {
        return 0
    } else {
        action()
        return x.Length
    }
}
Console.WriteLine(Run(false, () -> "abc"))`, "GS0158@16:18", "reject", ""}
            yield[]object{"r5606_control_if_let_guard_gained_alias_rejects_in_else_branch", `import System

func Run(maybe int32?, callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if let v = maybe && (action = callback) is {} a {
        return v
    } else {
        action()
        return x.Length
    }
}
Console.WriteLine(Run(nil, () -> "abc"))`, "GS0158@16:18", "reject", ""}
            yield[]object{"r5606_control_pattern_effect_removes_operand_fact", `import System

func ClearAndFour() int32 {
    clear?()
    return 4
}
func Run(seed object?) int32 {
    var x object? = seed
    clear = func() { x = nil }
    if x is string { Length: ClearAndFour() } {
        return x.Length
    }
    return 0
}
var clear (() -> void)? = nil
Console.WriteLine(Run("abcd"))`, "GS0158@11:18", "reject", ""}
            yield[]object{"r5606_control_if_let_explicit_type_conversion_invalidates_gained_alias", `import System

class Holder {
    shared {
        var Hook (() -> void)?
    }
}
class Source {
}
class Target {
    var Value int32
    shared {
        func operator implicit(s Source?) Target? {
            Holder.Hook?()
            return Target{Value: 1}
        }
    }
}
func Run(src Source?, callback () -> string) int32 {
    var x string? = "abc"
    var action = callback
    Holder.Hook = func() {
        action = func() string {
            x = nil
            return "z"
        }
    }
    if x == nil {
        return 0
    }
    if let v Target = ({
        action = callback
        src
    }) {
        action()
        return v.Value + x.Length
    }
    return 0
}
Console.WriteLine(Run(Source{}, () -> "abc"))`, "GS0158@36:28", "reject", ""}
            yield[]object{"r5606_control_or_skipped_block_expression_rejects_in_then_branch", `import System

func Run(flag bool, callback () -> string) int32 {
    var x string? = "abc"
    var action = func() string {
        x = nil
        return "z"
    }
    if x == nil {
        return 0
    }
    if flag || ({
        action = callback
        false
    }) {
        action()
        return x.Length
    }
    return 0
}
Console.WriteLine(Run(true, () -> "abc"))`, "GS0158@17:18", "reject", ""}
            yield[]object{"r5606_control_enclosing_catch_filter_invalidates_condition_gained_alias", `import System

func Replace(ref a () -> string, replacement () -> string) bool {
    a = replacement
    return false
}
func Run(callback () -> string) int32 {
    var x string? = "abc"
    var action = callback
    let bad = func() string {
        x = nil
        return "abc"
    }
    if x == nil {
        return 0
    }
    try {
        if ({
            action = callback
            try {
                throw Exception("boom")
            } catch {
            }
            true
        }) {
            if x is action() {
                return x.Length
            }
        }
    } catch (FormatException) when Replace(ref action, bad) {
        return 0
    }
    return 0
}
Console.WriteLine(Run(() -> "abc"))`, "GS0158@27:26", "reject", ""}
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
