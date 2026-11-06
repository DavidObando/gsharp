// <copyright file="Issue5498And5502NarrowingTests.cs" company="GSharp">
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

/// Regression coverage for issues #5498 and #5502 (ADR-0208 R15):
/// - #5498: `RestoreEarlyExitLiftsWrittenOnlyByCondition` evaluates compound condition operands in evaluation order,
///   rejecting roots when a call can run an escaped closure after the non-null proof while preserving roots tested
///   after the call.
/// - #5502: cleanup blocks and bare blocks apply call and assignment effects in evaluation order, preserving facts and
///   external callable aliases established after a call while removing those followed by a call.
open class Issue5498And5502NarrowingTests {
    @Theory
    @MemberData("Rows")
    func EveryProbe_MatchesExpectedResult(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "issue5498-5502-" + Guid.NewGuid().ToString("N"))
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
            yield[]object{"nested_assignment_block_keeps_entry_external_aliases", `import System
func External() { }
func Run(callback () -> void) int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var action = callback
    var n = 0
    n = ({
        text = "safe"
        action()
        action = clear
        0
    })
    return text.Length
}
func Main() { Console.WriteLine(Run(External)) }`, "", "run", "4"}
            yield[]object{"nested_assignment_block_uses_entry_callable_aliases", `import System
func External() { }
func Run(callback () -> void) int32 {
    var text string? = nil
    var action = func() { text = nil }
    var n = 0
    n = ({
        text = "safe"
        action()
        action = callback
        0
    })
    return text.Length
}
func Main() { Console.WriteLine(Run(External)) }`, "GS0158@13:17", "reject", ""}
            yield[]object{"nested_assignment_native_map_hash_callback", `import System
class Key {
    var Callback () -> void
    override func GetHashCode() int32 {
        Callback()
        return 1
    }
}
func Run() int32 {
    var text string? = nil
    let key = Key{}
    key.Callback = func() { text = nil }
    var m = map[Key, string?]{}
    m[key] = (text = "safe")
    return text.Length
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@15:17", "reject", ""}
            yield[]object{"nested_assignment_block_native_map_read_callback", `import System
class Key {
    var Callback () -> void
    override func GetHashCode() int32 {
        Callback()
        return 1
    }
}
func Run() int32 {
    var text string? = nil
    let key = Key{}
    key.Callback = func() { text = nil }
    var m = map[Key, string?]{key: nil}
    var n = 0
    n = ({
        text = "safe"
        let unused = m[key]
        0
    })
    return text.Length
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@20:17", "reject", ""}
            yield[]object{"nested_assignment_primitive_map_key_preserves_fact", `import System
func Run() int32 {
    var text string? = nil
    let clear = func() { text = nil }
    var m = map[int32, string?]{}
    m[0] = (text = "safe")
    let length = text.Length
    clear()
    return length
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "4"}
            yield[]object{"nested_assignment_discharges_failed_dictionary_lookup", `import System
import System.Collections.Generic
func Run(dict Dictionary[string, HashSet[string]]) int32 {
    if !dict.TryGetValue("key", out var set) {
        dict["key"] = (set = HashSet[string]())
    }
    set.Add("ok")
    return set.Count
}
func Main() {
    let dict = Dictionary[string, HashSet[string]]()
    Console.WriteLine(Run(dict))
    Console.WriteLine(Run(dict))
}`, "", "run", "1|1"}
            yield[]object{"nested_assignment_setter_callback_keeps_widening", `import System
import System.Collections.Generic
class Holder {
    var Callback () -> void
    prop Value string { set { Callback() } }
}
func Run() int32 {
    let dict = Dictionary[string, string]()
    var value string = ""
    let holder = Holder{}
    holder.Callback = func() { dict.TryGetValue("missing", &value) }
    if !dict.TryGetValue("key", &value) {
        holder.Value = (value = "safe")
    }
    return value.Length
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@15:18", "reject", ""}
            yield[]object{"repro_5498_or_chain_trailing_and_operand_does_not_restore_fact", `import System

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
func Run(stop bool) int32 {
    var x C? = nil
    let h = Holder{}
    h.Callback = func() { x = nil }
    if !TryGet(out x) || x == nil || Wrapper(h) || (x == nil && stop) { return 0 }
    return x.Value
}
func Main() { Console.WriteLine(Run(false)) }`, "GS0158@22:14", "reject", ""}
            yield[]object{"repro_5498_negated_and_chain_call_after_test_does_not_restore_fact", `import System

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
    if !(TryGet(out x) && x != nil && !Wrapper(h)) { return 0 }
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@22:14", "reject", ""}
            yield[]object{"control_5498_or_chain_test_after_call_restores_fact", `import System

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
    h.Callback = func() { x = C{} }
    if !TryGet(out x) || Wrapper(h) || x == nil { return 0 }
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "1"}
            yield[]object{"control_5498_negated_and_chain_test_after_call_restores_fact", `import System

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
    h.Callback = func() { x = C{} }
    if !(TryGet(out x) && !Wrapper(h) && x != nil) { return 0 }
    return x.Value
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "1"}
            yield[]object{"repro_5502_cleanup_nested_block_assignment_after_call_restores_fact", `import System

func Touch() { }
func Run() int32 {
    var x string? = nil
    let clear = func() { x = nil }
    try {
    } finally {
        {
            Touch()
            x = "abc"
        }
    }
    return x.Length
}
func Main() { Console.WriteLine(Run()) }`, "", "run", "3"}
            yield[]object{"control_5502_cleanup_nested_block_call_after_assignment_removes_fact", `import System

func Touch() { }
func Run() int32 {
    var x string? = nil
    let clear = func() { x = nil }
    try {
    } finally {
        {
            x = "abc"
            Touch()
        }
    }
    return x.Length
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@14:14", "reject", ""}
            yield[]object{"repro_5502_bare_block_assignment_after_call_restores_callable_alias", `import System

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
    {
        Wrapper(h)
        action = callback
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "", "run", "1"}
            yield[]object{"control_5502_bare_block_call_after_assignment_removes_callable_alias", `import System

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
    {
        action = callback
        Wrapper(h)
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@23:14", "reject", ""}
            yield[]object{"repro_5502_cleanup_goto_assignment_after_call_restores_callable_alias", `import System

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
    try {
        goto After
    } finally {
        Wrapper(h)
        action = callback
    }
After:
    let dummy = 0
    if x == nil { return dummy }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "", "run", "1"}
            yield[]object{"control_5502_cleanup_goto_call_after_assignment_removes_callable_alias", `import System

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
    try {
        goto After
    } finally {
        action = callback
        Wrapper(h)
    }
After:
    let dummy = 0
    if x == nil { return dummy }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@27:14", "reject", ""}
            yield[]object{"review_switch_failed_guard_carries_alias_invalidation_to_default", `import System

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
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    switch 0 {
        case _ when Wrapper(h) { return 0 }
        default { }
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@24:14", "reject", ""}
            yield[]object{"review_primary_constructor_literal_invalidates_alias_after_arguments", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Touch(h Holder) int32 {
    h.Callback()
    return 1
}
struct Box(H Holder, F () -> void) {
    var Extra int32 = Touch(H)
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    {
        let b = Box(h, (action = callback))
        if b.Extra == 0 { return 0 }
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@27:14", "reject", ""}
            yield[]object{"review_constant_pattern_equals_invalidates_alias_after_pattern_value", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
class EqBox {
    var H Holder
    override func Equals(obj object?) bool {
        H.Callback()
        return true
    }
    override func GetHashCode() int32 -> 0
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    let o object = EqBox{H: h}
    {
        if o is (action = callback) { }
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@28:14", "reject", ""}
            yield[]object{"review_for_range_invalidates_alias_after_collection_and_loop_body", `import System
import System.Collections.Generic

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Seq(h Holder) sequence[int32] {
    h.Callback()
    yield 1
    h.Callback()
}
func RunCollection(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    let items = Seq(h)
    for item in ({
        action = callback
        items
    }) {
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func RunBody(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    let items = Seq(h)
    for item in items {
        action = callback
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(RunCollection(func() { }) + RunBody(func() { })) }`, "GS0158@28:14 GS0158@41:14", "reject", ""}
            yield[]object{"review_early_exit_out_retest_is_pattern_survives_nested_if_in_then", `import System

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
func Run(stop bool) int32 {
    var x C? = C{}
    var y C? = C{}
    let h = Holder{}
    h.Callback = func() { x = C{} }
    if x == nil || y == nil { return 0 }
    if !TryGet(out x) || Wrapper(h) || x !is {} {
        if stop {
            return -1
        }
        return 0
    }
    return x.Value + y.Value
}
func Main() { Console.WriteLine(Run(false)) }`, "", "run", "2"}
            yield[]object{"review_5498_subtype_proof_weakened_by_later_call_and_nil_test_restores_base_only", `import System

open class Base {
    var BaseVal int32 = 1
}
class Derived : Base {
    var DerivedVal int32 = 2
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) bool {
    h.Callback()
    return false
}
func TryGet(out x Base?) bool {
    x = Derived{}
    return true
}
func Run() int32 {
    var x Base? = nil
    let h = Holder{}
    h.Callback = func() { x = Base{} }
    if !TryGet(out x) || x !is Derived || Wrapper(h) || x == nil { return 0 }
    return x.BaseVal + x.DerivedVal
}
func Main() { Console.WriteLine(Run()) }`, "GS0158@25:26", "reject", ""}
            yield[]object{"review_5502_plain_struct_literal_lexical_initializer_order", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Wrapper(h Holder) int32 {
    h.Callback()
    return 1
}
struct Box(A int32) {
    var F () -> void
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    {
        let b = Box{F: (action = callback), A: Wrapper(h)}
        if b.A == 0 { return 0 }
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "GS0158@27:14", "reject", ""}
            yield[]object{"review_5502_uncaptured_alias_saved_in_call_argument_keeps_external_classification", `import System

class C {
    var Value int32 = 1
}
class Holder {
    var Callback () -> void
}
func Consume(f () -> void, h Holder) {
    h.Callback()
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    var saved () -> void = func() { x = nil }
    let h = Holder{}
    h.Callback = func() { action = func() { x = nil } }
    {
        Consume((saved = action), h)
    }
    if x == nil { return 0 }
    saved()
    return x.Value
}
func Main() { Console.WriteLine(Run(func() { })) }`, "", "run", "1"}
            yield[]object{"review_5502_data_struct_parameterless_ctor_literal_invalidates_alias", `import System

class C {
    var Value int32 = 1
}
data struct Box {
    var Tag int32
    init() {
        Tag = 1
        cleaner()
    }
}
func Run(callback () -> void) int32 {
    var x C? = C{}
    var action = callback
    cleaner = func() { action = func() { x = nil } }
    {
        let b = Box{}
        if b.Tag == 0 { return 0 }
    }
    if x == nil { return 0 }
    action()
    return x.Value
}
var cleaner () -> void = func() { }
Console.WriteLine(Run(func() { }))`, "GS0158@23:14", "reject", ""}
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
