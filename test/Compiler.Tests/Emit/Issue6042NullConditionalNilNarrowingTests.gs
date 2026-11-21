// <copyright file="Issue6042NullConditionalNilNarrowingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.Text
import Xunit

class Issue6042NullConditionalNilNarrowingTests {
    @Fact
    func Repro_IfPropertyNotEqualNil_CompilesVerifiesAndRuns() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Box {
    var Text string? = "safe"
}
shared class P {
    func Check(value Box?) {
        if value?.Text != nil { Console.WriteLine(value.Text) }
    }
    func Main() {
        Check(Box())
        Check(nil)
    }
}`
        let program = fixture.Compile(source, "Repro6042", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(Encoding.UTF8.GetBytes("safe" + Environment.NewLine), fixture.RunBytes(program))
    }

    @Theory
    @InlineData("if value?.Text != nil { return value.Text ?? \"none\" } return \"nil\"")
    @InlineData("if nil != value?.Text { return value.Text ?? \"none\" } return \"nil\"")
    @InlineData("if value?.Text == nil { return \"nil\" } else { return value.Text ?? \"none\" }")
    @InlineData("if nil == value?.Text { return \"nil\" } else { return value.Text ?? \"none\" }")
    @InlineData("if !(value?.Text == nil) { return value.Text ?? \"none\" } return \"nil\"")
    @InlineData("if value?.Text is not nil { return value.Text ?? \"none\" } return \"nil\"")
    @InlineData("if value?.Text is string { return value.Text ?? \"none\" } return \"nil\"")
    @InlineData("if value?.Text is nil { return \"nil\" } else { return value.Text ?? \"none\" }")
    @InlineData("if !(value?.Text is nil) { return value.Text ?? \"none\" } return \"nil\"")
    @InlineData("if value?.GetText() != nil { return value.GetText() ?? \"none\" } return \"nil\"")
    func NullConditionalNilComparison_ProvesReceiverAcrossForms(body string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Box {
    var Text string? = "safe"
    func GetText() string? -> Text
}
shared class P {
    func Check(value Box?) string {
        ` + body + `
    }
    func Main() {
        Console.WriteLine(Check(Box()))
        Console.WriteLine(Check(Box{Text: nil}))
        Console.WriteLine(Check(nil))
    }
}`
        let program = fixture.Compile(source, "Forms6042", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "safe" + Environment.NewLine + "nil" + Environment.NewLine + "nil" + Environment.NewLine
            ),
            fixture.RunBytes(program)
        )
    }

    @Theory
    @InlineData("if value?.Text == nil { return \"nil\" }")
    @InlineData("if nil == value?.Text { return \"nil\" }")
    @InlineData("if value?.Text is nil { return \"nil\" }")
    @InlineData("if value?.Text == nil { throw Exception(\"stop\") }")
    func EarlyExitGuard_ProvesReceiverAfterIf(guardStmt string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Box {
    var Text string? = "safe"
}
shared class P {
    func Check(value Box?) string {
        try {
            ` + guardStmt + `
            return value.Text ?? "none"
        } catch {
            return "nil"
        }
    }
    func Main() {
        Console.WriteLine(Check(Box()))
        Console.WriteLine(Check(Box{Text: nil}))
        Console.WriteLine(Check(nil))
    }
}`
        let program = fixture.Compile(source, "Exit6042", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "safe" + Environment.NewLine + "nil" + Environment.NewLine + "nil" + Environment.NewLine
            ),
            fixture.RunBytes(program)
        )
    }

    @Theory
    @InlineData("continue")
    @InlineData("break")
    @InlineData("goto Done")
    func LoopAndGotoEarlyExit_ProvesReceiverAfterGuard(exitStmt string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Box {
    var Text string? = "safe"
}
shared class P {
    func Check(value Box?) string {
        for var i = 0; i < 1; i++ {
            if value?.Text == nil { ` + exitStmt + ` }
            return value.Text ?? "none"
        }
        Done:
        return "nil"
    }
    func Main() {
        Console.WriteLine(Check(Box()))
        Console.WriteLine(Check(nil))
    }
}`
        let program = fixture.Compile(source, "LoopExit6042", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes("safe" + Environment.NewLine + "nil" + Environment.NewLine),
            fixture.RunBytes(program)
        )
    }

    @Theory
    @InlineData("return if value?.Text != nil { value.Text ?? \"none\" } else { \"nil\" }")
    @InlineData("return value?.Text != nil ? (value.Text ?? \"none\") : \"nil\"")
    @InlineData("return value?.Text == nil ? \"nil\" : (value.Text ?? \"none\")")
    @InlineData("return if value?.Text != nil && value.Text == \"safe\" { value.Text ?? \"none\" } else { \"nil\" }")
    @InlineData(
        "if value?.Text == nil || value.Text == \"safe\" { if value?.Text != nil { return value.Text ?? \"none\" } } return \"nil\""
    )
    func ConditionalExpressionAndShortCircuit_ProveReceiver(expr string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Box {
    var Text string? = "safe"
}
shared class P {
    func Check(value Box?) string {
        ` + expr + `
    }
    func Main() {
        Console.WriteLine(Check(Box()))
        Console.WriteLine(Check(Box{Text: nil}))
        Console.WriteLine(Check(nil))
    }
}`
        let program = fixture.Compile(source, "Expr6042", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "safe" + Environment.NewLine + "nil" + Environment.NewLine + "nil" + Environment.NewLine
            ),
            fixture.RunBytes(program)
        )
    }

    @Fact
    func NullConditionalIndexerAndDelegate_ProveReceiver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.Collections.Generic
shared class P {
    func CheckList(items List[string?]?) string {
        if items?[0] != nil {
            return items[0] ?? "none"
        }
        return "nil"
    }
    func CheckDelegate(fn ((int32) -> string?)?) string {
        if fn?(1) != nil {
            return fn(2) ?? "none"
        }
        return "nil"
    }
    func Main() {
        Console.WriteLine(CheckList(List[string?]{"safe"}))
        Console.WriteLine(CheckList(List[string?]{nil}))
        Console.WriteLine(CheckList(nil))
        Console.WriteLine(CheckDelegate((x int32) -> if x > 0 { "safe" } else { nil }))
        Console.WriteLine(CheckDelegate((x int32) -> default(string?)))
        Console.WriteLine(CheckDelegate(nil))
    }
}`
        let program = fixture.Compile(source, "IndexDelegate6042", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "safe" +
                    Environment.NewLine +
                    "nil" +
                    Environment.NewLine +
                    "nil" +
                    Environment.NewLine +
                    "safe" +
                    Environment.NewLine +
                    "nil" +
                    Environment.NewLine +
                    "nil" +
                    Environment.NewLine
            ),
            fixture.RunBytes(program)
        )
    }

    @Theory
    @InlineData("property_stmt", "if value?.Self is { Label: \"safe\" } { return value.Label } return \"miss\"")
    @InlineData("property_conditional_expr", "return if value?.Text is { Length: 4 } { value.Label } else { \"miss\" }")
    @InlineData("list_stmt", "if value?.Parts is []string and [\"a\", \"b\"] { return value.Label } return \"miss\"")
    @InlineData(
        "list_short_circuit",
        "return if (value?.Parts is []string and [\"a\", \"b\"]) && value.Label == \"safe\" { value.Label } else { \"miss\" }"
    )
    @InlineData("relational_stmt", "if value?.Count is > 0 { return value.Label } return \"miss\"")
    @InlineData(
        "relational_short_circuit",
        "return if (value?.Count is >= 1) && value.Label == \"safe\" { value.Label } else { \"miss\" }"
    )
    @InlineData(
        "composed_and_stmt",
        "if value?.Text is not nil and { Length: 4 } { return value.Label } return \"miss\""
    )
    @InlineData("composed_or_stmt", "if value?.Count is 1 or 2 { return value.Label } return \"miss\"")
    @InlineData("composed_not_or_stmt", "if value?.Text is not (nil or \"\") { return value.Label } return \"miss\"")
    @InlineData(
        "class_generic_default",
        "return if CheckClass[string](value) != \"miss\" && value?.Text is not nil { value.Label } else { \"miss\" }"
    )
    func ConditionalAccessPatternKinds_ProveReceiverWithNilControlsAndConsumers(caseName string, body string) {
        let _ = caseName
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Box {
    var Label string = "safe"
    var Text string? = "safe"
    var Count int32? = 2
    var Parts []?string = []string{"a", "b"}
    var Item object? = "safe"
    prop Self Box { get -> this }
}
shared class P {
    func CheckClass[T class](b Box?) string {
        if b?.Item is not default(T) { return b.Label }
        return "miss"
    }
    func Check(value Box?) string {
        ` + body + `
    }
    func Main() {
        Console.WriteLine(Check(Box()))
        Console.WriteLine(Check(Box{Label: "other", Text: nil, Count: nil, Parts: nil, Item: nil}))
        Console.WriteLine(Check(nil))
    }
}`
        let program = fixture.Compile(source, "PatternKinds6042_" + caseName, executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "safe" + Environment.NewLine + "miss" + Environment.NewLine + "miss" + Environment.NewLine
            ),
            fixture.RunBytes(program)
        )
    }

    @Theory
    @InlineData("if a?.B?.Text != nil { return a.B.Text ?? \"none\" } return \"nil\"")
    @InlineData("return if a?.B?.Text != nil && a.B.Text == \"safe\" { a.B.Text ?? \"none\" } else { \"nil\" }")
    @InlineData("if a?.B?.Text == nil { return \"nil\" }\n        return a.B.Text ?? \"none\"")
    func ChainedNullConditional_NarrowsOuterAndStableIntermediateMember(body string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Inner {
    var Text string? = "safe"
}
class Outer {
    let B Inner?
    init(b Inner?) { B = b }
}
shared class P {
    func Check(a Outer?) string {
        ` + body + `
    }
    func Main() {
        Console.WriteLine(Check(Outer(Inner())))
        Console.WriteLine(Check(Outer(Inner{Text: nil})))
        Console.WriteLine(Check(Outer(nil)))
        Console.WriteLine(Check(nil))
    }
}`
        let program = fixture.Compile(source, "Chain6042", executable: true)
        IlVerifier.Verify(program)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "safe" +
                    Environment.NewLine +
                    "nil" +
                    Environment.NewLine +
                    "nil" +
                    Environment.NewLine +
                    "nil" +
                    Environment.NewLine
            ),
            fixture.RunBytes(program)
        )
    }

    @Fact
    func ChainedNullConditional_DoesNotNarrowUnstableIntermediateMember() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
