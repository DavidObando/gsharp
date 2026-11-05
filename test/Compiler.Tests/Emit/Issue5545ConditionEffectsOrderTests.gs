// <copyright file="Issue5545ConditionEffectsOrderTests.cs" company="GSharp">
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

/// ADR-0208 regression tests for issue #5545 (condition and pattern effects order
/// across `&&`/`||` operands, `if`-expressions, conditional expressions, loop
/// headers, and `if let` bindings and guards).
open class Issue5545ConditionEffectsOrderTests {
    @Theory
    @MemberData("Rows")
    func ConditionEffectsProbes_ProduceExpectedDiagnosticsAndOutput(
        name string,
        source string,
        expectedDiagnostics string,
        kind string,
        expectedOutput string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_5545_").FullName
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

    @Fact
    func ImportedReadOnlyField_ConditionalInArgument_RejectsNarrowedStorageMismatch() {
        let tempDir = Directory.CreateTempSubdirectory("gs_5545_lib_").FullName
        try {
            let libSrc = Path.Combine(tempDir, "BoxLib.gs")
            let libDll = Path.Combine(tempDir, "BoxLib.dll")
            File.WriteAllText(libSrc, `package BoxPkg
public class Box {
    public let Value object
    public init(v object) {
        Value = v
    }
}`)
            let libArgs = List[string]{
                "/out:" + libDll,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            for reference in TrustedPlatformAssemblies() {
                libArgs.Add("/reference:" + reference)
            }
            libArgs.Add(libSrc)
            let prevOut = Console.Out
            let prevErr = Console.Error
            using let libOut = StringWriter()
            using let libErr = StringWriter()
            Console.SetOut(libOut)
            Console.SetError(libErr)
            try {
                Program.Main(libArgs.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(File.Exists(libDll), "BoxLib must compile:\n" + libOut.ToString() + libErr.ToString())

            let appSrc = Path.Combine(tempDir, "App.gs")
            let appDll = Path.Combine(tempDir, "App.dll")
            File.WriteAllText(appSrc, `import System
import BoxPkg

class Dog {}
func Read(in d Dog) int32 -> 1
func Run() int32 {
    let box = Box(Dog())
    var dog = Dog()
    return Read(in ((box.Value is Dog) ? box.Value : dog))
}
Console.WriteLine(Run())`)
            let appArgs = List[string]{
                "/out:" + appDll,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/reference:" + libDll
            }
            for reference in TrustedPlatformAssemblies() {
                appArgs.Add("/reference:" + reference)
            }
            appArgs.Add(appSrc)
            using let appOut = StringWriter()
            using let appErr = StringWriter()
            Console.SetOut(appOut)
            Console.SetError(appErr)
            try {
                Program.Main(appArgs.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            let log = appOut.ToString() + appErr.ToString()
            let actualDiagnostics = string.Join(
                " ",
                Regex
                    .Matches(log, `\((\d+),(\d+),\d+,\d+\): (?:error|warning) (GS\d+)`)
                    .Select((m Match) -> m.Groups[3].Value + "@" + m.Groups[1].Value + ":" + m.Groups[2].Value)
                    .Where((d string) -> !d.StartsWith("GS9100", StringComparison.Ordinal))
            )
            Assert.Equal("GS0260@9:21", actualDiagnostics)
            Assert.False(File.Exists(appDll), "App must not compile:\n" + log)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 30000

        func Rows() IEnumerable[[]object] {
            yield[]object{"s01a_and_right_operand_sees_left_call_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    if Check(h) && x.Value > 0 { return 1 }
    return 2
}
Console.WriteLine(Run())`, "GS0158@14:22", "reject", ""}
            yield[]object{"s01b_or_right_operand_sees_left_call_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func CheckFalse(h Holder) bool {
    h.Callback()
    return false
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    if CheckFalse(h) || x.Value > 0 { return 1 }
    return 2
}
Console.WriteLine(Run())`, "GS0158@14:27", "reject", ""}
            yield[]object{"s01c_and_in_then_branch_restores_fact_for_else_branch", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(flag bool) int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    if flag {
        if Check(h) && true { }
    } else {
        return x.Value
    }
    return 2
}
Console.WriteLine(Run(false))`, "", "run", "1"}
            yield[]object{"s02a_if_expression_then_branch_sees_condition_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    let v = if Check(h) { x.Value } else { 2 }
    return v
}
Console.WriteLine(Run())`, "GS0158@14:29", "reject", ""}
            yield[]object{"s02b_if_expression_else_branch_sees_condition_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func CheckFalse(h Holder) bool {
    h.Callback()
    return false
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    let v = if CheckFalse(h) { 2 } else { x.Value }
    return v
}
Console.WriteLine(Run())`, "GS0158@14:45", "reject", ""}
            yield[]object{"s02c_conditional_expression_arms_see_condition_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    let v = Check(h) ? x.Value : 2
    return v
}
Console.WriteLine(Run())`, "GS0158@14:26", "reject", ""}
            yield[]object{"s02d_if_expression_then_kill_restored_for_else_branch", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run(flag bool) int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    return if flag {
        if Check(h) { } else { }
        1
    } else {
        x.Value
    }
}
Console.WriteLine(Run(false))`, "", "run", "1"}
            yield[]object{"s03a_while_and_for_headers_and_body_see_condition_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run1() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    var n = 0
    while Check(h) && n < 1 {
        n++
        return x.Value
    }
    return 2
}
func Run2() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    for var n = 0; x != nil && Check(h) && x.Value > 0; n++ {
        return 1
    }
    return 2
}
Console.WriteLine(Run1() + Run2())`, "GS0158@17:18 GS0158@25:46", "reject", ""}
            yield[]object{"s03b_while_header_earlier_proof_killed_before_later_and_operand", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    while x != nil && Check(h) && x.Value > 0 {
        return 1
    }
    return 2
}
Console.WriteLine(Run())`, "GS0158@13:37", "reject", ""}
            yield[]object{"s03c_for_ellipsis_upper_bound_sees_lower_bound_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Bound(h Holder) int32 {
    h.Callback()
    return 1
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    for i in Bound(h)...x.Value {
        return i
    }
    return 2
}
Console.WriteLine(Run())`, "GS0158@14:27", "reject", ""}
            yield[]object{"s04a_if_let_statement_then_branch_sees_initializer_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Get(h Holder) C? {
    h.Callback()
    return C{}
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    if let c = Get(h) { return x.Value + c.Value }
    return 2
}
Console.WriteLine(Run())`, "GS0158@14:34", "reject", ""}
            yield[]object{"s04b_if_let_statement_second_binding_sees_first_initializer_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Get(h Holder) C? {
    h.Callback()
    return C{}
}
func Use(n int32) C? -> C{Value: n}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    if let c = Get(h), let d = Use(x.Value) {
        return c.Value + d.Value
    }
    return 2
}
Console.WriteLine(Run())`, "GS0158@15:38", "reject", ""}
            yield[]object{"s04c_if_let_statement_guard_and_branches_see_guard_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let maybe C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    if let c = maybe && Check(h) {
        return x.Value + c.Value
    }
    return 2
}
Console.WriteLine(Run())`, "GS0158@16:18", "reject", ""}
            yield[]object{"s04d_if_let_expression_arms_see_initializer_effect", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Get(h Holder) C? {
    h.Callback()
    return C{}
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    return if let c = Get(h) { x.Value + c.Value } else { 2 }
}
Console.WriteLine(Run())`, "GS0158@14:34", "reject", ""}
            yield[]object{"s05a_nil_guard_killed_by_later_and_operand_in_if", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x != nil && Check(h) { return x.Value }
    return 2
}
Console.WriteLine(Run())`, "GS0158@13:40", "reject", ""}
            yield[]object{"s05b_type_test_killed_by_later_and_operand_in_if", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x is C && Check(h) { return x.Value }
    return 2
}
Console.WriteLine(Run())`, "GS0158@13:38", "reject", ""}
            yield[]object{"s05c_or_else_narrowing_killed_by_later_or_operand", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func CheckFalse(h Holder) bool {
    h.Callback()
    return false
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil || CheckFalse(h) {
        return 0
    } else {
        return x.Value
    }
}
Console.WriteLine(Run())`, "GS0158@16:18", "reject", ""}
            yield[]object{"s05d_control_test_after_call_narrows_branch", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if Check(h) && x != nil { return x.Value }
    return 2
}
Console.WriteLine(Run())`, "", "run", "2"}
            yield[]object{"s05e_control_plain_local_not_closure_assigned_keeps_narrowing_across_call", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x C? = C{}
    var y C? = C{}
    let h = Holder{}
    h.Callback = func() { y = nil }
    if x != nil && Check(h) { return x.Value }
    return 2
}
Console.WriteLine(Run())`, "", "run", "1"}
            yield[]object{"s06_subtype_fact_removed_before_right_operand_type_test", `import System

open class Pet {}
class Dog : Pet {}
class Cat : Pet {}
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x Pet? = Dog()
    let h = Holder{}
    h.Callback = func() { x = Cat() }
    if x !is Dog { return 0 }
    if Check(h) && x is Cat { return 1 }
    return 2
}
Console.WriteLine(Run())`, "", "run", "1"}
            yield[]object{"s07_nullable_value_fact_removed_before_right_operand_type_test", `import System

