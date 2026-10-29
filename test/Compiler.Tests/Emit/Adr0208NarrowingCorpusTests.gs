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
/// result. The soundness rows (cA, d1, d1b, d3, d3b, d4, d4b, f2, f3, f5, g2)
/// pinned run-time crashes (bugs #5168, #5170 and #5171). Each fix flipped its
/// rows in the same change, and they now record GS0158.
/// Each row names the row of ADR-0208 section 16 that changes it, if any.
/// PR 2, slice 2a flipped e7 (Run2), e8, e10, e21, f1, f6 and g4 (rows R1, R3,
/// R5) and added h1 to h7, i1, i2, j1, k1, k2, l1, l2, m1, n1, o1, o2 and o3 (issue #5206, amendment A1). They now
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
                "h10_tuple_by_ref_parameter_overlaps_element",
                "h11_enclosing_type_argument_by_ref_parameters_overlap",
                "h12_conditional_out_argument_of_imported_call",
                "h13_indexer_setter_clears_aliased_member",
                "h14_null_conditional_receiver_repeats_ref_argument",
                "h15_ref_local_alias_repeats_ref_argument",
                "h16_ref_local_alias_passed_twice",
                "h17_conditional_ref_argument_of_imported_call",
                "h1_assign_in_exiting_branch_new_fact",
                "h1_by_ref_param_survives_calls",
                "h2_call_in_exiting_branch_member_path",
                "h2_limitation_call_with_container_operand",
                "h3_call_in_condition_before_fact",
                "h3_limitation_call_writes_global",
                "h3b_unknown_call_in_condition_before_fact",
                "h4_call_in_then_branch_member_path",
                "h4_same_variable_two_ref_arguments",
                "h5_generic_by_ref_parameters_may_overlap",
                "h5_strengthening_gain",
                "h6_call_in_condition_kills_entry_member_path",
                "h6_null_assertion_repeats_ref_argument",
                "h7_conditional_address_repeats_ref_argument",
                "h7_getter_in_exiting_branch_kills_member_path",
                "h8_nested_annotation_by_ref_parameters_overlap",
                "h9_nested_type_parameter_by_ref_parameters_overlap",
                "i1_5206_type_test_against_unrelated_interface",
                "i2_5206_goto_join_keeps_declared_type",
                "j1_else_if_chain_nary_join",
                "k1_legacy_lift_keeps_the_stronger_join",
                "k2_header_write_before_branch_read",
                "l1_condition_call_kills_alias_fact",
                "l2_condition_call_kills_member_path_on_alias",
                "m1_unrelated_interface_refinement",
                "n1_boxed_value_type_test",
                "o1_callback_after_test_replaces_root",
                "o2_callback_in_or_arm_replaces_root",
                "o3_callback_in_else_if_replaces_root",
                "o4_stored_callback_run_by_named_function",
                "o5_callback_literal_passed_to_named_function",
                "o6_callback_run_through_another_callback",
                "o7_root_never_assigned_by_a_closure_keeps_the_fact",
                "out-alias_out_ref_alias",
                "p10_5237_clr_constructor_enumerates_an_escaped_closure",
                "p11_5237_type_parameter_construction_runs_a_constructor",
                "p12_5237_function_pointer_call_runs_an_escaped_closure",
                "p13_5237_interpolation_calls_to_string",
                "p14_5237_condition_out_write_then_escaped_closure",
                "p15_5237_condition_out_write_then_test_keeps_the_fact",
                "p16_5237_condition_call_reads_the_root_after_the_test",
                "p17_5237_assignment_after_the_call_keeps_its_own_fact",
                "p1_5237_escaped_closure_run_by_declared_function",
                "p2_5237_loop_form_escaped_closure",
                "p3_5237_root_no_closure_assigns_keeps_the_fact",
                "p4_5237_base_class_call",
                "p5_5237_imported_call_runs_registered_callback",
                "p6_5237_ref_local_alias_of_closure_assigned_local",
                "p7_5237_iterator_runs_escaped_closure",
                "p8_5237_call_replaces_a_closure_assigned_callable",
                "p9_5237_explicit_invoke_of_an_external_callback_keeps_the_fact",
                "q1_5456_closure_own_local_survives_unknown_callable",
                "q2_5456_nested_closure_assigns_enclosing_closure_local",
                "q3_5456_closure_own_local_in_nested_block_survives_unknown_callable",
                "q4_5456_initializer_write_names_the_enclosing_variable",
                "q5_5456_do_condition_is_outside_the_body_declaration",
                "r10_5483_static_block_declared_after_the_use",
                "r1_5482_ref_alias_of_closure_replaced_callable",
                "r1_5483_static_block_only_construction",
                "r2_5482_condition_call_replaces_the_aliased_callable",
                "r2_5483_static_block_call_syntax",
                "r3_5482_two_level_ref_alias_chain",
                "r3_5483_static_block_in_base_class",
                "r4_5482_ref_alias_without_a_call_keeps_the_fact",
                "r4_5483_static_block_of_generic_definition",
                "r5_5482_filter_runs_a_closure_that_replaces_the_aliased_callable",
                "r5_5483_static_block_of_value_type_literal_is_initobj",
                "r6_5482_plain_alias_keeps_the_fact_across_a_call",
                "r6_5483_static_block_runs_a_mutable_global_writer",
                "r7_5482_condition_call_replaces_the_aliased_callable_inside_the_body",
                "r7_5483_shared_field_initializer_only_keeps_the_fact",
                "r8_5483_type_without_initializers_keeps_the_fact",
                "r9_5483_static_block_type_not_constructed_keeps_the_fact",
                "s01_5504_issue_field_read_R11",
                "s01_5504_issue_field_read_R15",
                "s02_5504_field_write_R11",
                "s02_5504_field_write_R15",
                "s03_5504_field_increment_R15",
                "s04_5504_auto_property_read_R11",
                "s04_5504_auto_property_read_R15",
                "s05_5504_auto_property_write_R15",
                "s06_5504_static_method_call_R15",
                "s07_5504_const_read_R15",
                "s08_5504_derived_reads_base_field_R11",
                "s08_5504_derived_reads_base_field_R15",
                "s09_5504_derived_own_field_base_has_block_R11",
                "s09_5504_derived_own_field_base_has_block_R15",
                "s10_5504_generic_field_read_R15",
                "s11_5504_field_initializer_only_literal_R11",
                "s11_5504_field_initializer_only_literal_R15",
                "s12_5504_field_initializer_only_call_R11",
                "s12_5504_field_initializer_only_call_R15",
                "s13_5504_struct_field_read_R11",
                "s13_5504_struct_field_read_R15",
                "s14_5504_nested_inner_has_block_R11",
                "s14_5504_nested_inner_has_block_R15",
                "s15_5504_nested_outer_has_block_only_R15",
                "s16_5504_enum_member_R15",
                "s17_5504_no_block_anywhere_R15",
                "s18_5504_unrelated_type_with_block_R15",
                "s19_5504_field_read_inside_condition_R15",
                "s20_5504_field_read_in_loop_R15",
                "s21_5504_static_event_subscription_R11",
                "s21_5504_static_event_subscription_R15",
                "s22_5504_derived_reads_base_property_R11",
                "s22_5504_derived_reads_base_property_R15",
                "s23_5504_derived_writes_base_field_R15",
                "s24_5504_derived_subscribes_base_event_R11",
                "s24_5504_derived_subscribes_base_event_R15",
                "s25_5504_derived_hides_base_field_R11",
                "s25_5504_derived_hides_base_field_R15",
                "s26_5504_generic_derived_reads_generic_base_field_R11",
                "s26_5504_generic_derived_reads_generic_base_field_R15",
                "s27_5504_field_initializer_only_call_constructed_R11",
                "s27_5504_field_initializer_only_call_constructed_R15",
                "t01_5231_lazy_value_kills_a_by_reference_parameter_R16",
                "t02_5231_lazy_value_kills_a_member_path_R16",
                "t03_5231_string_length_keeps_a_member_path_R16",
                "t04_5231_list_count_keeps_a_by_reference_parameter_R16",
                "t05_5231_string_builder_length_keeps_a_closure_assigned_local_R16",
                "t06_5231_lazy_value_runs_an_escaped_closure_R16",
                "t07_5231_lazy_value_in_a_condition_R16",
                "t08_5231_lazy_value_in_a_loop_R16",
                "t09_5231_string_length_in_a_loop_R16",
                "t10_5231_interface_count_kills_R16",
                "t11_5231_static_getter_kills_R16"
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
func Main() { Console.WriteLine(Run()) }`, "GS0158@14:18", "reject", "", ""}
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
func Main() { Console.WriteLine(Run()) }`, "GS0158@15:33", "reject", "", ""}
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
func Main() { Console.WriteLine(Run()) }`, "GS0158@14:23", "reject", "", ""}
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
func Main() { Console.WriteLine(Run()) }`, "GS0158@9:14", "reject", "", ""}
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
func Main() { Console.WriteLine(Run(2)) }`, "GS0158@10:27", "reject", "", ""}
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
func Main() { Console.WriteLine(Run()) }`, "GS0158@9:14", "reject", "", ""}
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
func Main() { Console.WriteLine(Run()) }`, "GS0158@17:22", "reject", "", ""}
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
}`, "GS0158@7:14", "reject", "", ""}
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
            yield[]object{"h1_by_ref_param_survives_calls", `import System.Collections.Generic
class P { var Value int32 = 1 }
func Touch(p P) int32 { return p.Value }
func Find(frames List[Dictionary[P, string]], c P?, out path P?, out found string?) bool {
    path = c
    if path == nil {
        found = nil
        return false
    }
    for var i = 0; i < frames.Count; i++ {
        if frames[i].TryGetValue(path, out found) {
            return Touch(path) + path.Value == 2
        }
    }
    found = nil
    return false
}
func Main() {
    let c = P{}
    let frames = List[Dictionary[P, string]]()
    frames.Add(Dictionary[P, string]{[c] = "x"})
    var p P? = nil
    var t string? = nil
    Console.WriteLine(Find(frames, c, out p, out t))
}`, "", "run", "True", "R12 amendment A3 (#5292)"}
            yield[]object{"h2_limitation_call_with_container_operand", `class C {
    var Value int32 = 1
}
func Clear(xs []C?) { xs[0] = nil }
func Run(ref a C?, xs []C?) int32 {
    if a == nil { return 0 }
    Clear(xs)
    return a.Value
}
func Main() {
    var xs = []C?{C{}}
    Console.WriteLine(Run(ref xs[0], xs))
}`, "", "nre", "", "R12 amendment A3 (#5292): documented limitation, see the follow-up issue"}
            yield[]object{"h3_limitation_call_writes_global", `class C {
    var Value int32 = 1
}
var g C? = C{}
func Clear() { g = nil }
func Run(ref a C?) int32 {
    if a == nil { return 0 }
    Clear()
    return a.Value
}
Console.WriteLine(Run(ref g))`, "GS0286@11:1", "nre", "", "R12 amendment A3 (#5292): documented limitation, see the follow-up issue"}
            yield[]object{"h4_same_variable_two_ref_arguments", `class C {
    var Value int32 = 1
}
func Clear2(ref x C?, ref y C?) { x = nil }
func Run(ref a C?, ref b C?) int32 {
    if a == nil { return 0 }
    Clear2(ref b, ref b)
    return a.Value
}
func Main() {
    var v C? = C{}
    Console.WriteLine(Run(ref v, ref v))
}`, "GS0158@8:14", "reject", "", ""}
            yield[]object{"h5_generic_by_ref_parameters_may_overlap", `class C {
}
class Box[T] {
    var Item int32 = 1
}
func Run[T](ref a Box[T]?, ref b Box[C]?) int32 {
    if a == nil { return 0 }
    b = nil
    return a.Item
}
func Main() {
    var x Box[C]? = Box[C]()
    Console.WriteLine(Run[C](ref x, ref x))
}`, "GS0158@9:14", "reject", "", ""}
            yield[]object{"h6_null_assertion_repeats_ref_argument", `class C {
    var Value int32 = 1
}
func Clear(ref x C?, y C) { x = nil }
func Run(ref a C?, ref b C?) int32 {
    if a == nil { return 0 }
    Clear(ref b, b!!)
    return a.Value
}
func Main() {
    var v C? = C{}
    Console.WriteLine(Run(ref v, ref v))
}`, "GS0158@8:14", "reject", "", ""}
            yield[]object{"h7_conditional_address_repeats_ref_argument", `class C {
    var Value int32 = 1
}
func Clear2(ref x C?, ref y C?) { x = nil }
func Run(ref a C?, ref b C?, flag bool) int32 {
    if a == nil { return 0 }
    Clear2(ref flag ? b : b, ref b)
    return a.Value
}
func Main() {
    var v C? = C{}
    Console.WriteLine(Run(ref v, ref v, true))
}`, "GS0158@8:14", "reject", "", ""}
            yield[]object{"h8_nested_annotation_by_ref_parameters_overlap", `class C {
}
class Box[T] {
    var Item int32 = 1
}
func Run(ref a Box[C]?, ref b Box[C?]?) int32 {
    if a == nil { return 0 }
    b = nil
    return a.Item
}
func Main() {
    var x Box[C]? = Box[C]()
    Console.WriteLine(Run(ref x, ref x))
}`, "GS0158@9:14 GS0612@13:34", "reject", "", ""}
            yield[]object{"h9_nested_type_parameter_by_ref_parameters_overlap", `class C {
}
class Box[T] {
    var Item int32 = 1
}
func Run[T](ref a Box[(T, int32)]?, ref b Box[(C, int32)]?) int32 {
    if a == nil { return 0 }
    b = nil
    return a.Item
}
func Main() {
    var x Box[(C, int32)]? = Box[(C, int32)]()
    Console.WriteLine(Run[C](ref x, ref x))
}`, "GS0158@9:14", "reject", "", ""}
            yield[]object{"h10_tuple_by_ref_parameter_overlaps_element", `class C {
    var Value int32 = 1
}
func Run(ref a C?, ref whole (C?, int32)) int32 {
    if a == nil { return 0 }
    whole = (nil, 0)
    return a.Value
}
func Main() {
    var element C? = C{}
    var t (C?, int32) = (C{}, 1)
    Console.WriteLine(Run(ref element, ref t))
}`, "GS0158@7:14", "reject", "", ""}
            yield[]object{"h11_enclosing_type_argument_by_ref_parameters_overlap", `class Outer[T] {
    class Inner {
        var Item int32 = 1
    }
}
func Run(ref a Outer[string].Inner?, ref b Outer[string?].Inner?) int32 {
    if a == nil { return 0 }
    b = nil
    return a.Item
}
func Main() {
    var x Outer[string].Inner? = Outer[string].Inner()
    Console.WriteLine(Run(ref x, ref x))
}`, "GS0158@9:14 GS0612@13:34", "reject", "", ""}
            yield[]object{"h12_conditional_out_argument_of_imported_call", `import System.Collections.Generic
class C {
    var Value int32 = 1
}
func Run(ref a C?, flag bool) int32 {
    if a == nil { return 0 }
    let d = Dictionary[string, C?]()
    d.TryGetValue("missing", out flag ? a : a)
    return a.Value
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x, true))
}`, "GS0158@9:14", "reject", "", ""}
            yield[]object{"h13_indexer_setter_clears_aliased_member", `class C {
    var Value int32 = 1
}
class Box {
    var Field C? = C{}
    prop this[i int32] int32 {
        get -> 0
        set { Field = nil }
    }
}
func Run(ref a C?, box Box) int32 {
    if a == nil { return 0 }
    box[0] = 1
    return a.Value
}
func Main() {
    let box = Box()
    Console.WriteLine(Run(ref box.Field, box))
}`, "GS0158@14:14", "reject", "", ""}
            yield[]object{"h14_null_conditional_receiver_repeats_ref_argument", `class C {
    var Value int32 = 1
    func Clear(ref target C?) { target = nil }
}
func Run(ref a C?, ref b C?) int32 {
    if a == nil { return 0 }
    b?.Clear(ref b)
    return a.Value
}
func Main() {
    var v C? = C{}
    Console.WriteLine(Run(ref v, ref v))
}`, "GS0158@8:14", "reject", "", ""}
            yield[]object{"h15_ref_local_alias_repeats_ref_argument", `class C {
    var Value int32 = 1
}
func Clear2(ref x C?, ref y C?) { x = nil }
func Run(ref a C?, ref b C?) int32 {
    if a == nil { return 0 }
    let ref c C? = b
    Clear2(ref b, ref c)
    return a.Value
}
func Main() {
    var v C? = C{}
    Console.WriteLine(Run(ref v, ref v))
}`, "GS0158@9:14", "reject", "", ""}
            yield[]object{"h16_ref_local_alias_passed_twice", `class C {
    var Value int32 = 1
}
func Clear2(ref x C?, ref y C?) { x = nil }
func Run(ref a C?, ref b C?) int32 {
    if a == nil { return 0 }
    let ref c C? = b
    Clear2(ref c, ref c)
    return a.Value
}
func Main() {
    var v C? = C{}
    Console.WriteLine(Run(ref v, ref v))
}`, "GS0158@9:14", "reject", "", ""}
            yield[]object{"h17_conditional_ref_argument_of_imported_call", `import System.Threading
class C {
    var Value int32 = 1
}
func Run(ref a C?, flag bool) int32 {
    if a == nil { return 0 }
    Interlocked.Exchange[C?](ref flag ? a : a, nil)
    return a.Value
}
func Main() {
    var x C? = C{}
    Console.WriteLine(Run(ref x, true))
}`, "GS0158@8:14", "reject", "", ""}
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
            yield[]object{"h6_call_in_condition_kills_entry_member_path", `open class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func Ready() bool { return true }
func Run(b Box) string {
    if b.Pet == nil { return "" }
    if Ready() {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run(Box(Animal()))) }`, "GS0158@13:18", "reject", "", "R14 (the condition call kills; stays rejected)"}
            yield[]object{"k1_legacy_lift_keeps_the_stronger_join", `open class Animal { var Name string = "a" }
class Dog : Animal { func Bark() string { return "woof" } }
func Run(a Animal, c bool) string {
    var x Animal? = a
    if c {
        if x !is Dog { return "" }
    } else {
        if x !is Dog { return "" }
    }
    return x.Bark()
}
func Main() { Console.WriteLine(Run(Dog(), true)) }`, "", "run", "woof", ""}
            yield[]object{"k2_header_write_before_branch_read", `func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    if Clear(ref s) {
        return s.Length
    }
    return 0
}
func Main() { Console.WriteLine(Run()) }`, "GS0612@9:14", "nre", "", "#5249, header effects before the branches (slice 4): GS0158 after"}
            yield[]object{"h7_getter_in_exiting_branch_kills_member_path", `open class Animal { var Name string = "a" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    prop Count int32 -> 1
    init(p Animal?) { Pet = p }
}
func Run(b Box) string {
    if b.Pet is Dog {
    } else {
        let n = b.Count
        return ""
    }
    return b.Pet.Bark()
}
func Main() { Console.WriteLine(Run(Box(Dog()))) }`, "GS0159@14:18", "reject", "", "R2 (accepted after)"}
            yield[]object{"l1_condition_call_kills_alias_fact", `class C {
    var Value int32 = 1
}
func Clear(xs []C?) bool {
    xs[0] = nil
    return true
}
func Run(ref a C?, xs []C?) int32 {
    if a != nil && Clear(xs) {
    } else {
        return 0
    }
    return a.Value
}
func Main() {
    var xs = []C?{C{}}
    Console.WriteLine(Run(ref xs[0], xs))
}`, "GS0158@13:14", "reject", "", ""}
            yield[]object{"m1_unrelated_interface_refinement", `interface IA {
    func Id() string;
}
interface IB {
    func Extra() string;
}
class Both : IA, IB {
    func Id() string { return "id" }
    func Extra() string { return "extra" }
}
func Run(x IA?) string {
    if x == nil { return "" }
    if x is IB {
    } else {
        return ""
    }
    return x.Extra()
}
func Main() { Console.WriteLine(Run(Both())) }`, "", "run", "extra", ""}
            yield[]object{"h3b_unknown_call_in_condition_before_fact", `open class Animal { var Name string = "a" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func Run(b Box) string {
    let ready = func() bool { return true }
    if ready() && b.Pet is Dog {
    } else {
        return ""
    }
    return b.Pet.Bark()
}
func Main() { Console.WriteLine(Run(Box(Dog()))) }`, "", "run", "woof", ""}
            yield[]object{"l2_condition_call_kills_member_path_on_alias", `class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Clear(xs []Box) bool {
    xs[0] = Box(nil)
    return true
}
func Run(ref b Box, xs []Box) string {
    if b.Pet != nil && Clear(xs) {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() {
    var xs = []Box{Box(Pet())}
    Console.WriteLine(Run(ref xs[0], xs))
}`, "GS0158@15:18", "reject", "", ""}
            yield[]object{"n1_boxed_value_type_test", `func Run(x object?) int32 {
    if x == nil { return 0 }
    if x is int32 {
    } else {
        return 0
    }
    return x
}
func Main() { Console.WriteLine(Run(5)) }`, "", "run", "5", ""}
            yield[]object{"o1_callback_after_test_replaces_root", `class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Run() string {
    var b = Box(Pet())
    let clear = func() bool {
        b = Box(nil)
        return true
    }
    if b.Pet != nil && clear() {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@16:18", "reject", "", ""}
            yield[]object{"o2_callback_in_or_arm_replaces_root", `class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Run() string {
    var b = Box(Pet())
    let clear = func() bool {
        b = Box(nil)
        return false
    }
    if b.Pet == nil || clear() {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@15:18", "reject", "", ""}
            yield[]object{"o3_callback_in_else_if_replaces_root", `class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Run(c bool) string {
    var b = Box(Pet())
    let clear = func() bool {
        b = Box(nil)
        return true
    }
    if c {
        return ""
    } else if b.Pet != nil && clear() {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run(false)) }`, "GS0158@18:18", "reject", "", ""}
            yield[]object{"o4_stored_callback_run_by_named_function", `import System.Collections.Generic
class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Fire(hs List[() -> bool]) bool {
    for h in hs { h() }
    return true
}
func Run() string {
    var b = Box(Pet())
    let handlers = List[() -> bool]()
    handlers.Add(func() bool {
        b = Box(nil)
        return true
    })
    if b.Pet != nil && Fire(handlers) {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@22:18", "reject", "", ""}
            yield[]object{"o5_callback_literal_passed_to_named_function", `class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Use(f () -> bool) bool { return f() }
func Run() string {
    var b = Box(Pet())
    if b.Pet != nil && Use(func() bool {
        b = Box(nil)
        return true
    }) {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@16:18", "reject", "", ""}
            yield[]object{"o6_callback_run_through_another_callback", `class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Run() string {
    var b = Box(Pet())
    let clear = func() bool {
        b = Box(nil)
        return true
    }
    let again = func() bool { return clear() }
    if b.Pet != nil && again() {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@17:18", "reject", "", ""}
            yield[]object{"o7_root_never_assigned_by_a_closure_keeps_the_fact", `import System.Collections.Generic
class Pet { var Name string = "a" }
class Box {
    let Pet Pet?
    init(p Pet?) { Pet = p }
}
func Fire(hs List[() -> bool]) bool {
    for h in hs { h() }
    return true
}
func Run() string {
    var b = Box(Pet())
    let handlers = List[() -> bool]()
    handlers.Add(func() bool { return true })
    if b.Pet != nil && Fire(handlers) {
    } else {
        return ""
    }
    return b.Pet.Name
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "a", ""}
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
            yield[]object{"q1_5456_closure_own_local_survives_unknown_callable", `import System

class Rec {
    var Id string = "a"
}
func Find() Rec? { return Rec{} }
func Pick() () -> void { return func() { } }
func Run(c () -> void) { c() }
func Main() {
    Run(() -> {
        var hit Rec? = nil
        hit = Find()
        if hit == nil { return }
        let f = Pick()
        f()
        Console.WriteLine(hit.Id)
    })
}`, "", "run", "a", ""}
            yield[]object{"q2_5456_nested_closure_assigns_enclosing_closure_local", `import System

class Rec {
    var Id string = "a"
}
func Find() Rec? { return Rec{} }
func Pick(g () -> void) () -> void { return g }
func Run(c () -> void) { c() }
func Main() {
    Run(() -> {
        var hit Rec? = nil
        hit = Find()
        let clear = func() { hit = nil }
        if hit == nil { return }
        let f = Pick(clear)
        f()
        Console.WriteLine(hit.Id)
    })
}`, "GS0158@17:31", "reject", "", ""}
            yield[]object{"q3_5456_closure_own_local_in_nested_block_survives_unknown_callable", `import System

class Rec {
    var Id string = "a"
}
func Find() Rec? { return Rec{} }
func Pick() () -> void { return func() { } }
func Run(c () -> void) { c() }
func Main() {
    Run(() -> {
        for var i = 0; i < 1; i++ {
            var hit Rec? = nil
            hit = Find()
            if hit == nil { return }
            let f = Pick()
            f()
            Console.WriteLine(hit.Id)
        }
    })
}`, "", "run", "a", ""}
            yield[]object{"q4_5456_initializer_write_names_the_enclosing_variable", `import System

class Rec {
    var Id string = "a"
}
func Find() Rec? { return Rec{} }
func Pick(g () -> void) () -> void { return g }
func Main() {
    var hit Rec? = Find()
    let clear = func() {
        var hit Rec? = (hit = nil)
    }
    if hit == nil { return }
    let f = Pick(clear)
    f()
    Console.WriteLine(hit.Id)
}`, "GS0158@16:27", "reject", "", ""}
            yield[]object{"q5_5456_do_condition_is_outside_the_body_declaration", `import System

class Rec {
    var Id string = "a"
}
func Find() Rec? { return Rec{} }
func Pick(g () -> void) () -> void { return g }
func Main() {
    var hit Rec? = Find()
    let clear = func() {
        do var hit Rec? = nil while (hit = nil) != nil
    }
    if hit == nil { return }
    let f = Pick(clear)
    f()
    Console.WriteLine(hit.Id)
}`, "GS0158@16:27", "reject", "", ""}
            yield[]object{"p1_5237_escaped_closure_run_by_declared_function", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    Wrapper(h)
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@18:14", "reject", "", "R15"}
            yield[]object{"p2_5237_loop_form_escaped_closure", `import System
class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) { h.Callback() }
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < 2; i++ {
        Console.WriteLine(x.Value)
        total++
        Wrapper(h)
    }
    return total
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@16:29", "reject", "", "R15"}
            yield[]object{"p3_5237_root_no_closure_assigns_keeps_the_fact", `import System
class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Run() int32 {
    var x C? = C{}
    var y C? = C{}
    let h = Holder{}
    h.Callback = func() { y = nil }
    if x == nil { return 0 }
    Wrapper(h)
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "1", "R15"}
            yield[]object{"p4_5237_base_class_call", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
open class Base {
    func Wrapper(h Holder) {
        h.Callback()
    }
}
class Derived : Base {
    func Run() int32 {
        var x C? = C{}
        let h = Holder{}
        h.Callback = func() { x = nil }
        if x == nil { return 0 }
        base.Wrapper(h)
        return x.Value
    }
}
func Main() { Console.WriteLine(Derived().Run()) }`, "GS0158@21:18", "reject", "", "R15"}
            yield[]object{"p5_5237_imported_call_runs_registered_callback", `import System
import System.Threading

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    let cts = CancellationTokenSource()
    cts.Token.Register(func() { x = nil })
    if x == nil { return 0 }
    cts.Cancel()
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@13:14", "reject", "", "R15"}
            yield[]object{"p6_5237_ref_local_alias_of_closure_assigned_local", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    let ref a C? = x
    if a == nil { return 0 }
    Wrapper(h)
    return a.Value
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@19:14", "reject", "", "R15"}
            yield[]object{"p7_5237_iterator_runs_escaped_closure", `import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
func Items(h () -> void) sequence[int32] {
    yield 1
    h()
    yield 2
}
func Run() int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    let items = Items(clear)
    if x == nil { return 0 }
    var total = 0
    for v in items {
        total += v
    }
    return x.Value + total
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@21:14", "reject", "", "R15"}
            yield[]object{"p8_5237_call_replaces_a_closure_assigned_callable", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    Wrapper(h)
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"p9_5237_explicit_invoke_of_an_external_callback_keeps_the_fact", `import System

class C {
    var Value int32 = 1
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil { return 0 }
    callback.Invoke()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "", "run", "1", "R15"}
            yield[]object{"p10_5237_clr_constructor_enumerates_an_escaped_closure", `import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
func Items(h () -> void) sequence[int32] {
    yield 1
    h()
    yield 2
}
func Run() int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    let items = Items(clear)
    if x == nil { return 0 }
    let list = List[int32](items)
    return x.Value + list.Count
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@18:14", "reject", "", "R15"}
            yield[]object{"p11_5237_type_parameter_construction_runs_a_constructor", `import System

class C {
    var Value int32 = 1
}
class Maker {
    init() {
        cleaner()
    }
}
func Run[T class init()]() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let fresh = T{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run[Maker]())`, "GS0158@16:14", "reject", "", "R15"}
            yield[]object{"p12_5237_function_pointer_call_runs_an_escaped_closure", `import System

class C {
    var Value int32 = 1
}
func Wrapper() {
    cleaner()
}
unsafe func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let fp *func() = &Wrapper
    fp()
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@15:14", "reject", "", "R15"}
            yield[]object{"p13_5237_interpolation_calls_to_string", `import System

class C {
    var Value int32 = 1
}
class Noisy {
    override func ToString() string {
        cleaner()
        return "n"
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    let n = Noisy{}
    if x == nil { return 0 }
    let text = "${n}"
    return x.Value + text.Length
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@18:14", "reject", "", "R15"}
            yield[]object{"p14_5237_condition_out_write_then_escaped_closure", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) bool {
    h.Callback()
    return false
}
func TryGet(out x C?) bool {
    x = C{}
    return true
}
func Run() int32 {
    var x C? = nil
    let h = Holder{}
    h.Callback = func() { x = nil }
    if !TryGet(out x) || x == nil || Wrapper(h) { return 0 }
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@22:14", "reject", "", "R15"}
            yield[]object{"p15_5237_condition_out_write_then_test_keeps_the_fact", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) bool {
    h.Callback()
    return false
}
func TryGet(out x C?) bool {
    x = C{}
    return true
}
func Run() int32 {
    var x C? = nil
    let h = Holder{}
    h.Callback = func() { x = nil }
    if !TryGet(out x) || x == nil { return 0 }
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "1", "R15"}
            yield[]object{"p16_5237_condition_call_reads_the_root_after_the_test", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder, c C?) bool {
    h.Callback()
    return false
}
func TryGet(out x C?) bool {
    x = C{}
    return true
}
func Run() int32 {
    var x C? = nil
    let h = Holder{}
    h.Callback = func() { x = nil }
    if !TryGet(out x) || x == nil || Wrapper(h, x) { return 0 }
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@22:14", "reject", "", "R15"}
            yield[]object{"p17_5237_assignment_after_the_call_keeps_its_own_fact", `import System

func Make() string { return "abc" }
func Run() int32 {
    var x string? = nil
    let clear = func() { x = nil }
    try {
    } finally {
        x = Make()
    }
    return x.Length
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "3", "R15"}
            yield[]object{"r1_5483_static_block_only_construction", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        init { cleaner() }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@16:14", "reject", "", "R15"}
            yield[]object{"r2_5483_static_block_call_syntax", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        init { cleaner() }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger()
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@16:14", "reject", "", "R15"}
            yield[]object{"r3_5483_static_block_in_base_class", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        init { cleaner() }
    }
}
class Trigger : Base {
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@18:14", "reject", "", "R15"}
            yield[]object{"r4_5483_static_block_of_generic_definition", `import System

class C {
    var Value int32 = 1
}
class Trigger[T] {
    shared {
        init { cleaner() }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger[int32]{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@16:14", "reject", "", "R15"}
            yield[]object{"r5_5483_static_block_of_value_type_literal_is_initobj", `import System

class C {
    var Value int32 = 1
}
struct Trigger {
    shared {
        init { cleaner() }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"r6_5483_static_block_runs_a_mutable_global_writer", `import System

var text string? = nil
class Trigger {
    shared {
        init { text = nil }
    }
}
func Run() int32 {
    text = "safe"
    let t = Trigger{}
    return text.Length
}
Console.WriteLine(Run())`, "GS0158@12:17 GS0286@14:1", "reject", "", "R11"}
            yield[]object{"r7_5483_shared_field_initializer_only_keeps_the_fact", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 5
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"r8_5483_type_without_initializers_keeps_the_fact", `import System

class C {
    var Value int32 = 1
}
class Trigger {
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"r9_5483_static_block_type_not_constructed_keeps_the_fact", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        init { cleaner() }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t Trigger? = nil
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"r10_5483_static_block_declared_after_the_use", `import System

class C {
    var Value int32 = 1
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger{}
    return x.Value
}
class Trigger {
    shared {
        init { cleaner() }
    }
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@11:14", "reject", "", "R15"}
            yield[]object{"s01_5504_issue_field_read_R11", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Trigger.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@18:14", "reject", "", "R11"}
            yield[]object{"s01_5504_issue_field_read_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s02_5504_field_write_R11", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    if g == nil { return 0 }
    Trigger.Count = 2
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@18:14", "reject", "", "R11"}
            yield[]object{"s02_5504_field_write_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    Trigger.Count = 2
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s03_5504_field_increment_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    Trigger.Count++
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s04_5504_auto_property_read_R11", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Trigger.Auto
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@18:14", "reject", "", "R11"}
            yield[]object{"s04_5504_auto_property_read_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger.Auto
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s05_5504_auto_property_write_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    Trigger.Auto = 2
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s06_5504_static_method_call_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger.M()
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s07_5504_const_read_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger.Max
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s08_5504_derived_reads_base_field_R11", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
class Derived : Base { }
func Run() int32 {
    if g == nil { return 0 }
    let n = Derived.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@19:14", "reject", "", "R11"}
            yield[]object{"s08_5504_derived_reads_base_field_R15", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
class Derived : Base { }
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Derived.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@21:14", "reject", "", "R15"}
            yield[]object{"s09_5504_derived_own_field_base_has_block_R11", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        init { cleaner() }
    }
}
class Derived : Base {
    shared {
        var Own int32 = 0
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Derived.Own
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "", "run", "1", "R11"}
            yield[]object{"s09_5504_derived_own_field_base_has_block_R15", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        init { cleaner() }
    }
}
class Derived : Base {
    shared {
        var Own int32 = 0
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Derived.Own
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s10_5504_generic_field_read_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger[T] {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger[int32].Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s11_5504_field_initializer_only_literal_R11", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 5
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Trigger.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "", "run", "1", "R11"}
            yield[]object{"s11_5504_field_initializer_only_literal_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 5
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s12_5504_field_initializer_only_call_R11", `import System

class C {
    var Value int32 = 1
}
func Touch() int32 {
    cleaner()
    return 5
}
class Trigger {
    shared {
        var Count int32 = Touch()
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Trigger.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "", "nre", "", "known limitation: a beforefieldinit field initializer is not classified, see #5520"}
            yield[]object{"s12_5504_field_initializer_only_call_R15", `import System

class C {
    var Value int32 = 1
}
func Touch() int32 {
    cleaner()
    return 5
}
class Trigger {
    shared {
        var Count int32 = Touch()
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "nre", "", "known limitation: a beforefieldinit field initializer is not classified, see #5520"}
            yield[]object{"s13_5504_struct_field_read_R11", `import System

class C {
    var Value int32 = 1
}
struct Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Trigger.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@18:14", "reject", "", "R11"}
            yield[]object{"s13_5504_struct_field_read_R15", `import System

class C {
    var Value int32 = 1
}
struct Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Trigger.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s14_5504_nested_inner_has_block_R11", `import System

class C {
    var Value int32 = 1
}
class Outer {
    class Inner {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Outer.Inner.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R11"}
            yield[]object{"s14_5504_nested_inner_has_block_R15", `import System

class C {
    var Value int32 = 1
}
class Outer {
    class Inner {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Outer.Inner.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@22:14", "reject", "", "R15"}
            yield[]object{"s15_5504_nested_outer_has_block_only_R15", `import System

class C {
    var Value int32 = 1
}
class Outer {
    shared {
        init { cleaner() }
    }
    class Inner {
        shared {
            var Count int32 = 0
        }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Outer.Inner.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s16_5504_enum_member_R15", `import System

class C {
    var Value int32 = 1
}
enum Color { Red, Green }
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Color.Green
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s17_5504_no_block_anywhere_R15", `import System

class C {
    var Value int32 = 1
}
class Plain {
    shared {
        var Count int32 = 0
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Plain.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s18_5504_unrelated_type_with_block_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = 1
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s19_5504_field_read_inside_condition_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    if Trigger.Count == 7 { }
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@20:14", "reject", "", "R15"}
            yield[]object{"s20_5504_field_read_in_loop_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    for var i = 0; i < 2; i++ {
        let n = Trigger.Count
    }
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@22:14", "reject", "", "R15"}
            yield[]object{"s21_5504_static_event_subscription_R11", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        event Changed () -> void
        init { cleaner() }
    }
}
func Run() int32 {
    if g == nil { return 0 }
    Trigger.Changed += func() { }
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@15:14", "reject", "", "R11"}
            yield[]object{"s21_5504_static_event_subscription_R15", `import System

class C {
    var Value int32 = 1
}
class Trigger {
    shared {
        event Changed () -> void
        init { cleaner() }
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    Trigger.Changed += func() { }
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@17:14", "reject", "", "R15"}
            yield[]object{"s22_5504_derived_reads_base_property_R11", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
class Derived : Base { }
func Run() int32 {
    if g == nil { return 0 }
    let n = Derived.Auto
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@19:14", "reject", "", "R11"}
            yield[]object{"s22_5504_derived_reads_base_property_R15", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
class Derived : Base { }
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Derived.Auto
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@21:14", "reject", "", "R15"}
            yield[]object{"s23_5504_derived_writes_base_field_R15", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
class Derived : Base { }
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    Derived.Count = 3
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@21:14", "reject", "", "R15"}
            yield[]object{"s24_5504_derived_subscribes_base_event_R11", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        event Changed () -> void
        init { cleaner() }
    }
}
class Derived : Base { }
func Run() int32 {
    if g == nil { return 0 }
    Derived.Changed += func() { }
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@16:14", "reject", "", "R11"}
            yield[]object{"s24_5504_derived_subscribes_base_event_R15", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        event Changed () -> void
        init { cleaner() }
    }
}
class Derived : Base { }
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    Derived.Changed += func() { }
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@18:14", "reject", "", "R15"}
            yield[]object{"s25_5504_derived_hides_base_field_R11", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        var Count int32 = 0
        init { cleaner() }
    }
}
class Derived : Base {
    shared {
        var Count int32 = 1
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let n = Derived.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "", "run", "1", "R11"}
            yield[]object{"s25_5504_derived_hides_base_field_R15", `import System

class C {
    var Value int32 = 1
}
open class Base {
    shared {
        var Count int32 = 0
        init { cleaner() }
    }
}
class Derived : Base {
    shared {
        var Count int32 = 1
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Derived.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"s26_5504_generic_derived_reads_generic_base_field_R11", `import System

class C {
    var Value int32 = 1
}
open class Base[T] {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
class Derived : Base[int32] { }
func Run() int32 {
    if g == nil { return 0 }
    let n = Derived.Count
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "GS0158@19:14", "reject", "", "R11"}
            yield[]object{"s26_5504_generic_derived_reads_generic_base_field_R15", `import System

class C {
    var Value int32 = 1
}
open class Base[T] {
    shared {
        var Count int32 = 0
        const Max int32 = 3
        prop Auto int32 { get; set }
        init { cleaner() }
        func M() int32 -> 1
    }
}
class Derived : Base[int32] { }
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let n = Derived.Count
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "GS0158@21:14", "reject", "", "R15"}
            yield[]object{"s27_5504_field_initializer_only_call_constructed_R11", `import System

class C {
    var Value int32 = 1
}
func Touch() int32 {
    cleaner()
    return 5
}
class Trigger {
    shared {
        var Count int32 = Touch()
    }
}
func Run() int32 {
    if g == nil { return 0 }
    let t = Trigger{}
    return g.Value
}
var g C? = C{}
var cleaner () -> void = func() { g = nil }
Console.WriteLine(Run())`, "", "run", "1", "R11"}
            yield[]object{"s27_5504_field_initializer_only_call_constructed_R15", `import System

class C {
    var Value int32 = 1
}
func Touch() int32 {
    cleaner()
    return 5
}
class Trigger {
    shared {
        var Count int32 = Touch()
    }
}
func Run() int32 {
    var x C? = C{}
    cleaner = func() { x = nil }
    if x == nil { return 0 }
    let t = Trigger{}
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run())`, "", "run", "1", "R15"}
            yield[]object{"r1_5482_ref_alias_of_closure_replaced_callable", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let ref alias = action
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    alias = callback
    Wrapper(h)
    if x == nil { return 0 }
    alias()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@26:14", "reject", "", "R15"}
            yield[]object{"r2_5482_condition_call_replaces_the_aliased_callable", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let ref alias = action
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    alias = callback
    if Check(h) {
    }
    if x == nil { return 0 }
    alias()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@27:14", "reject", "", "R15"}
            yield[]object{"r7_5482_condition_call_replaces_the_aliased_callable_inside_the_body", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let ref alias = action
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    alias = callback
    if Check(h) {
        if x == nil { return 0 }
        alias()
        return x.Value
    }
    return 2
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@26:18", "reject", "", "R15"}
            yield[]object{"r3_5482_two_level_ref_alias_chain", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let ref first = action
    let ref second = first
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    second = callback
    Wrapper(h)
    if x == nil { return 0 }
    second()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@27:14", "reject", "", "R15"}
            yield[]object{"r4_5482_ref_alias_without_a_call_keeps_the_fact", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let ref alias = action
    let clear = func() { x = nil }
    alias = callback
    if x == nil { return 0 }
    alias()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "", "run", "1", "R15"}
            yield[]object{"r6_5482_plain_alias_keeps_the_fact_across_a_call", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Touch() {
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var alias = callback
    let clear = func() { x = nil }
    Touch()
    if x == nil { return 0 }
    alias()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "", "run", "1", "R15"}
            yield[]object{"r5_5482_filter_runs_a_closure_that_replaces_the_aliased_callable", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) {
    h.Callback()
}
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let ref alias = action
    let clear = func() { x = nil }
    let h = Holder{}
    h.Callback = func() { action = clear }
    alias = callback
    if x == nil { return 0 }
    try {
        try {
            try {
                throw FormatException("f")
            } finally {
                throw InvalidOperationException("g")
            }
        } catch (InvalidOperationException) {
            alias()
            return x.Value
        }
    } catch (FormatException) when Check(h) {
        return 0
    }
    return 2
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@34:22", "reject", "", "R15"}
            yield[]object{"t01_5231_lazy_value_kills_a_by_reference_parameter_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(ref a C?, xs []C?) int32 {
    let lazy = Lazy[int32](() -> {
        xs[0] = nil
        return 1
    })
    if a == nil { return 0 }
    let n = lazy.Value
    return a.Value + n
}
var xs = []C?{C{}}
Console.WriteLine(Run(ref xs[0], xs))`, "GS0158@21:14", "reject", "", "R16"}
            yield[]object{"t02_5231_lazy_value_kills_a_member_path_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(b Box) string {
    let lazy = Lazy[int32](() -> 1)
    if b.Pet == nil { return "" }
    let n = lazy.Value
    return b.Pet.Name
}
Console.WriteLine(Run(Box(Animal())))`, "GS0158@18:18", "reject", "", "R16"}
            yield[]object{"t03_5231_string_length_keeps_a_member_path_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(b Box, s string) string {
    if b.Pet == nil { return "" }
    let n = s.Length
    return b.Pet.Name + n.ToString()
}
Console.WriteLine(Run(Box(Animal()), "abc"))`, "", "run", "a3", "R16"}
            yield[]object{"t04_5231_list_count_keeps_a_by_reference_parameter_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(ref a C?, xs []C?, list List[int32]) int32 {
    if a == nil { return 0 }
    let n = list.Count
    return a.Value + n
}
var xs = []C?{C{}}
Console.WriteLine(Run(ref xs[0], xs, List[int32]{1, 2}))`, "", "run", "3", "R16"}
            yield[]object{"t05_5231_string_builder_length_keeps_a_closure_assigned_local_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(sb StringBuilder) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil { return 0 }
    let n = sb.Length
    return x.Value + n
}
Console.WriteLine(Run(StringBuilder("ab")))`, "", "run", "3", "R16"}
            yield[]object{"t06_5231_lazy_value_runs_an_escaped_closure_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run() int32 {
    var x C? = C{}
    let lazy = Lazy[int32](() -> {
        x = nil
        return 1
    })
    if x == nil { return 0 }
    let n = lazy.Value
    return x.Value + n
}
Console.WriteLine(Run())`, "GS0158@22:14", "reject", "", "R16"}
            yield[]object{"t07_5231_lazy_value_in_a_condition_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run() int32 {
    var x C? = C{}
    let lazy = Lazy[int32](() -> {
        x = nil
        return 1
    })
    if x == nil { return 0 }
    if lazy.Value > 0 {
    }
    return x.Value
}
Console.WriteLine(Run())`, "GS0158@23:14", "reject", "", "R16"}
            yield[]object{"t08_5231_lazy_value_in_a_loop_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(n int32) int32 {
    var x C? = C{}
    let lazy = Lazy[int32](() -> {
        x = nil
        return 1
    })
    if x == nil { return 0 }
    var total int32 = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value + lazy.Value
    }
    return total
}
Console.WriteLine(Run(2))`, "GS0158@23:27", "reject", "", "R16"}
            yield[]object{"t09_5231_string_length_in_a_loop_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(s string) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil { return 0 }
    var total int32 = 0
    for var i = 0; i < 2; i++ {
        total = total + x.Value + s.Length
    }
    return total
}
Console.WriteLine(Run("abc"))`, "", "run", "8", "R16"}
            yield[]object{"t10_5231_interface_count_kills_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(b Box, c ICollection[int32]) string {
    if b.Pet == nil { return "" }
    let n = c.Count
    return b.Pet.Name + n.ToString()
}
Console.WriteLine(Run(Box(Animal()), List[int32]{1}))`, "GS0158@17:18", "reject", "", "R16"}
            yield[]object{"t11_5231_static_getter_kills_R16", `import System
import System.Collections.Generic
import System.Text

class C {
    var Value int32 = 1
}
class Animal { var Name string = "a" }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}

func Run(b Box) string {
    if b.Pet == nil { return "" }
    let n = Environment.NewLine
    return b.Pet.Name + n.ToString()
}
Console.WriteLine(Run(Box(Animal())))`, "GS0158@17:18", "reject", "", "R16"}
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