class Inner {
    var Text string? = "safe"
}
class Outer {
    var B Inner?
    init(b Inner?) { B = b }
}
shared class P {
    func Check(a Outer?) {
        if a?.B?.Text != nil {
            Console.WriteLine(a.B.Text)
        }
    }
}`
        let (code, diagnostics) = fixture.TryCompile(source, "UnstableChain6042", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("(12,35,12,39): error GS0158", diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("equals_nil_positive_branch", `import System
class Box { var Text string? = "safe" }
shared class P {
    func Check(value Box?) {
        if value?.Text == nil {
            Console.WriteLine(value.Text)
        }
    }
}`, 6)
    @InlineData("is_nil_positive_branch", `import System
class Box { var Text string? = "safe" }
shared class P {
    func Check(value Box?) {
        if value?.Text is nil {
            Console.WriteLine(value.Text)
        }
    }
}`, 6)
    @InlineData("equals_nil_non_exiting_fallthrough", `import System
class Box { var Text string? = "safe" }
shared class P {
    func Check(value Box?) {
        if value?.Text == nil { }
        Console.WriteLine(value.Text)
    }
}`, 6)
    @InlineData("not_equals_nil_fallthrough", `import System
class Box { var Text string? = "safe" }
shared class P {
    func Check(value Box?) {
        if value?.Text != nil { }
        Console.WriteLine(value.Text)
    }
}`, 6)
    @InlineData("mutating_getter_invalidates", `import System