class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Run() int32 {
    var x int32? = 5
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    if Check(h) && x is int32 { return 1 }
    return 2
}
Console.WriteLine(Run())`, "", "run", "2"}
            yield[]object{"s08a_if_expression_property_pattern_getter_effect_does_not_narrow", `import System

open class Pet { var Value int32 = 1 }
class Dog : Pet {
    var Clear () -> void = func() { }
    prop P int32 {
        get {
            Clear()
            return 1
        }
    }
}
func Run() int32 {
    let d = Dog{}
    var x Pet? = d
    d.Clear = func() { x = nil }
    let r = if x is Dog { P: 1 } { x.Value } else { 2 }
    return r
}
Console.WriteLine(Run())`, "GS0158@17:38", "reject", ""}
            yield[]object{"s08b_if_expression_constant_pattern_equals_effect_does_not_narrow", `import System

class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
func Run() int32 {
    let e = E{}
    var x object? = e
    e.Clear = func() { x = nil }
    return if x is 1 { x.GetHashCode() } else { 2 }
}
Console.WriteLine(Run())`, "GS0159@15:26", "reject", ""}
            yield[]object{"s08c_switch_statement_property_and_constant_pattern_effects_do_not_narrow", `import System

open class Pet { var Value int32 = 1 }
class Dog : Pet {
    var Clear () -> void = func() { }
    prop P int32 {
        get {
            Clear()
            return 1
        }
    }
}
class E {
    var Clear () -> void = func() { }
    override func Equals(o object?) bool {
        Clear()
        return true
    }
    override func GetHashCode() int32 -> 1
}
func Run1() int32 {
    let d = Dog{}
    var x Pet? = d
    d.Clear = func() { x = nil }
    switch x {
        case Dog { P: 1 } { return x.Value }
        default { return 2 }
    }
}
func Run2() int32 {
    let e = E{}
    var y object? = e
    e.Clear = func() { y = nil }
    switch y {
        case 1 { return y.GetHashCode() }
        default { return 2 }
    }
}
Console.WriteLine(Run1() + Run2())`, "GS0158@26:38 GS0159@35:27", "reject", ""}
            yield[]object{"s08d_and_right_operand_after_pattern_with_getter_effect_does_not_narrow", `import System

