// <copyright file="Issue5460LoopBreakExitJoinTests.cs" company="GSharp">
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

/// Regression coverage for issue #5460 (ADR-0213 section 9 Table 9, section 10 J1, section 13, and mutant M19):
/// each reachable `break` targeting a loop records its narrowing state on the loop's `break` label (through
/// pending cleanup regions), and the loop exit state is `Jmp(break, header-false)`.
open class Issue5460LoopBreakExitJoinTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5460-" + Guid.NewGuid().ToString("N"))
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
            yield[]object{"while_header_false_and_break_join", `import System
func Get() string? { return nil }
func Fix() string { return "fix" }
func Run(c bool) int32 {
    var s string? = Get()
    while s == nil {
        if c {
            s = Fix()
            break
        }
        s = "ok"
    }
    return s.Length
}
func Main() {
    Console.WriteLine(Run(true))
    Console.WriteLine(Run(false))
}`, "", "run", "3|2"}
            yield[]object{"while_true_breaks_join", `import System
func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    while true {
        if c {
            s = "ok"
            break
        }
        s = "other"
        break
    }
    return s.Length
}
func Main() {
    Console.WriteLine(Run(true))
    Console.WriteLine(Run(false))
}`, "", "run", "2|5"}
            yield[]object{"for_infinite_and_clause_breaks_join", `import System
func Get() string? { return nil }
func RunInfinite(c bool) int32 {
    var s string? = Get()
    for {
        if c {
            s = "ok"
            break
        }
        s = "other"
        break
    }
    return s.Length
}
func RunClause(c bool) int32 {
    var s string? = Get()
    for var i = 0; ; i++ {
        if c {
            s = "ok"
            break
        }
        s = "other"
        break
    }
    return s.Length
}
func Main() {
    Console.WriteLine(RunInfinite(true))
    Console.WriteLine(RunClause(false))
}`, "", "run", "2|5"}
            yield[]object{"do_while_header_false_and_break_join", `import System
func Get() string? { return nil }
func Fix() string { return "fix" }
func Run(c bool) int32 {
    var s string? = Get()
    do {
        if c {
            s = Fix()
            break
        }
        s = "ok"
    } while s == nil
    return s.Length
}
func Main() {
    Console.WriteLine(Run(true))
    Console.WriteLine(Run(false))
}`, "", "run", "3|2"}
            yield[]object{"g1_with_break_three_predecessor_n_ary_join", `import System
open class Animal {
    var Name string = "animal"
}
class Dog : Animal {
    init() { Name = "dog" }
}
class Cat : Animal {
    init() { Name = "cat" }
}
func RunWhileTrue(x object?, k int32) string {
    while true {
        if k == 0 {
            if x !is Dog { return "" }
            break
        }
        if k == 1 {
            if x !is Cat { return "" }
            break
        }
        if x !is Animal { return "" }
        break
    }
    return x.Name
}
func RunHeaderFalse(input object?, k int32) string {
    var x = input
    while x !is Animal {
        if k == 0 {
            x = Dog()
            if x !is Dog { return "" }
            break
        }
        x = Cat()
        if x !is Cat { return "" }
        break
    }
    return x.Name
}
func Main() {
    Console.WriteLine(RunWhileTrue(Dog(), 0))
    Console.WriteLine(RunWhileTrue(Cat(), 1))
    Console.WriteLine(RunWhileTrue(Animal{}, 2))
    Console.WriteLine(RunHeaderFalse(nil, 0))
    Console.WriteLine(RunHeaderFalse(nil, 1))
    Console.WriteLine(RunHeaderFalse(Animal{}, 2))
}`, "", "run", "dog|cat|animal|dog|cat|animal"}
            yield[]object{"control1_break_without_fact_drops_header_false_gain", `import System
func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    while s == nil {
        if c {
            break
        }
        s = "ok"
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0158@11:14", "reject", ""}
            yield[]object{"control2a_switch_break_does_not_exit_loop", `import System
func Get() string? { return nil }
func RunCond(k int32) int32 {
    var k = k
    var s string? = Get()
    while s == nil {
        switch k {
            case 1 {
                k = 2
                break
            }
            default {
                s = "ok"
            }
        }
    }
    return s.Length
}
func RunWhileTrue(k int32) int32 {
    var s string? = Get()
    while true {
        switch k {
            case 1 {
                break
            }
            default {
            }
        }
        s = "ok"
        break
    }
    return s.Length
}
func Main() {
    Console.WriteLine(RunCond(1))
    Console.WriteLine(RunWhileTrue(1))
}`, "", "run", "2|2"}
            yield[]object{"control2b_switch_break_with_non_null_does_not_prove_loop_break", `import System
func Get() string? { return nil }
func Run(k int32) int32 {
    var s string? = Get()
    while true {
        switch k {
            case 1 {
                s = "ok"
                break
            }
            default {
            }
        }
        break
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(2)) }`, "GS0158@16:14", "reject", ""}
            yield[]object{"control3a_nested_loop_break_and_labeled_break_outer", `import System
func Get() string? { return nil }
func Fix() string { return "fix" }
func RunInnerBreak(flag bool) int32 {
    var s string? = Get()
    while s == nil {
        while flag {
            break
        }
        s = "ok"
    }
    return s.Length
}
func RunLabeledBreakOuter(flag bool, c bool) int32 {
    var s string? = Get()
    outer: while s == nil {
        while flag {
            if c {
                s = Fix()
                break outer
            }
            break
        }
        s = "ok"
    }
    return s.Length
}
func Main() {
    Console.WriteLine(RunInnerBreak(true))
    Console.WriteLine(RunLabeledBreakOuter(true, true))
    Console.WriteLine(RunLabeledBreakOuter(true, false))
}`, "", "run", "2|3|2"}
            yield[]object{"control3b_nested_loop_break_does_not_prove_outer_loop_exit", `import System
func Get() string? { return nil }
func RunInnerBreakOnly(flag bool) int32 {
    var s string? = Get()
    while true {
        while flag {
            s = "ok"
            break
        }
        break
    }
    return s.Length
}
func RunLabeledBreakOuterNil(flag bool, c bool) int32 {
    var s string? = Get()
    outer: while s == nil {
        while flag {
            if c {
                break outer
            }
            break
        }
        s = "ok"
    }
    return s.Length
}
func Main() {
    Console.WriteLine(RunInnerBreakOnly(false) + RunLabeledBreakOuterNil(true, true))
}`, "GS0158@12:14 GS0158@25:14", "reject", ""}
            yield[]object{"control4a_finally_clears_fact_on_break", `import System
func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    while s == nil {
        if c {
            try {
                s = "ok"
                break
            } finally {
                s = nil
            }
        }
        s = "ok"
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0158@16:14", "reject", ""}
            yield[]object{"control4b_finally_restores_fact_on_break", `import System
func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    while s == nil {
        if c {
            try {
                break
            } finally {
                s = "safe"
            }
        }
        s = "ok"
    }
    return s.Length
}
func Main() {
    Console.WriteLine(Run(true))
    Console.WriteLine(Run(false))
}`, "", "run", "4|2"}
            yield[]object{"control5_break_after_mutating_operand_in_expression", `import System
func Clear() int32 {
    g = nil
    return 1
}
func ClearBool() bool {
    g = nil
    return true
}
class Box {
    func M(x int32) int32 { return x }
    func ClearAndGet() Box {
        g = nil
        return this
    }
}
func RunAdd() int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = Clear() + {
            break
            0
        }
    }
    return g.Length
}
func RunAnd() int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = ClearBool() && {
            break
            true
        }
    }
    return g.Length
}
func RunLabeledOr() int32 {
    outer: while true {
        if g == nil {
            return 0
        }
        while true {
            let ignored = !ClearBool() || {
                break outer
                false
            }
        }
    }
    return g.Length
}
func RunChainedCall(box Box) int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = box.ClearAndGet().M({
            break
            0
        })
    }
    return g.Length
}
struct Token {
    shared {
        func operator implicit(t Token) int32 {
            g = nil
            return 1
        }
    }
}
func Take(a int32, f () -> void, b int32) int32 { return a + b }
func TakeConverted(a int32, b int32) int32 { return a + b }
func RunNestedLambdaLoop() int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = Take(Clear(), func() {
            while false { }
        }, {
            break
            0
        })
    }
    return g.Length
}
func RunImplicitConversion(value Token) int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = TakeConverted(value, {
            break
            0
        })
    }
    return g.Length
}
class MutatingInitClass {
    var Init int32 = Clear()
    var Value int32
}
class MutatingBag : System.Collections.IEnumerable {
    func Add(x int32) {
        g = nil
    }
    func GetEnumerator() System.Collections.IEnumerator {
        throw NotImplementedException()
    }
}
func RunClassLiteralInit() int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = MutatingInitClass{
            Value: ({
                break
                0
            })
        }
    }
    return g.Length
}
func RunCollectionAdd() int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = MutatingBag(){
            1,
            ({
                break
                0
            })
        }
    }
    return g.Length
}
var g string? = "ok"
Console.WriteLine(RunAdd() + RunAnd() + RunLabeledOr() + RunChainedCall(Box()) + RunNestedLambdaLoop() + RunImplicitConversion(Token{}) + RunClassLiteralInit() + RunCollectionAdd())`, "GS0158@27:14 GS0158@39:14 GS0158@53:14 GS0158@65:14 GS0158@89:14 GS0158@101:14 GS0158@127:14 GS0158@142:14", "reject", ""}
            yield[]object{"control8_interpolation_and_reassigned_callable_before_break", `import System
class C {
    var Value int32 = 1
}
class Noisy {
    override func ToString() string {
        cleaner()
        return "n"
    }
}
func RunInterpolation() int32 {
    var x C? = C{}
    cleaner = func() {
        x = nil
    }
    let n = Noisy{}
    while true {
        if x == nil {
            return 0
        }
        let ignored = "${n}${{
            break
            0
        }}"
    }
    return x.Value
}
func TakeThree(a int32, b int32, c int32) int32 { return a + b + c }
func RunCallableReassignedAfterCall(cb () -> int32) int32 {
    var s string? = "ok"
    var f () -> int32 = () -> {
        s = nil
        return 1
    }
    while true {
        if s == nil {
            return 0
        }
        let ignored = f() + {
            f = cb
            break
            0
        }
    }
    return s.Length
}
func RunCallableReassignedInSiblingArgument(cb () -> int32) int32 {
    var s string? = "ok"
    var f () -> int32 = () -> {
        s = nil
        return 1
    }
    while true {
        if s == nil {
            return 0
        }
        let ignored = TakeThree(f(), {
            f = cb
            0
        }, {
            break
            0
        })
    }
    return s.Length
}
var cleaner () -> void = func() { }
Console.WriteLine(RunInterpolation() + RunCallableReassignedAfterCall(() -> 1) + RunCallableReassignedInSiblingArgument(() -> 1))`, "GS0158@26:14 GS0158@45:14 GS0158@65:14", "reject", ""}
            yield[]object{"control9_identity_overload_selected_over_mutating_conversion_preserves_fact", `import System
struct Token {
    var Value int32
    shared {
        func operator implicit(t Token) int32 {
            g = nil
            return t.Value
        }
    }
}
func TakeOverloaded(t Token, x int32) int32 { return t.Value + x }
func TakeOverloaded(a int32, x int32) int32 { return a + x }
func RunIdentityOverload(token Token) int32 {
    while true {
        if g == nil {
            return 0
        }
        let ignored = TakeOverloaded(token, {
            break
            0
        })
    }
    return g.Length
}
var g string? = "ok"
Console.WriteLine(RunIdentityOverload(Token{Value: 1}))`, "", "run", "2"}
            yield[]object{"control7_killed_branch_and_loop_condition_facts_not_replayed_on_break", `import System
func Get() string? { return "ok" }
func RunShortCircuitKilled() int32 {
    var s string? = Get()
    while true {
        let ignored = s != nil && {
            s = nil
            break
            true
        }
        return 0
    }
    return s.Length
}
func RunLoopConditionKilled() int32 {
    var s string? = Get()
    while s != nil {
        s = nil
        break
    }
    return s.Length
}
func Main() {
    Console.WriteLine(RunShortCircuitKilled() + RunLoopConditionKilled())
}`, "GS0158@13:14 GS0158@21:14", "reject", ""}
            yield[]object{"control6a_labeled_break_crossing_for_in_runs_enumerator_disposal", `import System
func Gen() sequence[int32] {
    try {
        yield 1
    } finally {
        s = nil
    }
}
func RunLabeledBreak() int32 {
    outer: while true {
        for v in Gen() {
            if s != nil {
                break outer
            }
        }
        return 0
    }
    return s.Length
}
func RunUnlabeledBreak() int32 {
    for v in Gen() {
        if s != nil {
            break
        }
    }
    return s.Length
}
var s string? = "ok"
Console.WriteLine(RunLabeledBreak() + RunUnlabeledBreak())`, "GS0158@18:14 GS0158@26:14", "reject", ""}
            yield[]object{"control6b_labeled_break_crossing_indexed_for_in_preserves_fact", `import System
func RunIndexed() int32 {
    let items = []int32{1, 2}
    outer: while true {
        for v in items {
            if s != nil {
                break outer
            }
        }
        return 0
    }
    return s.Length
}
var s string? = "ok"
Console.WriteLine(RunIndexed())`, "", "run", "2"}
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