class Box {
    shared { var Clear (() -> void)? }
    var Text string? = "safe"
    prop MutatingText string? {
        get {
            Clear?()
            return "safe"
        }
    }
}
shared class P {
    func Check() {
        var value Box? = Box()
        Box.Clear = func() { value = nil }
        if value?.MutatingText != nil {
            Console.WriteLine(value.Text)
        }
    }
}`, 17)
    @InlineData("mutating_ref_method_invalidates", `import System
class Box {
    var Text string? = "safe"
    func ClearAndGet(ref target Box?) string? {
        target = nil
        return "safe"
    }
}
shared class P {
    func Check() {
        var value Box? = Box()
        if value?.ClearAndGet(ref value) != nil {
            Console.WriteLine(value.Text)
        }
    }
}`, 13)
    @InlineData("mutating_index_argument_invalidates", `import System
import System.Collections.Generic
shared class P {
    func Check() {
        var items List[string?]? = List[string?]{"safe"}
        let clear = func() int32 {
            items = nil
            return 0
        }
        if items?[clear()] != nil {
            Console.WriteLine(items.Count)
        }
    }
}`, 11)
    @InlineData("mutating_property_pattern_invalidates", `import System
class Box {
    shared { var Clear (() -> void)? }
    var Text string? = "safe"
    prop Self Box { get -> this }
    prop MutatingFlag bool {
        get {
            Clear?()
            return true
        }
    }
}
shared class P {
    func Check() {
        var value Box? = Box()
        Box.Clear = func() { value = nil }
        if value?.Self is { MutatingFlag: true } {
            Console.WriteLine(value.Text)
        }
    }
}`, 18)
    @InlineData("mutating_chained_method_invalidates", `import System
