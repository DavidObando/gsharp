// <copyright file="Issue5640DeferArgumentNarrowingTests.cs" company="GSharp">
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

/// Issue #5640 (ADR-0208): the receiver and arguments of a `defer` call run
/// when the `defer` statement runs, so their effects apply to the statements
/// that follow. The deferred call itself runs only when the block exits.
class Issue5640DeferArgumentNarrowingTests {
    private const RunTimeout int32 = 30000

    @Theory
    @MemberData("Rows")
    func DeferPrefixEffects_MatchExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "gs_5640_" + Guid.NewGuid().ToString("N"))
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
        func Rows() IEnumerable[[]object] {
            yield[]object{"d01_5640_defer_call_argument_removes_a_global_fact", `import System
class C {
    var Value int32 = 1
}
func Clear() int32 {
    g = nil
    return 1
}
func Consume(n int32) { }
func Run() int32 {
    if g == nil { return 0 }
    defer Consume(Clear())
    return g.Value
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@13:14", "reject", ""}
            yield[]object{"d02_5640_defer_computed_getter_argument_removes_a_global_fact", `import System
class C {
    var Value int32 = 1
}
class Box {
    prop P int32 {
        get {
            g = nil
            return 1
        }
    }
}
func Consume(n int32) { }
func Run(b Box) int32 {
    if g == nil { return 0 }
    defer Consume(b.P)
    return g.Value
}
var g C? = C{}
Console.WriteLine(Run(Box{}))`, "GS0158@17:14", "reject", ""}
            yield[]object{"d03_5640_defer_open_auto_property_argument_removes_a_global_fact", `import System
class C {
    var Value int32 = 1
}
open class Base {
    open prop Auto int32 { get; set; }
}
class Derived : Base {
    override prop Auto int32 {
        get {
            g = nil
            return 1
        }
        set { }
    }
}
func Consume(n int32) { }
func Run(b Base) int32 {
    if g == nil { return 0 }
    defer Consume(b.Auto)
    return g.Value
}
var g C? = C{}
Console.WriteLine(Run(Derived()))`, "GS0158@21:14", "reject", ""}
            yield[]object{"d04_5640_defer_eager_receiver_removes_a_global_fact", `import System
class C {
    var Value int32 = 1
}
class Receiver {
    func Method() { }
}
func Clear() {
    g = nil
}
func Run() int32 {
    if g == nil { return 0 }
    defer (func() Receiver {
        Clear()
        return Receiver{}
    }()).Method()
    return g.Value
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@17:14", "reject", ""}
            yield[]object{"d05_5640_defer_argument_removes_a_closure_assigned_local_fact", `import System
class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void = func() { }
}
func Clear(h Holder) int32 {
    h.Callback()
    return 1
}
func Consume(n int32) { }
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    defer Consume(Clear(h))
    return x.Value
}
Console.WriteLine(Run())`, "GS0158@19:14", "reject", ""}
            yield[]object{"d06_5640_defer_argument_out_write_removes_a_local_fact", `import System
class C {
    var Value int32 = 1
}
func ClearOut(out item C?) int32 {
    item = nil
    return 1
}
func Consume(n int32) { }
func Run() int32 {
    var x C? = C{}
    if x == nil { return 0 }
    defer Consume(ClearOut(out x))
    return x.Value
}
Console.WriteLine(Run())`, "GS0158@14:14", "reject", ""}
            yield[]object{"d07_5640_defer_eager_target_replaces_an_external_callable_alias", `import System
class C {
    var Value int32 = 1
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    if x == nil { return 0 }
    defer (action = clear)()
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@12:14", "reject", ""}
            yield[]object{"d08_5640_defer_without_eager_effects_keeps_a_global_fact", `import System
class C {
    var Value int32 = 7
}
func Clear() {
    g = nil
}
func Run() int32 {
    if g == nil { return 0 }
    defer Clear()
    return g.Value
}
var g C? = C{}
Console.WriteLine(Run())`, "", "run", "7"}
            yield[]object{"d09_5640_defer_without_eager_effects_keeps_a_member_path_fact", `import System
class C {
    var Value int32 = 7
}
class Box {
    let Item C?
    init(item C?) { Item = item }
}
func Clear() { }
func Run(b Box) int32 {
    if b.Item == nil { return 0 }
    defer Clear()
    return b.Item.Value
}
Console.WriteLine(Run(Box(C{})))`, "", "run", "7"}
            yield[]object{"d10_5640_defer_computed_getter_argument_removes_a_by_reference_fact", `import System
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
func Consume(n int32) { }
func Run(ref text string?, b Box) int32 {
    if text == nil { return 0 }
    defer Consume(b.P)
    return text.Length
}
Console.WriteLine(Run(ref Box.G, Box{}))`, "GS0158@17:17", "reject", ""}
            yield[]object{"d11_5640_defer_plain_argument_keeps_a_by_reference_fact", `import System
class Box {
    shared {
        var G string? = "abcdefg"
    }
}
func Consume(n int32) { }
func Run(ref text string?) int32 {
    if text == nil { return 0 }
    defer Consume(1)
    return text.Length
}
Console.WriteLine(Run(ref Box.G))`, "", "run", "7"}
            yield[]object{"d12_5640_defer_uninvoked_function_literal_with_try_filter_keeps_external_callable_alias", `import System
class C {
    var Value int32 = 7
}
func Consume(f () -> void) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    if x == nil { return 0 }
    defer Consume(func() {
        try {
            action = clear
        } catch (Exception) when true {
        }
    })
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "", "run", "7"}
            yield[]object{"d13_5640_defer_eager_target_assigning_external_callable_keeps_alias", `import System
class C {
    var Value int32 = 7
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = clear
    if x == nil { return 0 }
    defer (action = callback)()
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "", "run", "7"}
            yield[]object{"d14_5640_defer_invoked_function_literal_with_try_filter_removes_external_callable_alias", `import System
class C {
    var Value int32 = 1
}
func Consume(n int32) { }
func Run(callback () -> void, ex Exception) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() {
        action = clear
    }
    defer Consume((func() int32 {
        try {
            throw ex
        } catch (Exception) when true {
            flip()
            return 1
        }
    })())
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }, Exception("x")))`, "GS0158@23:14", "reject", ""}
            yield[]object{"d15_5640_reassigning_external_callable_after_unknown_call_keeps_alias", `import System
class C {
    var Value int32 = 7
}
func RunBlock(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() {
        action = clear
    }
    {
        flip()
        action = callback
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func RunDefer(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() {
        action = clear
    }
    defer ({
        flip()
        action = callback
        action
    })()
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(RunBlock(func() { }) + RunDefer(func() { }))`, "", "run", "14"}
            yield[]object{"d16_5640_defer_eager_target_assigning_method_group_keeps_alias", `import System
class C {
    var Value int32 = 7
}
func Noop() { }
func Run() int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = clear
    if x == nil { return 0 }
    defer (action = Noop)()
    action()
    return x.Value
}
Console.WriteLine(Run())`, "", "run", "7"}
            yield[]object{"d17_5640_defer_invoked_function_literal_runs_after_argument_assignment", `import System
class C {
    var Value int32 = 1
}
func Consume(n int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    defer Consume((func(f () -> void) int32 {
        action = clear
        return 1
    })((action = callback)))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@16:14", "reject", ""}
            yield[]object{"d18_5640_variable_declaration_evaluates_initializer_before_recording_method_group_alias", `import System
class C {
    var Value int32 = 7
}
class Box {
    func Noop() { }
}
func Run() int32 {
    var x C? = C{}
    var make () -> Box = func() Box { return Box{} }
    var action () -> void = make().Noop
    let clear = func() {
        x = nil
        action = func() { }
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run())`, "", "run", "7"}
            yield[]object{"d19_5640_defer_explicit_delegate_invoke_runs_after_callable_argument", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let invoke Func[Action, int32] = func(f Action) int32 {
        action = clear
        return 1
    }
    defer Consume(invoke.Invoke(func() { action = callback }))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@17:14", "reject", ""}
            yield[]object{"d20_5640_defer_callable_argument_provenance_snapshotted_before_later_argument", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    var flip () -> void = func() { action = clear }
    defer Consume((func(f () -> void, n int32) int32 {
        f()
        return n
    })(flip, {
        flip = callback
        1
    }))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@20:14", "reject", ""}
            yield[]object{"d21_5640_defer_invoked_literal_calls_passed_closure_after_external_assignment", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    defer Consume((func(f () -> void) int32 {
        action = callback
        f()
        return 1
    })(func() { action = clear }))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@17:14", "reject", ""}
            yield[]object{"d22_5640_defer_explicit_delegate_invoke_calls_passed_closure_after_external_assignment", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    defer Consume({
        let invoke Func[Action, int32] = func(f Action) int32 {
            action = callback
            f()
            return 1
        }
        invoke.Invoke(func() { action = clear })
    })
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@20:14", "reject", ""}
            yield[]object{"d23_5640_defer_ignored_callable_argument_does_not_overwrite_non_external_alias", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = clear
    defer Consume((func(f () -> void) int32 {
        return 1
    })(func() { action = callback }))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@15:14", "reject", ""}
            yield[]object{"d24_5640_defer_repeated_invocation_preserves_captured_parameter_provenance", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    defer Consume({
        var saved = callback
        let invoke = func(f () -> void) int32 {
            saved()
            saved = func() { f() }
            return 1
        }
        invoke(func() { action = clear })
        action = callback
        invoke(callback)
    })
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@23:14", "reject", ""}
            yield[]object{"d25_5640_defer_out_argument_invalidates_external_callable_alias", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Set(out target () -> void, value () -> void) int32 {
    target = value
    return 1
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    defer Consume(Set(out action, func() { x = nil }))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@16:14", "reject", ""}
            yield[]object{"d26_5640_defer_invoked_literal_early_return_joins_pre_return_callable_state", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(stop bool, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = clear
    defer Consume((func() int32 {
        if stop { return 1 }
        action = callback
        return 1
    })())
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "GS0158@17:14", "reject", ""}
            yield[]object{"d27_5640_defer_repeated_noncapturing_invocation_replaces_parameter_provenance", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(choose bool, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    var other = callback
    defer Consume({
        let readIn = func(in target () -> void) int32 { return 1 }
        let invoke = func(f () -> void) int32 {
            f()
            return 1
        }
        invoke(func() { action = clear })
        action = callback
        readIn(in choose ? action : other)
        invoke(callback)
    })
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "", "run", "7"}
            yield[]object{"d28_5640_defer_conditional_out_argument_invalidates_external_callable_alias", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(choose bool, callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    var other = callback
    let set = func(out target () -> void, value () -> void) int32 {
        target = value
        return 1
    }
    defer Consume(set(out choose ? action : other, func() { x = nil }))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "GS0158@17:14", "reject", ""}
            // Early return inside `try`/`finally` in an invoked literal joins returning callable state through `finally`.
            yield[]object{"d29_5640_defer_invoked_literal_try_finally_return_preserves_returning_branch_state", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(stop bool, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() { action = clear }
    defer Consume((func() int32 {
        try {
            if stop {
                flip()
                return 1
            }
            return 1
        } finally {
        }
    })())
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "GS0158@23:14", "reject", ""}
            yield[]object{"d30_5640_defer_repeated_invocation_preserves_captured_local_provenance", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    defer Consume({
        var saved = callback
        let invoke = func(f () -> void) int32 {
            let copy = f
            saved()
            saved = func() { copy() }
            return 1
        }
        invoke(func() { action = clear })
        action = callback
        invoke(callback)
    })
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func() { }))`, "GS0158@24:14", "reject", ""}
            yield[]object{"d31_5640_defer_invoked_literal_terminating_finally_replays_pending_try_return", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(stop bool, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() { action = clear }
    defer Consume((func() int32 {
        try {
            if stop {
                flip()
                return 1
            }
        } finally {
            return 1
        }
    })())
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "GS0158@23:14", "reject", ""}
            yield[]object{"d32_5640_defer_invoked_literal_catch_entry_includes_unknown_call_invalidation", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(ex Exception, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() { action = clear }
    defer Consume((func() int32 {
        try {
            flip()
            throw ex
        } catch (Exception) {
            return 1
        }
    })())
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(Exception("boom"), func() { }))`, "GS0158@21:14", "reject", ""}
            yield[]object{"d33_5640_defer_repeated_callback_argument_executes_to_fixed_point", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(repeat Func[Action, int32], callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    var saved = callback
    defer Consume(repeat.Invoke(func() {
        saved()
        saved = func() { action = clear }
    }))
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(func(f Action) int32 {
    f()
    f()
    return 1
}, func() { }))`, "GS0158@17:14", "reject", ""}
            yield[]object{"d34_5640_defer_nested_finally_returns_scale_linearly_and_preserve_return_state", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(stop bool, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() { action = clear }
    defer Consume({
        (func() {
            try {
                if stop {
                    flip()
                    return
                }
                return
            } finally {
                try { return } finally {
                    try { return } finally {
                        try { return } finally {
                            try { return } finally {
                                try { return } finally {
                                    try { return } finally {
                                        try { return } finally {
                                            try { return } finally {
                                                try { return } finally {
                                                    try { return } finally {
                                                        try { return } finally {
                                                            try { return } finally {
                                                                try { return } finally {
                                                                    try { return } finally {
                                                                        try { return } finally {
                                                                            return
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })()
        1
    })
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "GS0158@57:14", "reject", ""}
            yield[]object{"d35_5640_defer_declaration_copy_of_mixed_external_unknown_callable_preserves_unknown", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(stop bool, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() { action = clear }
    defer Consume({
        if stop { flip() }
        let copy = action
        action = copy
        1
    })
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "GS0158@19:14", "reject", ""}
            yield[]object{"d36_5640_defer_self_assignment_of_mixed_external_unknown_callable_preserves_unknown", `import System
class C {
    var Value int32 = 7
}
func Consume(v int32) { }
func Run(stop bool, callback () -> void) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    var action = callback
    let flip = func() { action = clear }
    defer Consume({
        if stop { flip() }
        action = action
        1
    })
    if x == nil { return 0 }
    action()
    return x.Value
}
Console.WriteLine(Run(true, func() { }))`, "GS0158@18:14", "reject", ""}
            yield[]object{"d37_5707_defer_storage_owner_effects_remove_global_fact", `import System
class C { var Value int32 = 1 }
struct Counter { func Bump() { } }
class Host { var counter Counter }
func Get() Host {
    g = nil
    return Host()
}
func Run() int32 {
    if g == nil { return 0 }
    defer Get().counter.Bump()
    return g.Value
}
var g C? = C{}
Console.WriteLine(Run())`, "GS0158@12:14", "reject", ""}
            yield[]object{"d38_5707_defer_storage_index_effects_remove_global_fact", `import System
class C { var Value int32 = 1 }
struct Counter { func Bump() { } }
func Index() int32 {
    g = nil
    return 0
}
func Run(items []Counter) int32 {
    if g == nil { return 0 }
    defer items[Index()].Bump()
    return g.Value
}
var g C? = C{}
Console.WriteLine(Run([]Counter{Counter{}}))`, "GS0158@11:14", "reject", ""}
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
