// <copyright file="Adr0208NarrowingCorpusTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

/// ADR-0208 section 19, PR 1: the regression corpus. One row for each probe of
/// the section 4 table. Each row pins the result of the current narrowing
/// passes, so PR 2 changes a row on purpose or not at all.
/// @remarks A row records the exact diagnostics (id, line and column, the
/// shared GS9100 note excluded). A program that compiles is verified with
/// ILVerify and run. Its output, or its `NullReferenceException`, is the
/// result. The soundness rows (cA, d1, d1b, d4, f2, f3, g2) compile today
/// and dereference nil at run time (bugs #5168 and #5171). They pin that
/// defect so that the PR that closes it flips them in the same change. The
/// rows d3, d3b and f5 (bug #5170, R11) were flipped by that fix and now
/// record its GS0158.
/// Each row names the row of ADR-0208 section 16 that changes it, if any.
/// PR 2, slice 2a flipped e7 (Run2), e8, e10, e21, f1, f6 and g4 (rows R1, R3,
/// R5) and added h1 to h5, i1, i2 and j1 (issue #5206, amendment A1). They now
/// record the new result. The rows h1 and h2 stay rejected until slice 2b (R2).
open class Adr0208NarrowingCorpusTests {
    /// Compiles one probe, checks its diagnostics, and for a program that
    /// compiles verifies and runs it.
    /// @param name The probe name from the ADR section 4 table.
    /// @param source The probe source.
    /// @param expectedDiagnostics The diagnostics as `ID@line:column`, in order.
    /// @param kind `reject` (no output), `run` (verify, run, compare stdout) or `nre` (run, expect the crash).
    /// @param expectedOutput The stdout lines joined by `|` for kind `run`.
    /// @param flipsInPr2 The ADR row that changes this result later, or empty.
    @Theory
    @MemberData("Rows")
    func EveryProbe_KeepsItsRecordedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string,
        flipsInPr2 string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_adr0208_").FullName
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
                "${name}: diagnostics changed (ADR-0208 row: ${flipsInPr2}). Log:\n${log}"
            )
            if kind == "reject" {
                Assert.False(File.Exists(outPath), "${name} must not compile. Log:\n${log}")
                return
            }
            Assert.True(File.Exists(outPath), "${name} must compile. Log:\n${log}")
            IlVerifier.Verify(outPath)
            let (exit, stdout, stderr) = RunDotnet(outPath)
            if kind == "nre" {
                Assert.True(exit != 0, "${name} must crash at run time (bug #5168/#5170/#5171). Stdout:\n${stdout}")
                Assert.Contains("NullReferenceException", stderr, StringComparison.Ordinal)
                return
            }
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

    /// The corpus must keep one row for each probe of the ADR table.
    @Fact
    func Corpus_HasOneRowPerProbe() {
        let names = Rows()
            .Select((row[]object) -> cast[string](row[0]))
            .OrderBy((n string) -> n, StringComparer.Ordinal)
            .ToArray()
        Assert.Equal(names.Length, names.Distinct().Count())
        Assert.Equal(
            []string{
                "c1_catch_return_finally",
                "c3a_goto_inside",
                "c3b_goto_cycle",
                "c5_alias_reassigned_in_loop",
                "c6_callable_argument",
                "c7_ref_param_callback",
                "c8_member_hiding_loop",
                "c8b_member_hiding_loop_ctor",
                "cA_filter_write",
                "cB_local_function_captures",
                "cC_finally_restores_on_jump",
                "d1_enclosing_filter_before_finally",
                "d1b_enclosing_filter_order",
                "d2_shadowed_type_name",
                "d3_global_written_by_callee",
                "d3b_global_straight_line",
                "d4_ref_local_alias",
                "d4b_ref_local_straight_line",
                "d5_strengthened_fact_join",
                "d6_nonCompleting_finally",
                "e10_nested_block_lift",
                "e11_bang_narrows",
                "e12_loop_in_if_branch",
                "e13_loop_while_cond",
                "e14_closure_var",
                "e15_backward_goto",
                "e16_shadow_in_loop",
                "e17_assign_in_exiting_branch",
                "e18_backward_goto_nowrite",
                "e19_try_in_branch_and_finally",
                "e1_ifjoin",
                "e20_global_let_narrows",
                "e21_predicate_memberpath_lift",
                "e2_loop_exitwrite",
                "e2b_loop_read_before_exitwrite",
                "e3_loop_nonnull_reassign",
                "e4_loop_nullable_reassign",
                "e5_goto_disables_join",
                "e6_catch_sees_pretry",
                "e7_memberpath_earlyexit",
                "e8_else_exit",
                "e9_switch_assign_join",
                "f1_dog_cat_join",
                "f2_ref_element_alias",
                "f3_replacement_exception_filter",
                "f4_nullable_construction_boxes_nil",
                "f5_iterator_assigns_global",
                "f6_else_exit_hidden_member",
                "g1_three_predecessor_goto",
                "g2_ref_param_aliases_element",
                "g3_switch_failed_guard",
                "g4_overload_ambiguity_after_join",
                "g5_yield_after_guard",
                "h1_assign_in_exiting_branch_new_fact",
                "h2_call_in_exiting_branch_member_path",
                "h3_call_in_condition_before_fact",
                "h4_call_in_then_branch_member_path",
                "h5_strengthening_gain",
                "i1_5206_type_test_against_unrelated_interface",
                "i2_5206_goto_join_keeps_declared_type",
                "j1_else_if_chain_nary_join",
                "out-alias_out_ref_alias"
            },
            names
        )
    }

    shared {
        private const RunTimeout int32 = 60_000

        /// The probe rows.
        /// @returns Name, source, diagnostics, kind, output, ADR row that flips it.
        func Rows() sequence[[]object] {
            yield[]object{"c1_catch_return_finally", `func Get() string? { return "a" }
func Consume(n int32) { Console.WriteLine(n) }
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch {
        s = nil
        return 0
    } finally {
        Consume(s.Length)
    }
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@12:19", "reject", "", ""}
            yield[]object{"c3a_goto_inside", `func Get() string? { return nil }
func Consume(n int32) { Console.WriteLine(n) }
func Run(skip bool) int32 {
    var s string? = Get()
    if skip { goto Inside }
    if s == nil { return 0 }
    Again:
    Consume(s.Length)
    Inside:
    goto Again
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0158@8:15", "reject", "", ""}
            yield[]object{"c3b_goto_cycle", `func Get() string? { return nil }
func Consume(n int32) { Console.WriteLine(n) }
func Run(flag bool) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    A:
    Consume(s.Length)
    if flag { goto C }
    B:
    goto A
    C:
    s = nil
    goto B
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0158@7:15", "reject", "", ""}
            yield[]object{"c5_alias_reassigned_in_loop", `func Get() string? { return "a" }
func External() { }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var action (() -> void) = External
    let clear = func() { s = nil }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        action()
        action = clear
    }
    return total
}
func Main() { Console.WriteLine(Run(3)) }`, "GS0158@10:27", "reject", "", ""}
            yield[]object{"c6_callable_argument", `func Get() string? { return "a" }
func Invoke(f () -> void) { f() }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    let clear = func() { s = nil }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        Invoke(clear)
    }
    return total
}
func Main() { Console.WriteLine(Run(3)) }`, "GS0158@9:27", "reject", "", ""}
            yield[]object{"c7_ref_param_callback", `func Run(ref text string?, callback () -> void, n int32) int32 {
    if text == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + text.Length
        callback()
    }
    return total
}
func Main() {
    var t string? = "ab"
    Console.WriteLine(Run(ref t, () -> { t = nil }, 2))
}`, "GS0158@5:30", "reject", "", ""}
            yield[]object{"c8b_member_hiding_loop_ctor", `open class Animal {
    prop Name string -> "animal"
}
class Dog : Animal {
    prop Name string -> "dog"
}
func Run(n int32) string {
    var x Animal = Dog()
    var last = ""
    if x is Dog {
        for var i = 0; i < n; i++ {
            last = x.Name
            x = Dog()
        }
    }
    return last
}
func Main() { Console.WriteLine(Run(2)) }`, "", "run", "dog", ""}
            yield[]object{"c8_member_hiding_loop", `open class Animal {
    prop Name string -> "animal"
}
class Dog : Animal {
    prop Name string -> "dog"
}
func Run(n int32) string {
    var x Animal = Dog{}
    var last = ""
    if x is Dog {
        for var i = 0; i < n; i++ {
            last = x.Name
            x = Dog{}
        }
    }
    return last
}
func Main() { Console.WriteLine(Run(2)) }`, "", "run", "animal", ""}
            yield[]object{"cA_filter_write", `func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        throw Exception("x")
    } catch when Clear(ref s) {
        return 1
    } catch {
        return s.Length
    }
}
func Main() { Console.WriteLine(Run()) }`, "GS0612@11:24", "nre", "", "R10 (GS0158 after)"}
            yield[]object{"cB_local_function_captures", `func Get() string? { return "a" }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    let clear = func() { s = nil }
    let twice = func() {
        clear()
        clear()
    }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        twice()
    }
    return total
}
func Main() { Console.WriteLine(Run(2)) }`, "GS0158@12:27", "reject", "", ""}
            yield[]object{"cC_finally_restores_on_jump", `func Run() int32 {
    var x string? = nil
    x = "safe"
    var count = 0
    Again:
    let length = x.Length
    if count == 0 {
        count++
        try {
            x = nil
            goto Again
        } finally {
            x = "safe"
        }
    }
    return length
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "4", ""}
            yield[]object{"d1b_enclosing_filter_order", `func Get() string? { return "a" }
func Clear(ref s string?) bool {
    Console.WriteLine("filter")
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        try {
            throw Exception("x")
        } finally {
            Console.WriteLine("finally: " + (s ?? "nil"))
            Console.WriteLine(s.Length)
        }
    } catch when Clear(ref s) {
        return 1
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }`, "GS0612@17:24", "run", "filter|finally: nil|filter|1", "R10 (GS0158 after)"}
            yield[]object{"d1_enclosing_filter_before_finally", `func Get() string? { return "a" }
func Consume(n int32) { Console.WriteLine(n) }
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        try {
            throw Exception("x")
        } finally {
            Consume(s.Length)
        }
    } catch when Clear(ref s) {
        return 1
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }`, "GS0612@16:24", "run", "1", "R10 (GS0158 after)"}
            yield[]object{"d2_shadowed_type_name", `import System.Text
func Get() StringBuilder? { return StringBuilder() }
func Run(n int32) int32 {
    var s StringBuilder? = Get()
    if s == nil { return 0 }
    let StringBuilder = func() StringBuilder? { return nil }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = StringBuilder()
    }
    return total
}
func Main() { Console.WriteLine(Run(2)) }`, "GS0158@9:27", "reject", "", ""}
            yield[]object{"d3b_global_straight_line", `var text string? = nil
func Clear() { text = nil }
func Run() int32 {
    text = "safe"
    Clear()
    return text.Length
}
Console.WriteLine(Run())`, "GS0158@6:17 GS0286@8:1", "reject", "", ""}
            yield[]object{"d3_global_written_by_callee", `var text string? = nil
func Clear() { text = nil }
func Run(n int32) int32 {
    text = "safe"
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + text.Length
        Clear()
    }
    return total
}
Console.WriteLine(Run(2))`, "GS0158@7:30 GS0286@12:1", "reject", "", ""}
            yield[]object{"d4b_ref_local_straight_line", `class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    x = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }`, "", "nre", "", "R12 (GS0158 after)"}
            yield[]object{"d4_ref_local_alias", `class C {
    var Value int32 = 1
}
func Run(n int32) int32 {
    var x C? = C{}
    let ref a C? = x
    if a == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + a.Value
        x = nil
    }
    return total
}
func Main() { Console.WriteLine(Run(2)) }`, "", "nre", "", "R12 (GS0158 after)"}
            yield[]object{"d5_strengthened_fact_join", `open class Animal {
    var Name string = "a"
}
class Dog : Animal { }
func Run(x Animal?) string {
    if x != nil {
        if x is Dog { }
        return x.Name
    }
    return ""
}
func Main() { Console.WriteLine(Run(Dog())) }`, "", "run", "a", ""}
            yield[]object{"d6_nonCompleting_finally", `func Run() int32 {
    var x string? = nil
    x = "safe"
    goto After
Enter:
    x = nil
    goto Use
After:
    try {
        goto Enter
    }
    finally {
        return 4
    }
Use:
    return x.Length
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "4", ""}
            yield[]object{"e10_nested_block_lift", `func Get() string? { return nil }
func Run() int32 {
    var s string? = Get()
    {
        if s == nil { return 0 }
    }
    return s.Length
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "0", ""}
            yield[]object{"e11_bang_narrows", `func Get() string? { return nil }
func Run() int32 {
    var s string? = Get()
    let n = s!!.Length
    return n + s.Length
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@5:18", "reject", "", ""}
            yield[]object{"e12_loop_in_if_branch", `func Get() string? { return nil }
func Run(c bool, n int32) int32 {
    var s string? = Get()
    if c {
        s = "a"
        var i = 0
        while i < n { i = i + 1 }
    } else {
        s = "b"
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(true, 2)) }`, "", "run", "1", ""}
            yield[]object{"e13_loop_while_cond", `class Node {
    var Value int32
    var Next Node?
}
func Run(start Node?) int32 {
    var node = start
    var total = 0
    while node != nil {
        total = total + node.Value
        node = node.Next
    }
    return total
}
func Main() { Console.WriteLine(Run(nil)) }`, "", "run", "0", ""}
            yield[]object{"e14_closure_var", `func Get() string? { return nil }
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    let f = () -> s.Length
    return f()
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@5:21", "reject", "", ""}
            yield[]object{"e15_backward_goto", `func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    again:
    i = i + s.Length
    s = "ab"
    if i < n { goto again }
    return i
}
func Main() { Console.WriteLine(Run(5)) }`, "GS0158@7:15", "reject", "", ""}
            yield[]object{"e16_shadow_in_loop", `func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        var s string? = nil
        s = "zz"
        total = total + 1
    }
    return total + s.Length
}
func Main() { Console.WriteLine(Run(2)) }`, "", "run", "0", ""}
            yield[]object{"e17_assign_in_exiting_branch", `func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    if c {
        s = nil
        return -1
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(false)) }`, "GS0158@9:14", "reject", "", "R2 (accepted after)"}
            yield[]object{"e18_backward_goto_nowrite", `func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    again:
    i = i + s.Length
    if i < n { goto again }
    return i
}
func Run2(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    again:
    i = i + s.Length
    s = Get()
    if s == nil { return 0 }
    if i < n { goto again }
    return i
}
func Main() { Console.WriteLine(Run(5)) }`, "GS0158@7:15 GS0158@16:15", "reject", "", "R6 (Run accepted after)"}
            yield[]object{"e19_try_in_branch_and_finally", `func Get() string? { return nil }
func Work() { }
func Run(c bool) int32 {
    var s string? = Get()
    if c {
        s = "a"
        try { Work() } finally { Work() }
    } else {
        s = "b"
    }
    return s.Length
}
func Run2() int32 {
    var s string? = Get()
    try {
        Work()
    } finally {
        s = "f"
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(true)) }`, "", "run", "1", ""}
            yield[]object{"e1_ifjoin", `func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    if s == nil { s = "a" }
    return s.Length
}
func Main() { Console.WriteLine(Run(true)) }`, "", "run", "1", ""}
            yield[]object{"e20_global_let_narrows", `open class Animal { var Name string = "" }
class Dog : Animal { func Bark() string { return "woof" } }
let a Animal = Dog()
if a is Dog {
    Console.WriteLine(a.Bark())
}`, "GS0159@5:25", "reject", "", ""}
            yield[]object{"e21_predicate_memberpath_lift", `class Box {
    let Name string?
    init(n string?) { Name = n }
}
func Run(b Box) int32 {
    if string.IsNullOrEmpty(b.Name) { return 0 }
    return b.Name.Length
}
func Run2(b Box) int32 {
    if b.Name == nil { return 0 }
    return b.Name.Length
}
func Main() { Console.WriteLine(Run(Box("ab"))) }`, "", "run", "2", ""}
            yield[]object{"e2b_loop_read_before_exitwrite", `func Get() string? { return nil }
func Run(c bool, n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    var total = 0
    while i < n {
        total = total + s.Length
        if c {
            s = nil
            break
        }
        i = i + 1
    }
    return total
}
func Main() { Console.WriteLine(Run(true, 3)) }`, "", "run", "0", ""}
            yield[]object{"e2_loop_exitwrite", `func Get() string? { return nil }
func Run(c bool, n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    var total = 0
    while i < n {
        if c {
            s = nil
            break
        }
        total = total + s.Length
        i = i + 1
    }
    return total
}
func Main() { Console.WriteLine(Run(true, 3)) }`, "GS0158@12:27", "reject", "", ""}
            yield[]object{"e3_loop_nonnull_reassign", `class Node { var Value int32 }
func Make() Node { return Node() }
func Get() Node? { return nil }
func Run(n int32) int32 {
    var node Node? = Get()
    if node == nil { return 0 }
    var i = 0
    var total = 0
    while i < n {
        total = total + node.Value
        node = Make()
        i = i + 1
    }
    return total
}
func Main() { Console.WriteLine(Run(3)) }`, "", "run", "0", ""}
            yield[]object{"e4_loop_nullable_reassign", `class Node {
    var Value int32
    var Next Node?
}
func Get() Node? { return nil }
func Run(n int32) int32 {
    var node Node? = Get()
    if node == nil { return 0 }
    var i = 0
    var total = 0
    while i < n {
        total = total + node.Value
        node = node.Next
        i = i + 1
    }
    return total
}
func Main() { Console.WriteLine(Run(3)) }`, "GS0158@12:30 GS0158@13:21", "reject", "", ""}
            yield[]object{"e5_goto_disables_join", `func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    if s == nil { s = "a" }
    if c { goto done }
    Console.WriteLine("x")
    done:
    return s.Length
}
func Main() { Console.WriteLine(Run(true)) }`, "GS0158@8:14", "reject", "", "R6 (accepted after)"}
            yield[]object{"e6_catch_sees_pretry", `func Get() string? { return "a" }
func Boom() { throw Exception("x") }
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        s = nil
        Boom()
    } catch {
        return s.Length
    }
    return 1
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@10:18", "reject", "", ""}
            yield[]object{"e7_memberpath_earlyexit", `open class Animal { var Name string = "" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func Run(b Box) string {
    if b.Pet == nil { return "" }
    return b.Pet.Name
}
func Run2(b Box) string {
    if b.Pet is Dog { } else { return "" }
    return b.Pet.Bark()
}
func Run3(b Box) string {
    if b.Pet !is Dog { return "" }
    return b.Pet.Bark()
}
func Main() { Console.WriteLine(Run2(Box(Dog()))) }`, "", "run", "woof", ""}
            yield[]object{"e8_else_exit", `func Get() string? { return nil }
func Run() int32 {
    let s string? = Get()
    if s != nil { Console.WriteLine("y") } else { return 0 }
    return s.Length
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "0", ""}
            yield[]object{"e9_switch_assign_join", `func Run(k int32) int32 {
    var s string? = nil
    switch k {
        case 1 { s = "a" }
        case 2 { s = "bb" }
        default { return 0 }
    }
    return s.Length
}
func Main() { Console.WriteLine(Run(1)) }`, "GS0158@8:14", "reject", "", "R4 (accepted after)"}
            yield[]object{"f1_dog_cat_join", `open class Animal {
    var Name string = "a"
}
class Dog : Animal { }
class Cat : Animal { }
func Run(x Animal?, c bool) string {
    if c {
        if x !is Dog { return "" }
    } else {
        if x !is Cat { return "" }
    }
    return x.Name
}
func Main() { Console.WriteLine(Run(Dog(), true)) }`, "", "run", "a", ""}
            yield[]object{"f2_ref_element_alias", `class C {
    var Value int32 = 1
}
func Run() int32 {
    var xs = []C?{C{}}
    let ref a C? = xs[0]
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() { Console.WriteLine(Run()) }`, "", "nre", "", "R12 (GS0158 after)"}
            yield[]object{"f3_replacement_exception_filter", `func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    try {
        try {
            try {
                throw FormatException("f")
            } finally {
                throw InvalidOperationException("g")
            }
        } catch (InvalidOperationException) {
            return s.Length
        }
    } catch (FormatException) when Clear(ref s) {
        return 0
    }
    return 2
}
func Main() { Console.WriteLine(Run()) }`, "GS0612@19:42", "nre", "", "R10 (GS0158 after)"}
            yield[]object{"f4_nullable_construction_boxes_nil", `func Get() object? { return "a" }
func Run(n int32) int32 {
    var x object? = Get()
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.ToString().Length
        x = System.Nullable[int32]()
    }
    return total
}
func Main() { Console.WriteLine(Run(2)) }`, "GS0159@7:27", "reject", "", ""}
            yield[]object{"f5_iterator_assigns_global", `var text string? = nil
func Items() sequence[int32] {
    text = nil
    yield 1
}
func Run() int32 {
    let items = Items()
    text = "safe"
    for item in items {
    }
    return text.Length
}
Console.WriteLine(Run())`, "GS0158@11:17 GS0286@13:1", "reject", "", ""}
            yield[]object{"f6_else_exit_hidden_member", `open class Animal {
    prop Name string -> "animal"
}
class Dog : Animal {
    prop Name string -> "dog"
}
func Run(x Animal) string {
    if x is Dog { } else { return "" }
    return x.Name
}
func Main() { Console.WriteLine(Run(Dog())) }`, "", "run", "dog", ""}
            yield[]object{"g1_three_predecessor_goto", `open class Animal {
    var Name string = "a"
}
class Dog : Animal { }
class Cat : Animal { }
func Run(x object?, k int32) string {
    if k == 0 {
        if x !is Dog { return "" }
        goto Done
    }
    if k == 1 {
        if x !is Cat { return "" }
        goto Done
    }
    if x !is Animal { return "" }
    Done:
    return x.Name
}
func Main() { Console.WriteLine(Run(Dog(), 0)) }`, "GS0158@17:14", "reject", "", "stays rejected until the guard lifts return (R6)"}
            yield[]object{"g2_ref_param_aliases_element", `class C {
    var Value int32 = 1
}
func Run(ref a C?, xs []C?) int32 {
    if a == nil { return 0 }
    xs[0] = nil
    return a.Value
}
func Main() {
    var xs = []C?{C{}}
    Console.WriteLine(Run(ref xs[0], xs))
}`, "", "nre", "", "R12 (GS0158 after)"}
            yield[]object{"g3_switch_failed_guard", `func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    switch 1 {
        case 1 when Clear(ref s) { return 0 }
    }
    return s.Length
}
func Main() { Console.WriteLine(Run()) }`, "GS0612@10:27 GS0158@12:14", "reject", "", "stays rejected (dispatch state threading)"}
            yield[]object{"g4_overload_ambiguity_after_join", `interface IA { }
interface IB { }
class Both : IA, IB { }
class Factory {
    shared {
        func Take(a IA) string { return "IA" }
        func Take(b IB) string { return "IB" }
    }
}
func Run(x IA) string {
    if x is Both { } else { return "" }
    return Factory.Take(x)
}
func Main() { Console.WriteLine(Run(Both())) }`, "GS0266@12:20", "reject", "", ""}
            yield[]object{"g5_yield_after_guard", `func Get() string? { return "a" }
func Items() sequence[int32] {
    var s string? = Get()
    let clear = func() { s = nil }
    if s != nil {
        yield 0
        yield s.Length
    }
}
func Main() {
    for item in Items() {
        Console.WriteLine(item)
    }
}`, "", "run", "0|1", "R13 (GS0158 after)"}
            yield[]object{"out-alias_out_ref_alias", `class C { func M() { } }
func Run(out c C?, ref alias C?) {
    c = C()
    if c != nil {
        for var i = 0; i < 2; i++ {
            c.M()
            c = C()
            alias = nil
        }
    }
}
func Main() {
    var x C? = nil
    Run(out x, ref x)
}`, "GS0159@6:15", "reject", "", ""}
            yield[]object{"h1_assign_in_exiting_branch_new_fact", `func Get() string? { return nil }
func Run() int32 {
    var t = Get()
    if t == nil {
        t = "x"
        return 1
    }
    return t.Length
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@8:14", "reject", "", "R2 (accepted after)"}
            yield[]object{"h2_call_in_exiting_branch_member_path", `open class Animal { var Name string = "" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func Log() { }
func Run(b Box) string {
    if b.Pet is Dog {
    } else {
        Log()
        return ""
    }
    return b.Pet.Bark()
}
func Main() { Console.WriteLine(Run(Box(Dog()))) }`, "GS0159@14:18", "reject", "", "R2 (accepted after)"}
            yield[]object{"h3_call_in_condition_before_fact", `open class Animal { var Name string = "" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func Ready() bool { return true }
func Run(b Box) string {
    if Ready() && b.Pet is Dog {
    } else {
        return ""
    }
    return b.Pet.Bark()
}
func Main() { Console.WriteLine(Run(Box(Dog()))) }`, "", "run", "woof", ""}
            yield[]object{"h4_call_in_then_branch_member_path", `open class Animal { var Name string = "" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func Log() { }
func Run(b Box) string {
    if b.Pet is Dog {
        Log()
    } else {
        return ""
    }
    return b.Pet.Bark()
}
func Main() { Console.WriteLine(Run(Box(Dog()))) }`, "GS0159@14:18", "reject", "", ""}
            yield[]object{"h5_strengthening_gain", `open class Animal { var Name string = "a" }
class Dog : Animal { func Bark() string { return "woof" } }
func Run(x Animal?) string {
    if x == nil { return "" }
    if x is Dog {
    } else {
        return ""
    }
    return x.Bark()
}
func Main() { Console.WriteLine(Run(Dog())) }`, "", "run", "woof", ""}
            yield[]object{"j1_else_if_chain_nary_join", `open class Animal { var Name string = "a" }
class Dog : Animal { }
class Cat : Animal { }
func Run(x object?, k int32) string {
    if k == 0 {
        if x !is Animal { return "" }
    } else if k == 1 {
        if x !is Dog { return "" }
    } else {
        if x !is Cat { return "" }
    }
    return x.Name
}
func Main() { Console.WriteLine(Run(Dog(), 1)) }`, "", "run", "a", ""}
            yield[]object{"i1_5206_type_test_against_unrelated_interface", `interface IInit {
    func Init();
}
class Plain {
    var Ready bool = false
}
class Setup : IInit {
    var Ready bool = false
    func Init() { Ready = true }
}
func Make[T class init()]() T {
    var settings T? = nil
    settings = T()
    if settings is IInit init {
        init.Init()
    }
    return settings
}
func Main() {
    Console.WriteLine(Make[Plain]().Ready)
    Console.WriteLine(Make[Setup]().Ready)
}`, "", "run", "False|True", ""}
            yield[]object{"i2_5206_goto_join_keeps_declared_type", `interface IInit {
    func Init();
}
class Setup : IInit {
    var Ready bool = false
    func Init() { Ready = true }
}
func Make[T class init()](k int32) T {
    var settings T? = nil
    settings = T()
    if k == 0 {
        if settings is IInit init {
            init.Init()
            goto Done
        }
    }
Done:
    return settings
}
func Main() { Console.WriteLine(Make[Setup](0).Ready) }`, "", "run", "True", ""}
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