class Inner {
    shared { var Clear (() -> void)? }
    var Text string? = "safe"
    func Mutate() string? {
        Clear?()
        return "safe"
    }
}
class Outer {
    let B Inner? = Inner()
}
shared class P {
    func Check() {
        var a Outer? = Outer()
        Inner.Clear = func() { a = nil }
        if a?.B?.Mutate() != nil {
            Console.WriteLine(a.B.Text)
        }
    }
}`, 18)
    @InlineData("mutable_field_receiver_not_narrowed", `import System
class Box { var Text string? = "safe" }
class Holder {
    var box Box? = Box()
    func Check() {
        if this.box?.Text != nil {
            Console.WriteLine(this.box.Text)
        }
    }
}`, 7)
    @InlineData("unconstrained_generic_default_not_nil_pattern", `import System
class Box { var Item object? = 1 }
shared class P {
    func Check[T](b Box?) {
        if b?.Item is not default(T) {
            Console.WriteLine(b.Item)
        }
    }
}`, 6)
    @InlineData("unconstrained_generic_default_else_branch", `import System
class Box { var Item object? = 1 }
shared class P {
    func Check[T](b Box?) {
        if b?.Item is default(T) { } else {
            Console.WriteLine(b.Item)
        }
    }
}`, 6)
    func NegativeControls_ReportGS0158(caseName string, source string, expectedLine int32) {
        let _ = caseName
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, diagnostics) = fixture.TryCompile(source, "Neg6042_" + caseName, executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("(${expectedLine},", diagnostics, StringComparison.Ordinal)
        Assert.Contains("error GS0158", diagnostics, StringComparison.Ordinal)
    }
}
