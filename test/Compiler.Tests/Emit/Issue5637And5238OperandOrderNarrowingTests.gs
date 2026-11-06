// <copyright file="Issue5637And5238OperandOrderNarrowingTests.cs" company="GSharp">
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

/// ADR-0208 regression tests for issues #5637 (sub-expression narrowing and
/// callable-alias effects apply between sequentially evaluated operands of the
/// same expression) and #5238 (enclosing `catch ... when` filter writes apply
/// after a sub-expression or `if` condition that may run code or an inner `try`).
open class Issue5637And5238OperandOrderNarrowingTests {
    @Theory
    @MemberData("Rows")
    func OperandOrderNarrowingProbes_ProduceExpectedDiagnosticsAndOutput(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "gs_5637_5238_" + Guid.NewGuid().ToString("N"))
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
            yield[]object{"r01_5637_call_in_left_operand_removes_global_fact_for_right_operand", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Run() int32 {
    if g == nil { return 0 }
    return Clear() + g.Value
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@12:24", "reject", ""}
            yield[]object{"r02_5637_computed_getter_in_left_operand_removes_byref_fact_for_right_operand", `import System

class Box {
    shared {
        var G string? = "ab"
    }
    prop P int32 {
        get {
            G = nil
            return 1
        }
    }
}
func Run(ref text string?, b Box) int32 {
    if text == nil { return 0 }
    return b.P + text.Length
}
Console.WriteLine(Run(ref Box.G, Box{}))`, "GS0158@16:23", "reject", ""}
            yield[]object{"r03_5637_open_auto_property_in_left_operand_removes_byref_fact_for_right_operand", `import System

open class Base {
    shared {
        var G string? = "ab"
    }
    open prop Auto int32 { get; set; }
}
class Derived : Base {
    override prop Auto int32 {
        get {
            Base.G = nil
            return 1
        }
        set { }
    }
}
func Run(ref text string?, b Base) int32 {
    if text == nil { return 0 }
    return b.Auto + text.Length
}
Console.WriteLine(Run(ref Base.G, Derived()))`, "GS0158@20:26", "reject", ""}
            yield[]object{"r04_5637_call_in_first_argument_removes_global_fact_for_second_argument", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Use(a int32, b int32) int32 {
    return a + b
}
func Run() int32 {
    if g == nil { return 0 }
    return Use(Clear(), g.Value)
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@15:27", "reject", ""}
            yield[]object{"r05_5637_control_read_in_first_operand_before_call_in_second_operand_is_accepted", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Run() int32 {
    if g == nil { return 0 }
    return g.Value + Clear()
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "8"}
            yield[]object{"r06_5637_control_read_in_first_argument_before_call_in_second_argument_is_accepted", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Use(a int32, b int32) int32 {
    return a + b
}
func Run() int32 {
    if g == nil { return 0 }
    return Use(g.Value, Clear())
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "8"}
            yield[]object{"r07_5637_ref_call_in_first_argument_removes_local_fact_for_second_argument", `import System

func ClearRef(ref s string?) int32 {
    s = nil
    return 1
}
func Use(a int32, b int32) int32 {
    return a + b
}
func Run(seed string?) int32 {
    var s = seed
    if s == nil { return 0 }
    return Use(ClearRef(ref s), s.Length)
}
Console.WriteLine(Run("abc"))`, "GS0612@13:25 GS0158@13:35", "reject", ""}
            yield[]object{"r08_5637_control_ref_address_in_first_argument_keeps_local_fact_for_second_argument", `import System

func ClearAfter(ref s string?, len int32) int32 {
    s = nil
    return len
}
func Run(seed string?) int32 {
    var s = seed
    if s == nil { return 0 }
    return ClearAfter(ref s, s.Length)
}
Console.WriteLine(Run("abcd"))`, "GS0612@10:23", "run", "4"}
            yield[]object{
                "r09_5238_enclosing_catch_filter_write_after_call_in_left_operand_removes_fact_for_right_operand",
                `import System

func Resume() int32 {
    try {
        throw FormatException()
    } catch (Exception) {
        return 0
    }
}
func Clear(ref s string?) bool {
    s = nil
    return false
}
func First(seed string?) int32 {
    var s = seed
    if s == nil { return 0 }
    try {
        return Resume() + s.Length
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
}
Console.WriteLine(First("abc"))`,
                "GS0158@18:29",
                "reject",
                ""
            }
            yield[]object{"r10_5238_enclosing_catch_filter_write_in_if_condition_removes_fact_for_then_branch", `import System

func Resume() int32 {
    try {
        throw FormatException()
    } catch (Exception) {
        return 0
    }
}
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Second(seed string?) int32 {
    var s = seed
    if s == nil { return 0 }
    try {
        if Resume() == 0 {
            return s.Length
        }
        return 0
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
}
Console.WriteLine(Second("abc"))`, "GS0158@19:22", "reject", ""}
            yield[]object{"r11_5238_control_read_before_call_in_try_with_enclosing_catch_filter_is_accepted", `import System

func Resume() int32 {
    try {
        throw FormatException()
    } catch (Exception) {
        return 0
    }
}
func Clear(ref s string?) bool {
    s = nil
    return false
}
func FirstControl(seed string?) int32 {
    var s = seed
    if s == nil { return 0 }
    try {
        return s.Length + Resume()
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
}
Console.WriteLine(FirstControl("abc"))`, "", "run", "3"}
            yield[]object{"r12_5637_call_in_left_operand_of_short_circuit_and_removes_fact_for_right_operand", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Run() int32 {
    if g == nil { return 0 }
    if Clear() == 1 && g.Value == 7 {
        return 1
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@12:26", "reject", ""}
            yield[]object{"r13_5637_control_read_in_left_operand_of_short_circuit_and_before_call_in_right_operand", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Run() int32 {
    if g == nil { return 0 }
    if g.Value == 7 && Clear() == 1 {
        return 1
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "1"}
            yield[]object{"r14_5238_enclosing_catch_filter_write_in_if_expression_condition_removes_fact_for_arm", `import System

func Resume() int32 {
    try {
        throw FormatException()
    } catch (Exception) {
        return 0
    }
}
func Clear(ref s string?) bool {
    s = nil
    return false
}
func SecondExpr(seed string?) int32 {
    var s = seed
    if s == nil { return 0 }
    try {
        return if Resume() == 0 { s.Length } else { 0 }
    } catch (FormatException) when Clear(ref s) {
        return -1
    }
}
Console.WriteLine(SecondExpr("abc"))`, "GS0158@18:37", "reject", ""}
            yield[]object{"r15_5637_struct_literal_computed_setter_invalidates_later_member_initializer", `import System

class C {
    var Value int32 = 7
}
class Holder {
    var X int32 = 0
    prop P int32 {
        get -> 0
        set {
            g = nil
        }
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let h = Holder{P: 1, X: g.Value}
    return h.X
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@17:31", "reject", ""}
            yield[]object{"r16_5637_implicit_conversion_on_earlier_argument_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 {
        g = nil
        return 1
    }
}
func Use(a int32, b int32) int32 -> a + b
func Run(t Token) int32 {
    if g == nil { return 0 }
    return Use(t, g.Value)
}
var g C? = C{}
Console.WriteLine(Run(Token{}))`, "GS0158@15:21", "reject", ""}
            yield[]object{"r17_5637_property_pattern_getter_invalidates_nested_subpattern", `import System

class C {
    var Value int32 = 7
}
class Box {
    prop P int32 {
        get {
            g = nil
            return 10
        }
    }
}
func Run(b Box) int32 {
    if g == nil { return 0 }
    return if b is {P: == g.Value} { 1 } else { 0 }
}
var g C? = C{}
Console.WriteLine(Run(Box{}))`, "GS0158@16:29", "reject", ""}
            yield[]object{"r18_5637_target_dependent_deferred_block_argument_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
func Clear() {
    g = nil
}
func Use(a string?, b int32) int32 -> b
func Run() int32 {
    if g == nil { return 0 }
    return Use({
        Clear()
        default
    }, g.Value)
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@15:10", "reject", ""}
            yield[]object{"r19_5637_method_group_receiver_call_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
func GetAndClear() object {
    g = nil
    return "ok"
}
func Use(f () -> string?, n int32) int32 -> n
func Run() int32 {
    if g == nil { return 0 }
    return Use(GetAndClear().ToString, g.Value)
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@13:42", "reject", ""}
            yield[]object{"r20_5637_ternary_and_if_expression_when_true_arm_does_not_bleed_into_when_false_arm", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Run(flag bool) int32 {
    if g == nil { return 0 }
    let a = flag ? Clear() : g.Value
    if g == nil { return a }
    let b = if flag { Clear() } else { g.Value }
    return a + b
}
var g C? = C{}
Console.WriteLine(Run(false))`, "", "run", "14"}
            yield[]object{"r21_5637_ternary_arm_effect_invalidates_later_sibling_operand", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Run(flag bool) int32 {
    if g == nil { return 0 }
    return (flag ? Clear() : 0) + g.Value
}
var g C? = C{}
Console.WriteLine(Run(true))`, "GS0158@12:37", "reject", ""}
            yield[]object{"r22_5637_compound_property_assignment_getter_invalidates_rhs", `import System

class C {
    var Value int32 = 7
}
class Box {
    var backing int32 = 1
    prop P int32 {
        get {
            g = nil
            return backing
        }
        set {
            backing = value
        }
    }
}
func Run(b Box) int32 {
    if g == nil { return 0 }
    b.P += g.Value
    return b.backing
}
var g C? = C{}
Console.WriteLine(Run(Box{}))`, "GS0129@20:9 GS0158@20:14", "reject", ""}
            yield[]object{"r23_5637_clr_constructor_argument_conversion_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 {
        g = nil
        return 1
    }
}
func Run(t Token) int32 {
    if g == nil { return 0 }
    let pair = Tuple[int32, int32](t, g.Value)
    return pair.Item1 + pair.Item2
}
var g C? = C{}
Console.WriteLine(Run(Token{}))`, "GS0158@14:41", "reject", ""}
            yield[]object{"r24_5637_interpolated_string_hole_formatting_invalidates_later_hole", `import System

class C {
    var Value int32 = 7
}
struct Tag {
    override func ToString() string {
        g = nil
        return "tag"
    }
}
func Run(t Tag) string {
    if g == nil { return "" }
    return "${t}${g.Value}"
}
var g C? = C{}
Console.WriteLine(Run(Tag{}))`, "GS0158@14:21", "reject", ""}
            yield[]object{"r25_5637_map_literal_entry_insertion_invalidates_later_entry", `import System

class C {
    var Value int32 = 7
}
struct Key {
    override func GetHashCode() int32 {
        g = nil
        return 1
    }
}
func Run(k Key) int32 {
    if g == nil { return 0 }
    let m = map[Key, int32]{k: 0, k: g.Value}
    return m.Count
}
var g C? = C{}
Console.WriteLine(Run(Key{}))`, "GS0158@14:40", "reject", ""}
            yield[]object{"r26_5637_binary_operator_left_operand_conversion_invalidates_right_operand", `import System

class C {
    var Value int32 = 7
}
struct Amount {
    var V int32
}
func (a Amount) operator +(b Amount) int32 -> a.V + b.V
struct Token {
    func operator implicit(t Token) Amount {
        g = nil
        return Amount{V: 1}
    }
}
func Run(t Token) int32 {
    if g == nil { return 0 }
    return t + Amount{V: g.Value}
}
var g C? = C{}
Console.WriteLine(Run(Token{}))`, "GS0158@18:28", "reject", ""}
            yield[]object{"r27_5637_unqualified_static_call_rebind_tracks_argument_conversion", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 {
        g = nil
        return 1
    }
}
class Holder {
    shared {
        func Use(a int32, b int32) int32 -> a + b
        func Run(t Token) int32 {
            if g == nil { return 0 }
            return Use(t, g.Value)
        }
    }
}
var g C? = C{}
Console.WriteLine(Holder.Run(Token{}))`, "GS0158@17:29", "reject", ""}
            yield[]object{"r28_5637_struct_literal_construction_does_not_scan_later_member_initializers", `import System

class Box {
    let Text string? = "abc"
}
struct Pair {
    var A int32
    var B int32
}
func Clear() int32 -> 4
func Run(b Box) int32 {
    if b.Text == nil { return 0 }
    let p = Pair{A: b.Text.Length, B: Clear()}
    return p.A + p.B
}
Console.WriteLine(Run(Box{}))`, "", "run", "7"}
            yield[]object{"r29_5637_invalidated_subtype_fact_retested_in_same_condition_narrows_branch", `import System

func Touch() bool -> true
func Run(seed object) int32 {
    var x = seed
    let mutate = () -> {
        x = "hello"
    }
    if x is string {
        if Touch() && x is string {
            return x.Length
        }
    }
    mutate()
    return 0
}
Console.WriteLine(Run("abc"))`, "", "run", "3"}
            yield[]object{"r30_5637_nested_ternary_with_throwing_arm_in_then_branch_restores_fact_for_else_branch", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Run(flag bool, cond bool) int32 {
    if g == nil { return 0 }
    if flag {
        let _ = cond ? Clear() : throw InvalidOperationException()
        return 0
    } else {
        return g.Value
    }
}
var g C? = C{}
Console.WriteLine(Run(false, true))`, "", "run", "7"}
            yield[]object{"r31_5637_single_candidate_user_indexer_read_sequences_argument_effects", `import System

class C {
    var Value int32 = 7
}
class Table {
    prop this[a int32, b int32] int32 {
        get -> a + b
    }
}
func Clear() int32 {
    g = nil
    return 1
}
func Run(table Table) int32 {
    if g == nil { return 0 }
    return table[Clear(), g.Value]
}
var g C? = C{}
Console.WriteLine(Run(Table{}))`, "GS0158@17:29", "reject", ""}
            yield[]object{"r32_5637_multi_index_user_assignment_sequences_index_and_value_effects", `import System

class C {
    var Value int32 = 7
}
class Table {
    var stored int32 = 0
    prop this[a int32, b int32] int32 {
        get -> stored
        set {
            stored = a + b + value
        }
    }
}
func Clear() int32 {
    g = nil
    return 1
}
func Run(table Table) int32 {
    if g == nil { return 0 }
    table[Clear(), 0] = g.Value
    return table.stored
}
var g C? = C{}
Console.WriteLine(Run(Table{}))`, "GS0158@21:27", "reject", ""}
            yield[]object{"r33_5637_mixed_struct_literal_collection_spread_invalidates_later_member", `import System
import System.Collections.Generic

class C {
    var Value int32 = 7
}
class Bag {
    var Marker int32 = 0
    var Length int32 = 0
    let items List[int32] = List[int32]()
    func Add(x int32) {
        items.Add(x)
    }
}
func GetItems() []int32 {
    g = nil
    return []int32{1, 2}
}
func Run() int32 {
    if g == nil { return 0 }
    let bag = Bag{Marker: 1, ...GetItems(), Length: g.Value}
    return bag.Length
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@21:55", "reject", ""}
            yield[]object{"r34_5637_binary_operator_left_conversion_rebuilds_rhs_and_replaces_stale_gs0536", `import System

struct Amount {
    var V int32
}
func (a Amount) operator +(b Amount) int32 -> a.V + b.V
struct Token {
    func operator implicit(t Token) Amount {
        return Amount{V: 1}
    }
}
func Pick(s string) int32 -> 1
func Pick(o object) int32 -> 10
func Run(t Token, ref x object) int32 {
    if x is string {
        return t + Amount{V: Pick(x)}
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Token{}, ref seed))`, "", "run", "11"}
            yield[]object{"r35_5637_call_argument_conversion_propagates_rebound_overload_and_replaces_gs0536", `import System

struct Token {
    func operator implicit(t Token) int32 {
        return 1
    }
}
func Pick(s string) int32 -> 1
func Pick(o object) int32 -> 10
func Use(a int32, b int32) int32 -> a + b
func Run(t Token, ref x object) int32 {
    if x is string {
        return Use(t, Pick(x))
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Token{}, ref seed))`, "", "run", "11"}
            yield[]object{"r36_5637_parenthesized_target_typed_branchy_first_argument_snapshots_before_later_effect", `import System

class C {
    var Value int32 = 7
}
interface IItem {
    func Score() int32;
}
open class Base {
}
class A : Base, IItem {
    var N int32
    func Score() int32 -> N
}
class B : Base, IItem {
    func Score() int32 -> 2
}
func Clear() int32 {
    g = nil
    return 3
}
func Use(item IItem, n int32) int32 -> item.Score() + n
func Run(flag bool) int32 {
    if g == nil { return 0 }
    return Use((flag ? A{N: g.Value} : B{}), Clear())
}
var g C? = C{}
Console.WriteLine(Run(true))`, "", "run", "10"}
            yield[]object{"r37_5637_custom_interpolated_string_handler_append_invalidates_later_hole", `import System

class C {
    var Value int32 = 7
}
func Run(provider IFormatProvider?) string {
    if g == nil { return "" }
    return string.Create(provider, "${1}${g.Value}")
}
var g C? = C{}
Console.WriteLine(Run(nil))`, "GS0158@8:45", "reject", ""}
            yield[]object{"r38_5637_overloaded_user_indexer_final_index_conversion_invalidates_rhs", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 {
        g = nil
        return 1
    }
}
class Table {
    var stored int32 = 0
    prop this[a int32, b int32] int32 {
        get -> stored
        set {
            stored = a + b + value
        }
    }
    prop this[a string, b string] int32 {
        get -> stored
        set {
            stored = value
        }
    }
}
func Run(table Table, t Token) int32 {
    if g == nil { return 0 }
    table[0, t] = g.Value
    return table.stored
}
var g C? = C{}
Console.WriteLine(Run(Table{}, Token{}))`, "GS0158@29:21", "reject", ""}
            yield[]object{"r39_5637_overloaded_user_indexer_earlier_index_conversion_rebuilds_later_index_capture", `import System

struct Token {
    func operator implicit(t Token) int32 {
        return 1
    }
}
class Table {
    var stored int32 = 0
    prop this[a int32, b int32] int32 {
        get -> stored
        set {
            stored = a + b + value
        }
    }
    prop this[a string, b string] int32 {
        get -> stored
        set {
            stored = value
        }
    }
}
func Pick(s string) int32 -> 1
func Pick(o object) int32 -> 10
func Run(table Table, t Token, ref x object) int32 {
    if x is string {
        table[t, Pick(x)] = 0
        return table.stored
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Table{}, Token{}, ref seed))`, "", "run", "11"}
            yield[]object{"r40_5637_conditional_ref_argument_with_earlier_conversion_does_not_recurse", `import System

struct Token {
    func operator implicit(t Token) int32 {
        return 1
    }
}
func Use(ref b int32, a int32, c int32) int32 {
    b += a + c
    return b
}
func Run(t Token, cond bool) int32 {
    var x = 10
    var y = 20
    var g string? = "ok"
    if g == nil { return 0 }
    return Use(ref cond ? x : y, t, 0)
}
Console.WriteLine(Run(Token{}, true))`, "", "run", "11"}
            yield[]object{"r41_5637_target_dependent_deferred_block_tail_condition_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
func ClearFlag() bool {
    g = nil
    return true
}
func Use(a string?, b int32) int32 -> b
func Run() int32 {
    if g == nil { return 0 }
    return Use({ ClearFlag() ? default : default }, g.Value)
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@13:55", "reject", ""}
            yield[]object{"r42_5637_indirect_call_ref_argument_rebuilds_lvalue_after_earlier_conversion", `import System

struct Token {
    func operator implicit(t Token) int32 {
        return 1
    }
}
delegate Op(a int32, ref b int32) int32;
func Pick(s string) int32 -> 0
func Pick(o object) int32 -> 1
func Target(a int32, ref b int32) int32 -> a + b
func Run(d Op, t Token, ref x object) int32 {
    let arr = []int32{10, 20}
    if x is string {
        return d(t, ref arr[Pick(x)])
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Target, Token{}, ref seed))`, "", "run", "21"}
            yield[]object{"r43_5637_chained_property_getter_receiver_of_indexer_invalidates_index_argument", `import System

class C {
    var Value int32 = 0
}
class Holder {
    let backing []int32 = []int32{42}
    prop Items []int32 {
        get {
            g = nil
            return backing
        }
    }
}
func Run(h Holder) int32 {
    if g == nil { return 0 }
    return h.Items[g.Value]
}
var g C? = C{}
Console.WriteLine(Run(Holder{}))`, "GS0158@17:22", "reject", ""}
            yield[]object{"r44_5637_null_conditional_delegate_invocation_tracks_argument_conversion", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 {
        g = nil
        return 1
    }
}
func Run(cb ((int32, int32) -> int32)?, t Token) int32 {
    if g == nil { return 0 }
    return cb?(t, g.Value) ?? 0
}
var g C? = C{}
Console.WriteLine(Run(nil, Token{}))`, "GS0158@14:21", "reject", ""}
            yield[]object{"r45_5637_deferred_block_switch_arm_effect_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Use(a int32?, b int32) int32 -> b
func Run(x int32) int32 {
    if g == nil { return 0 }
    return Use({ switch x { case 0: Clear() default: default } }, g.Value)
}
var g C? = C{}
Console.WriteLine(Run(0))`, "GS0158@13:69", "reject", ""}
            yield[]object{"r46_5637_deferred_block_if_let_effect_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
func Clear() int32 {
    g = nil
    return 1
}
func Use(a int32?, b int32) int32 -> b
func Run(opt int32?) int32 {
    if g == nil { return 0 }
    return Use({ if let v = opt { Clear() } else { default } }, g.Value)
}
var g C? = C{}
Console.WriteLine(Run(1))`, "GS0158@13:67", "reject", ""}
            yield[]object{"r47_5637_nested_call_conversion_verified_during_outer_call_verification", `import System

class C {
    var Value int32 = 7
}
struct OuterToken {
    func operator implicit(t OuterToken) int32 -> 1
}
struct InnerToken {
    func operator implicit(t InnerToken) int32 {
        g = nil
        return 2
    }
}
func Inner(a int32, b int32) int32 -> a + b
func Outer(a int32, b int32) int32 -> a + b
func Run(ot OuterToken, it InnerToken) int32 {
    if g == nil { return 0 }
    return Outer(ot, Inner(it, g.Value))
}
var g C? = C{}
Console.WriteLine(Run(OuterToken{}, InnerToken{}))`, "GS0158@19:34", "reject", ""}
            yield[]object{"r48_5637_narrowed_callable_variable_evaluated_before_argument_effects", `import System

func ClearAndReturn() int32 {
    cb = nil
    return 10
}
func Run() int32 {
    if cb == nil { return 0 }
    return cb(ClearAndReturn())
}
var cb ((int32) -> int32)? = (x int32) -> x + 5
Console.WriteLine(Run())`, "", "run", "15"}
            yield[]object{"r49_5637_indirect_call_conditional_ref_argument_rebuilt_after_conversion", `import System

struct Token {
    func operator implicit(t Token) int32 -> 1
}
delegate Op(a int32, ref b int32) int32;
func Pick(s string) int32 -> 0
func Pick(o object) int32 -> 1
func Target(a int32, ref b int32) int32 -> a + b
func Run(d Op, t Token, cond bool, ref x object) int32 {
    let arr = []int32{10, 20}
    if x is string {
        return d(t, ref cond ? arr[Pick(x)] : arr[0])
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Target, Token{}, true, ref seed))`, "", "run", "21"}
            yield[]object{"r50_5637_native_slice_receiver_effects_invalidate_call_argument", `import System

class C {
    var Value int32 = 0
}
func (s span[int32]) At(idx int32) int32 -> s[idx]
func GetSliceAndClear(backing []int32) span[int32] {
    g = nil
    return span[int32](backing)
}
func Run() int32 {
    if g == nil { return 0 }
    let arr = []int32{1, 2, 3}
    return GetSliceAndClear(arr).At(g.Value)
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@14:39", "reject", ""}
            yield[]object{"r51_5637_binary_operator_left_conversion_invalidating_rhs_type_reports_gs0129", `import System

struct Amount {
    var V int32
}
func (a Amount) operator +(b int32) int32 -> a.V + b
struct Token {
    func operator implicit(t Token) Amount {
        g = nil
        return Amount{V: 1}
    }
}
func Run(t Token) int32 {
    if g == nil { return 0 }
    return t + g
}
var g int32? = 5
Console.WriteLine(Run(Token{}))`, "GS0129@15:14", "reject", ""}
            yield[]object{"r52_5637_multi_assignment_target_receiver_invalidates_earlier_rhs_value", `import System

class C {
    var Value int32 = 7
}
class Box {
    var Slot int32 = 0
}
func GetBoxAndClear(b Box) Box {
    g = nil
    return b
}
func Run(b Box) int32 {
    if g == nil { return 0 }
    var a = 0
    a, GetBoxAndClear(b).Slot = g.Value, 1
    return a + b.Slot
}
var g C? = C{}
Console.WriteLine(Run(Box{}))`, "GS0158@16:35", "reject", ""}
            yield[]object{"r53_5637_deferred_block_arm_implicit_conversion_invalidates_later_argument", `import System

class C {
    var Value int32 = 7
}
struct Target {
    var V int32
}
struct Token {
    func operator implicit(t Token) Target {
        g = nil
        return Target{V: 1}
    }
}
func Use(a Target, b int32) int32 -> a.V + b
func Run(flag bool, t Token) int32 {
    if g == nil { return 0 }
    return Use({ flag ? t : default }, g.Value)
}
var g C? = C{}
Console.WriteLine(Run(true, Token{}))`, "GS0158@18:42", "reject", ""}
            yield[]object{"r54_5637_property_pattern_plain_field_preserves_narrowing_for_nested_relational_call", `import System

class C {
    var Value int32 = 7
}
class Box {
    var Tag int32 = 7
}
func Keep(x int32) int32 -> x
func Run(b Box) int32 {
    if g == nil { return 0 }
    if b is Box{Tag: == Keep(g.Value)} {
        return 1
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Box{}))`, "", "run", "1"}
            yield[]object{"r55_5637_multi_assignment_target_index_conversion_invalidates_earlier_rhs_value", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 {
        g = nil
        return 0
    }
}
func Run(t Token) int32 {
    if g == nil { return 0 }
    var a = 0
    let arr = []int32{1, 2}
    a, arr[t] = g.Value, 9
    return a + arr[0]
}
var g C? = C{}
Console.WriteLine(Run(Token{}))`, "GS0158@16:19", "reject", ""}
            yield[]object{"r56_5637_rebound_call_argument_updates_inline_out_var_type_in_scope", `import System

struct Token {
    func operator implicit(t Token) int32 -> 1
}
func Pick(s string, out v int32) int32 {
    v = s.Length
    return 1
}
func Pick(o object, out v string) int32 {
    v = "ten"
    return 10
}
func Use(a int32, b int32) int32 -> a + b
func Run(t Token, ref x object) int32 {
    if x is string {
        let r = Use(t, Pick(x, out var val))
        return r + val.Length
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Token{}, ref seed))`, "", "run", "14"}
            yield[]object{"r57_5637_conditional_ref_argument_isolates_true_branch_effects_from_false_branch", `import System

class C {
    var Value int32 = 1
}
func Clear() int32 {
    g = nil
    return 0
}
func Take(ref x int32) int32 -> x
func Run(flag bool) int32 {
    if g == nil { return 0 }
    let arr = []int32{10, 20}
    return Take(ref flag ? arr[Clear()] : arr[g.Value])
}
var g C? = C{}
Console.WriteLine(Run(false))`, "", "run", "20"}
            yield[]object{"r58_5637_overloaded_user_indexer_read_rebinds_overload_after_index_conversion", `import System

struct Token {
    func operator implicit(t Token) int32 -> 1
}
class Table {
    prop this[a int32, b string] int32 {
        get -> a + b.Length
    }
    prop this[a int32, b object] int32 {
        get -> a + 10
    }
}
func Run(table Table, t Token, ref x object) int32 {
    if x is string {
        return table[t, x]
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Table{}, Token{}, ref seed))`, "", "run", "11"}
            yield[]object{"r59_5637_null_conditional_indexed_write_receiver_effects_invalidate_index", `import System

class C {
    var Value int32 = 0
}
class Holder {
    let Items []int32 = []int32{1, 2}
}
func GetAndClear(h Holder) Holder? {
    g = nil
    return h
}
func Run(h Holder) int32 {
    if g == nil { return 0 }
    GetAndClear(h)?.Items[g.Value] = 9
    return h.Items[0]
}
var g C? = C{}
Console.WriteLine(Run(Holder{}))`, "GS0158@15:29", "reject", ""}
            yield[]object{"r60_5637_compound_assignment_left_conversion_invalidates_rhs", `import System

class C {
    var Value int32 = 7
}
struct Amount {
    var V int32
}
struct Token {
    var V int32
    func operator implicit(t Token) Amount {
        g = nil
        return Amount{V: t.V}
    }
}
func (a Amount) operator +(b Amount) Token -> Token{V: a.V + b.V}
func Run(t Token) int32 {
    if g == nil { return 0 }
    var cur = t
    cur += Amount{V: g.Value}
    return cur.V
}
var g C? = C{}
Console.WriteLine(Run(Token{V: 1}))`, "GS0158@20:24", "reject", ""}
            yield[]object{"r61_5637_if_let_explicit_type_clause_conversion_invalidates_body", `import System

class C {
    var Value int32 = 7
}
struct Target {
    var V int32
}
struct Source {
    func operator implicit(s Source) Target {
        g = nil
        return Target{V: 1}
    }
}
func Run(src Source?) int32 {
    if g == nil { return 0 }
    return if let v Target = src { g.Value } else { 0 }
}
var g C? = C{}
Console.WriteLine(Run(Source{}))`, "GS0158@17:38", "reject", ""}
            yield[]object{"r62_5637_contextual_tuple_conversion_earlier_element_invalidates_later_element", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 {
        g = nil
        return 1
    }
}
func Run(t Token) int32 {
    if g == nil { return 0 }
    let pair (int32, int32) = (t, g.Value)
    return pair.Item1 + pair.Item2
}
var g C? = C{}
Console.WriteLine(Run(Token{}))`, "GS0158@14:37", "reject", ""}
            yield[]object{"r63_5637_indirect_delegate_call_conversion_preserves_inline_out_var_in_scope", `import System

struct Token {
    func operator implicit(t Token) int32 -> 1
}
delegate Op(a int32, out b int32) int32;
func Target(a int32, out b int32) int32 {
    b = a + 10
    return a
}
func Run(d Op, t Token) int32 {
    var g string? = "ok"
    if g == nil { return 0 }
    let r = (d)(t, out var n)
    return r + n
}
Console.WriteLine(Run(Target, Token{}))`, "", "run", "12"}
            yield[]object{"r64_5637_tuple_multi_assignment_dictionary_indexer_does_not_read_getter", `import System
import System.Collections.Generic

class C {
    var Value int32 = 7
}
func Run(items Dictionary[string, int32]) int32 {
    if g == nil { return 0 }
    var n = 0
    items["x"], n = (g.Value, 1)
    return items["x"] + n
}
var g C? = C{}
Console.WriteLine(Run(Dictionary[string, int32]()))`, "", "run", "8"}
            yield[]object{"r65_5637_system_index_assignment_probe_applies_index_effects_before_rhs", `import System

class C {
    var Value int32 = 7
}
func ClearIndex() Index {
    g = nil
    return ^1
}
func Run() int32 {
    if g == nil { return 0 }
    let arr = []int32{1, 2}
    arr[ClearIndex()] = g.Value
    return arr[1]
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@13:27", "reject", ""}
            yield[]object{"r66_5637_compound_assignment_rebind_restores_pre_rhs_snapshot", `import System

struct Amount {
    var V int32
}
struct Token {
    var V int32
    func operator implicit(t Token) Amount -> Amount{V: t.V}
}
func (a Amount) operator +(b Amount) Token -> Token{V: a.V + b.V}
func MakeAmount(len int32, cleared string?) Amount -> Amount{V: len}
func Run(t Token, seed string?) int32 {
    var s = seed
    if s == nil { return 0 }
    var cur = t
    cur += MakeAmount(s.Length, (s = nil))
    return cur.V
}
Console.WriteLine(Run(Token{V: 2}, "abcd"))`, "", "run", "6"}
            yield[]object{"r67_5637_conditional_ref_argument_preserves_declared_storage_type_on_narrowed_lvalue", `import System

func Clear(ref target string?) {
    target = nil
}
func Run(aSeed string?, bSeed string?) string {
    var a = aSeed
    var b = bSeed
    Clear(ref (a != nil ? a : b))
    return (a ?? "nil") + ":" + (b ?? "nil")
}
Console.WriteLine(Run("x", "y"))`, "", "run", "nil:y"}
            yield[]object{"r68_5637_inherited_user_indexer_reselection_updates_receiver_view", `import System

struct Token {
    func operator implicit(t Token) int32 -> 1
}
open class Base[T] {
    var Stored int32 = 0
    open prop this[a int32, b string] T {
        get -> default(T)
        set {
            Stored = a + b.Length
        }
    }
}
class Derived : Base[int32] {
    prop this[a int32, b object] int32 {
        get -> Stored
        set {
            Stored = a + value + 10
        }
    }
}
func MakeDerived(d Derived) Derived -> d
func Run(d Derived, t Token, ref x object) int32 {
    if x is string {
        MakeDerived(d)[t, x] = 5
        return d.Stored
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Derived{}, Token{}, ref seed))`, "", "run", "16"}
            yield[]object{"r69_5637_explicit_tuple_cast_preserves_explicit_conversion_during_verification", `import System

struct Token {
    func operator implicit(t Token) int32 -> 1
}
func Run(t Token, n int64) int32 {
    var g string? = "ok"
    if g == nil { return 0 }
    let pair = cast[(int32, int32)]((t, n))
    return pair.Item1 + pair.Item2
}
Console.WriteLine(Run(Token{}, 9))`, "", "run", "10"}
            yield[]object{"r70_5637_block_expression_array_index_with_typed_sibling_binds_eagerly", `import System

func Run(flag bool) int32 {
    let arr = []int32{10, 20}
    return arr[{ flag ? 1 : default }]
}
Console.WriteLine(Run(true))`, "", "run", "20"}
            yield[]object{"r71_5637_overloaded_user_indexer_reselection_to_getter_only_reports_error", `import System

struct Token {
    func operator implicit(t Token) int32 -> 1
}
class Table {
    var stored int32 = 0
    prop this[a int32, b string] int32 {
        get -> stored
        set {
            stored = a + b.Length + value
        }
    }
    prop this[a int32, b object] int32 {
        get -> stored
    }
}
func Run(table Table, t Token, ref x object) int32 {
    if x is string {
        table[t, x] = 5
        return table.stored
    }
    return 0
}
var seed object = "abc"
Console.WriteLine(Run(Table{}, Token{}, ref seed))`, "GS0116@20:9", "reject", ""}
            yield[]object{"r72_5637_lambda_argument_rebind_retains_replaced_diagnostic_under_duplicate_suppression", `import System

class C {
    var Value int32 = 7
}
struct Token {
    func operator implicit(t Token) int32 -> 1
}
func Use(a int32, f Func[int32, int32]) int32 -> a + f(1)
func Run(t Token) int32 {
    var s C? = nil
    if g == nil { return 0 }
    return Use(t, (x) -> {
        let _ = s.Value
        return x
    })
}
var g C? = C{}
Console.WriteLine(Run(Token{}))`, "GS0158@14:19", "reject", ""}
            yield[]object{"r73_5637_relational_equality_pattern_input_conversion_invalidates_pattern_value", `import System

class C {
    var Value int32 = 7
}
struct Amount {
    var V int32
}
func (a Amount) operator ==(b Amount) bool -> a.V == b.V
func (a Amount) operator !=(b Amount) bool -> a.V != b.V
struct Token {
    func operator implicit(t Token) Amount {
        g = nil
        return Amount{V: 7}
    }
}
func Run(t Token) int32 {
    if g == nil { return 0 }
    if t is == Amount{V: g.Value} {
        return 1
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run(Token{}))`, "GS0158@19:28", "reject", ""}
            yield[]object{"r74_5637_data_struct_primary_input_after_body_member_binds_before_construction_effects", `import System

class C {
    var Value int32 = 7
}
func SideEffect() int32 {
    g = nil
    return 1
}
data struct D(A int32) {
    var B int32 = SideEffect()
}
func Run() int32 {
    if g == nil { return 0 }
    let d = D{B: 2, A: g.Value}
    return d.A + d.B
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "9"}
            yield[]object{"r75_5637_color_color_unified_instance_receiver_keeps_entry_narrowing_before_arg_effects", `import System

class Box {
    var V int32 = 40
    func M(x int32) int32 -> V + x
    shared {
        func M(s string) int32 -> s.Length
    }
}
func Run() int32 {
    var Box object = Box{}
    if Box is Box {
        return Box.M((Box = "replaced") != nil ? 2 : 0)
    }
    return 0
}
Console.WriteLine(Run())`, "", "run", "42"}
            yield[]object{"r76_5637_indirect_delegate_call_revalidates_ref_argument_storage_type_after_conversion", `import System

delegate D(n int32, ref slot int32) int32;
struct Token {
    func operator implicit(t Token) int32 {
        x = 1
        return 7
    }
}
func Choose(s string) []int32 -> arr32
func Choose(o object) []int64 -> arr64
func Run(d D, token Token) int32 {
    if x is not string { return 0 }
    return (d)(token, ref Choose(x)[0])
}
let arr32 = []int32{10}
let arr64 = []int64{20}
var x object = "ok"
Console.WriteLine(Run((n int32, ref slot int32) -> n + slot, Token{}))`, "GS0154@14:23", "reject", ""}
            yield[]object{"r77_5637_generic_struct_literal_inference_accounts_for_concrete_member_and_primary_order", `import System

class C {
    var Value int32 = 9
}
class Holder[T] {
    var A int32
    var B T
}
data struct D[T](A T) {
    var B T
}
func Clear() int32 {
    g = nil
    return 3
}
func Run() int32 {
    g = C{}
    if g == nil { return 0 }
    let h = Holder{A: Clear(), B: g}
    g = C{}
    if g == nil { return 0 }
    let d = D{B: Clear() + 0, A: g.Value}
    return h.A + (h.B?.Value ?? 0) + d.A + d.B
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "15"}
            yield[]object{"r78_5637_generic_primary_and_explicit_constructor_inference_applies_argument_effects", `import System

class C {
    var Value int32 = 5
}
data class Box[T](N int32, Value T)
class ExplicitBox[T] {
    var N int32
    var Value T
    init(n int32, value T) {
        N = n
        Value = value
    }
}
func Clear() int32 {
    g = nil
    return 4
}
func Run() int32 {
    g = C{}
    if g == nil { return 0 }
    let b1 = Box(Clear(), g)
    g = C{}
    if g == nil { return 0 }
    let b2 = ExplicitBox(Clear(), g)
    return b1.N + (b1.Value?.Value ?? 0) + b2.N + (b2.Value?.Value ?? 0)
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "8"}
            yield[]object{"r79_5637_clr_single_index_write_applies_index_conversion_effects_before_rhs", `import System
import System.Collections.Generic

class C {
    var Value int32 = 9
}
func Run(items Dictionary[DateTimeOffset, int32], dt DateTime) int32 {
    if g == nil { return 0 }
    items[dt] = g.Value
    return items.Count
}
var g C? = C{}
Console.WriteLine(Run(Dictionary[DateTimeOffset, int32](), DateTime.UtcNow))`, "GS0158@9:19", "reject", ""}
            yield[]object{"r80_5637_struct_literal_inference_includes_collection_add_and_braced_member_effects", `import System
import System.Collections
import System.Collections.Generic

class C {
    var Value int32 = 11
}
struct Bag[T] : IEnumerable[int32] {
    var Tag int32
    var Value T
    func Add(x int32) {
        g = nil
    }
    func GetEnumerator() IEnumerator[int32] -> List[int32]().GetEnumerator()
    func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
}
struct NestedBag[T] {
    var Inner Bag[int32]
    var Value T
}
func Run() int32 {
    g = C{}
    if g == nil { return 0 }
    let b1 = Bag{Tag: 0, 1, Value: g}
    g = C{}
    if g == nil { return 0 }
    let b2 = NestedBag{Inner: {1}, Value: g}
    return (b1.Value?.Value ?? 4) + (b2.Value?.Value ?? 5)
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "9"}
            yield[]object{"r81_5637_list_pattern_evaluates_prefix_and_suffix_before_slice_subpattern", `import System

class C {
    var Value int32 = 1
}
func Clear() int32 {
    g = nil
    return 2
}
func Run(xs []int32) int32 {
    if g == nil { return 0 }
    if xs is [..[== Clear()], > g.Value] {
        return 10
    }
    return 0
}
var g C? = C{}
Console.WriteLine(Run([]int32{2, 5}))`, "", "run", "10"}
            yield[]object{"r82_5637_tuple_multi_assignment_applies_ref_getter_indexer_capture_effects_before_rhs", `import System

class C {
    var Value int32 = 7
}
class Holder {
    var slot int32 = 0
    prop this[i int32] ref int32 {
        get {
            g = nil
            return ref slot
        }
    }
}
func Run(h Holder) int32 {
    if g == nil { return 0 }
    var n = 0
    h[0], n = (g.Value, 1)
    return h.slot + n
}
var g C? = C{}
Console.WriteLine(Run(Holder{}))`, "GS0158@18:18", "reject", ""}
            yield[]object{"r83_5637_one_sided_conditional_assignment_preserves_maybe_null_widening", `import System
import System.Collections.Generic

func Run(dict Dictionary[string, string], flag bool) int32 {
    var value string = "init"
    if !dict.TryGetValue("missing", out value) {
        let r = flag ? (value = "ok") : "skip"
        return r.Length + value.Length
    }
    return value.Length
}
Console.WriteLine(Run(Dictionary[string, string](), false))`, "GS0158@8:33", "reject", ""}
            yield[]object{
                "r84_5637_argument_reassigning_callee_to_external_callable_still_invalidates_from_entry_callee",
                `import System

func Run(replacement (object?) -> int32) int32 {
    var s string? = "abc"
    var f (object?) -> int32 = (_ object?) -> {
        s = nil
        return 1
    }
    if s == nil { return 0 }
    return f((f = replacement)) + s.Length
}
Console.WriteLine(Run((_ object?) -> 2))`,
                "GS0158@10:37",
                "reject",
                ""
            }
            yield[]object{"r85_5637_compound_assignment_and_tuple_conversion_rebinds_preserve_checked_context", `import System

struct Amount {
    var V int32
}
func (a Amount) operator +(b Amount) Token -> Token{}
struct Token {
    func operator implicit(t Token) Amount {
        g = "cleared"
        return Amount{V: 1}
    }
}
func MakeAmount(n int32) Amount -> Amount{V: n}
func Run(max int32) string {
    var a = 0
    try {
        var t = Token{}
        t += checked(MakeAmount(max + 1))
    } catch (OverflowException) {
        a = 1
    }
    var b = 0
    try {
        let pair (Amount, int32) = checked((Token{}, max + 1))
        a += pair.Item2
    } catch (OverflowException) {
        b = 1
    }
    return "$a,$b"
}
var g string? = "ok"
Console.WriteLine(Run(int32.MaxValue))`, "", "run", "1,1"}
            yield[]object{"r86_5637_long_left_associative_chain_after_call_keeps_parameter_narrowing", `import System

func Step() int32 -> 1
func Run(s string?) int32 {
    if s == nil { return 0 }
    return Step() + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + s.Length
}
Console.WriteLine(Run("abcd"))`, "", "run", "15"}
            yield[]object{"r87_5637_qualified_callable_member_invocation_uses_pre_argument_narrowing", `import System

class Src { prop N int32 -> 7 }
class Inner {
    let H Action[Src]?
    init(h Action[Src]?) { H = h }
}
class Outer {
    let B Inner
    init(b Inner) { B = b }
}
let write Action[Src] = (s Src) -> Console.WriteLine(s.N)
let outer = Outer(Inner(write))
if outer.B.H != nil {
    outer.B.H(Src())
}`, "", "run", "7"}
            yield[]object{"r88_5637_callable_property_fallback_with_inapplicable_method_invalidates_argument", `import System

class Box(Value int32) {}
class Host {
    prop Callback (int32) -> int32 {
        get {
            g = nil
            return (n int32) -> n
        }
    }
}
func Run(h Host) int32 {
    if g == nil { return 0 }
    return h.Callback(g.Value)
}
var g Box? = Box(4)
Console.WriteLine(Run(Host{}))`, "GS0158@14:25", "reject", ""}
            yield[]object{"r89_5637_null_coalescing_assignment_skipped_rhs_keeps_nullable_widening", `import System
import System.Collections.Generic

func Run(dict Dictionary[string, string], ref target string?) int32 {
    if dict.TryGetValue("k", out var value) {
        return value.Length
    }
    target ??= (value = "ok") + ""
    return value.Length
}
var t string? = "already"
Console.WriteLine(Run(Dictionary[string, string](), ref t))`, "GS0158@9:18", "reject", ""}
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