open class Pet { var Value int32 = 1 }
class Dog : Pet {
    var Clear () -> void = func() { }
    prop P int32 {
        get {
            Clear()
            return 1
        }
    }
}
func Run() int32 {
    let d = Dog{}
    var x Pet? = d
    d.Clear = func() { x = nil }
    if (x is Dog { P: 1 }) && x.Value > 0 { return 1 }
    return 2
}
Console.WriteLine(Run())`, "GS0158@17:33", "reject", ""}
            yield[]object{"r01_conditional_address_mismatched_narrowed_storage_rejected", `import System

open class Pet {}
class Dog : Pet {}
func Run() int32 {
    var pet Pet = Dog()
    var dog Dog = Dog()
    let p = &((pet is Dog) ? pet : dog)
    return 1
}
Console.WriteLine(Run())`, "GS0260@8:15", "reject", ""}
            yield[]object{"r02_deferred_argument_kills_fact_for_second_argument", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
func Sink(s string?, n int32) int32 -> n
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    return Sink(if Check(h) { nil } else { "ok" }, x.Value)
}
Console.WriteLine(Run())`, "GS0158@15:54", "reject", ""}
            yield[]object{"r03_contextual_rebind_preserves_entry_fact", `import System

class C { var Value int32 = 1 }
class Holder { var Callback () -> void = func() { } }
func Check(h Holder) bool {
    h.Callback()
    return true
}
interface IAnimal { func Speak() int32; }
open class Pet {}
class Dog : Pet, IAnimal { func Speak() int32 -> 1 }
class Cat : Pet, IAnimal { func Speak() int32 -> 2 }
func Consume(a IAnimal) int32 -> a.Speak()
func Run() int32 {
    var x C? = C{}
    let h = Holder{}
    h.Callback = func() { x = nil }
    if x == nil { return 0 }
    return Consume(if x.Value > 0 && Check(h) { Dog() } else { Cat() })
}
Console.WriteLine(Run())`, "", "run", "1"}
            yield[]object{"r04_nested_conditional_address_mismatched_storage_rejected", `import System

open class Pet {}
class Dog : Pet {}
func Run() int32 {
    var pet Pet = Dog()
    var dog Dog = Dog()
    let p = &((pet is Dog) ? (true ? pet : pet) : dog)
    return 1
}
Console.WriteLine(Run())`, "GS0260@8:15", "reject", ""}
            yield[]object{"r05_block_argument_rebind_preserves_prefix_local_narrowing", `import System

class C { var Value int32 = 1 }
interface IAnimal { func Speak() int32; }
open class Pet {}
class Dog : Pet, IAnimal { func Speak() int32 -> 1 }
class Cat : Pet, IAnimal { func Speak() int32 -> 2 }
func Consume(a IAnimal) int32 -> a.Speak()
func Run() int32 {
    return Consume({
        var x C? = nil
        x = C{}
        if x.Value > 0 { Dog() } else { Cat() }
    })
}
Console.WriteLine(Run())`, "", "run", "1"}
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
