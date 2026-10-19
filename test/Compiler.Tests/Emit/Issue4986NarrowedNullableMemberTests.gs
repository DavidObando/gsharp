// <copyright file="Issue4986NarrowedNullableMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #4986: a smart cast narrows `n int32?` to `int32`, which has no
/// `Value`, `HasValue` or `GetValueOrDefault`. `n != nil ? n.Value : 0`
/// compiled in 0.4.1270 and 0.5.7 because the ternary did not narrow; once it
/// did (#4964) the C# idiom stopped compiling, and the if-forms had never
/// accepted it. A member access on a narrowed value-type nullable now binds
/// against the `Nullable<T>` storage when the narrowed type has no member of
/// that name, in every narrowing region. A member the narrowed type does
/// have keeps binding to it.
///
/// Every program goes through the real driver, ilverify and a run, so a
/// read that skipped the `Nullable<T>` storage or the unwrap fails here.
open class Issue4986NarrowedNullableMemberTests {
    /// `int32?` through every narrowing form that narrows a value-type
    /// nullable: `?:` (both guards), the if-expression, the if-statement,
    /// an early return, and a `||` early exit. `&&` does not narrow a
    /// value-type nullable (#4969) and is covered to show it still binds.
    @Fact
    func Int32_Nullable_Members_Bind_In_Every_Narrowing_Form() {
        let result = CompileAndRun(`import System
func ternary(n int32?) int32 -> n != nil ? n.Value : 0
func ternaryElse(n int32?) bool -> n == nil ? false : n.HasValue
func ternaryDefault(n int32?) int32 -> n != nil ? n.GetValueOrDefault() + n.GetValueOrDefault(7) : -1
func ifExpression(n int32?) int32 -> if n != nil { n.Value * 2 } else { -1 }
func ifStatement(n int32?) string {
    if n != nil {
        return "${n.Value} ${n.HasValue} ${n.GetValueOrDefault(9)}"
    }
    return "none"
}
func earlyReturn(n int32?) int32 {
    if n == nil {
        return -1
    }
    return n.Value + n.GetValueOrDefault()
}
func orExit(n int32?, stop bool) int32 {
    if n == nil || stop {
        return -1
    }
    return n.Value + 100
}
func andGuard(n int32?) bool -> n != nil && n.Value > 0
Console.WriteLine("${ternary(3)} ${ternary(nil)} ${ternaryElse(3)} ${ternaryElse(nil)} ${ternaryDefault(4)} ${ternaryDefault(nil)}")
Console.WriteLine("${ifExpression(5)} ${ifExpression(nil)} ${ifStatement(6)} ${ifStatement(nil)}")
Console.WriteLine("${earlyReturn(7)} ${earlyReturn(nil)} ${orExit(1, false)} ${orExit(1, true)} ${andGuard(2)} ${andGuard(nil)}")
`)
        Assert.Equal(
            string.Join(Environment.NewLine, "3 0 True False 8 -1", "10 -1 6 True 6 none", "14 -1 101 -1 True False") +
                Environment.NewLine,
            result.Output
        )
    }

    /// A CLR enum and a CLR struct (`DayOfWeek?`, `TimeSpan?`) take the same
    /// path as `int32?`, including a member chained after `Value`.
    @Fact
    func Clr_Enum_And_Struct_Nullable_Members_Bind_When_Narrowed() {
        let result = CompileAndRun(`import System
func day(d DayOfWeek?) string -> d != nil ? d.Value.ToString() + "/" + d.HasValue.ToString() : "none"
func span(t TimeSpan?) int32 {
    if t != nil {
        return t.Value.Seconds + t.GetValueOrDefault().Minutes
    }
    return -1
}
func spanDefault(t TimeSpan?) int32 -> if t == nil { -1 } else { t.GetValueOrDefault(TimeSpan.Zero).Hours }
Console.WriteLine("${day(DayOfWeek.Monday)} ${day(nil)} ${span(TimeSpan(0, 2, 5))} ${span(nil)} ${spanDefault(TimeSpan(3, 0, 0))}")
`)
        Assert.Equal("Monday/True none 7 -1 3" + Environment.NewLine, result.Output)
    }

    /// A same-compilation struct and enum have no CLR type while binding.
    /// Their `Value` and `HasValue` bind against the open `Nullable<>` and
    /// emit a MemberRef parented at the constructed `Nullable<T>`, narrowed or
    /// not. (Before, `p.Value` on a user `Point?` reported GS0158 even
    /// without a guard.)
    @Fact
    func User_Struct_And_Enum_Nullable_Value_And_HasValue_Bind() {
        let result = CompileAndRun(`import System
struct Point {
    var X int32
    var Y int32
}
enum Color { Red, Green }
func plain(p Point?) int32 -> p.Value.X + (if p.HasValue { 10 } else { 0 })
func plainEnum(c Color?) bool -> c.HasValue
func ternary(p Point?) int32 -> p != nil ? p.Value.X + p.Value.Y : -1
func ternaryEnum(c Color?) bool -> c == nil ? false : c.HasValue
func ifStatement(c Color?) string {
    if c != nil {
        return c.Value.ToString()
    }
    return "none"
}
func earlyReturn(p Point?) int32 {
    if p == nil {
        return -1
    }
    return p.Value.Y
}
Console.WriteLine("${plain(Point{X: 2, Y: 3})} ${plainEnum(Color.Green)} ${plainEnum(nil)}")
Console.WriteLine("${ternary(Point{X: 2, Y: 3})} ${ternary(nil)} ${ternaryEnum(Color.Red)} ${ifStatement(Color.Green)} ${ifStatement(nil)} ${earlyReturn(Point{X: 1, Y: 7})}")
`)
        Assert.Equal(
            string.Join(Environment.NewLine, "12 True False", "5 -1 True Green none 7") + Environment.NewLine,
            result.Output
        )
    }

    /// A `struct`-constrained type parameter's `T?` binds `Value` and
    /// `HasValue` against the open `Nullable<>`, and its getter goes through
    /// the same constructed-`Nullable<T>` MemberRef as a same-compilation
    /// struct's, guarded or not. The if-statement and early-return forms
    /// reported GS0158 before. (`GetValueOrDefault` on `T?` is #5001.)
    @Fact
    func Struct_Constrained_Type_Parameter_Nullable_Members_Bind() {
        let result = CompileAndRun(`import System
func has[T struct](x T?) bool -> x.HasValue
func val[T struct](x T?) T -> x.Value
func ternary[T struct](x T?, fallback T) T -> x != nil ? x.Value : fallback
func statement[T struct](x T?) string {
    if x != nil {
        return "${x.Value}/${x.HasValue}"
    }
    return "none"
}
func early[T struct](x T?) bool {
    if x == nil {
        return false
    }
    return x.HasValue
}
Console.WriteLine("${has[int32](3)} ${has[int32](nil)} ${val[int32](4)} ${ternary[int32](5, -1)} ${ternary[int32](nil, -1)}")
Console.WriteLine("${statement[DayOfWeek](DayOfWeek.Friday)} ${statement[int32](nil)} ${early[int64](7)} ${early[int64](nil)}")
`)
        Assert.Equal(
            string.Join(Environment.NewLine, "True False 4 5 -1", "Friday/True none True False") + Environment.NewLine,
            result.Output
        )
    }

    /// A member the narrowed type declares itself wins: `Box` has its own
    /// `Value`, so `b.Value` in the proven branch is `Box.Value` (an
    /// `int32`), not `Nullable<Box>.Value` (a `Box`).
    @Fact
    func A_Member_Of_The_Narrowed_Type_Keeps_Binding_To_It() {
        let result = CompileAndRun(`import System
struct Box {
    var Value int32
}
func ternary(b Box?) int32 -> b != nil ? b.Value : 0
func ifStatement(b Box?) int32 {
    if b != nil {
        return b.Value + 1
    }
    return 0
}
Console.WriteLine("${ternary(Box{Value: 8})} ${ternary(nil)} ${ifStatement(Box{Value: 4})}")
`)
        Assert.Equal("8 0 5" + Environment.NewLine, result.Output)
    }

    /// A lambda argument executes once when the member uses nullable storage.
    @Fact
    func A_Lambda_Argument_Executes_Once() {
        let result = CompileAndRun(`import System
func run(f () -> int32) int32 {
    calls = calls + 1
    return f()
}
func pick(n int32?) int32 -> n != nil ? n.GetValueOrDefault(run(() -> 40)) : run(() -> 1)
func pickStatement(n int32?) int32 {
    if n != nil {
        return n.GetValueOrDefault(run(() -> 50)) + run(() -> 0)
    }
    return run(() -> 2)
}
var calls = 0
Console.WriteLine("${pick(2)} ${pick(nil)} ${pickStatement(3)} ${pickStatement(nil)} ${calls}")
`)
        Assert.Equal("2 1 3 2 5" + Environment.NewLine, result.Output)
    }

    /// The fallback is decided by looking the name up, not by binding and
    /// watching for a missing-member error. So a member the narrowed type
    /// declares keeps the binding, and its own overload error, even when no
    /// overload applies: `Meter` declares only `GetValueOrDefault(int)`, and
    /// `n.GetValueOrDefault()` must not quietly become
    /// `Nullable<Meter>.GetValueOrDefault()`.
    @Fact
    func An_Inapplicable_Member_Of_The_Narrowed_Type_Is_Not_Replaced() {
        using let fixture = CSharpFixture(
            "namespace Fixture4986 { public struct Meter { public int V; public int GetValueOrDefault(int x) => x + V; } }"
        )
        let rejected = Compile(`import Fixture4986
func pick(n Meter?) Meter -> n != nil ? n.GetValueOrDefault() : Meter()
`, fixture.AssemblyPath)
        Assert.NotEqual(0, rejected.ExitCode)
        Assert.DoesNotContain("GS0113", rejected.Output, StringComparison.Ordinal)
        Assert.True(
            Regex.IsMatch(rejected.Output, `\(2,43,2,62\): error GS0159: [^\n]*GetValueOrDefault`),
            rejected.Output
        )
        let accepted = Compile(`import Fixture4986
func pick(n Meter?) int32 -> n != nil ? n.GetValueOrDefault(3) : 0
`, fixture.AssemblyPath)
        Assert.True(accepted.ExitCode == 0, accepted.Output)
    }

    /// A CLR type's own member wins too (`KeyValuePair.Value` is the pair's
    /// value, not the pair), and an imported extension of the same name that
    /// cannot take the narrowed type (`CollectionExtensions.GetValueOrDefault`
    /// on a dictionary) does not block the fallback.
    @Fact
    func Clr_Members_And_Inapplicable_Extensions_Are_Told_Apart() {
        let result = CompileAndRun(`import System
import System.Collections.Generic
func pairValue(p KeyValuePair[string, int32]?) int32 -> p != nil ? p.Value : -1
func withCollections(n int32?) int32 {
    if n != nil {
        return n.GetValueOrDefault() + n.GetValueOrDefault(defaultValue: 0) + 1
    }
    return 0
}
Console.WriteLine("${pairValue(KeyValuePair[string, int32]("a", 7))} ${pairValue(nil)} ${withCollections(4)} ${withCollections(nil)}")
`)
        Assert.Equal("7 -1 9 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Named_Tuple_Elements_Keep_Precedence_Over_Nullable_Storage() {
        let result = CompileAndRun(`import System
func direct(t (HasValue bool, X int32)) bool -> t.HasValue
func ternary(t (HasValue bool, X int32)?) bool -> t != nil ? t.HasValue : false
func expression(t (HasValue bool, X int32)?) bool -> if t != nil { t.HasValue } else { false }
func statement(t (HasValue bool, X int32)?) bool {
    if t != nil { return t.HasValue }
    return false
}
Console.WriteLine("${direct((false, 1))} ${ternary((false, 1))} ${expression((false, 1))} ${statement((false, 1))} ${ternary((true, 1))} ${expression((true, 1))} ${statement((true, 1))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`)
        Assert.Equal("False False False False True True True False False False" + Environment.NewLine, result.Output)
    }

    @Fact
    func Imported_Extension_Receiver_Conversions_Keep_The_Narrowed_Binding() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Meter {
        public static implicit operator long(Meter value) => 1;
    }
    public static class Extensions {
        public static int GetValueOrDefault(this long value) => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n int32) int32 -> n.GetValueOrDefault()
func narrowed(n int32?) int32 -> n != nil ? n.GetValueOrDefault() : 0
func directMeter(n Meter) int32 -> n.GetValueOrDefault()
func narrowedMeter(n Meter?) int32 -> n != nil ? n.GetValueOrDefault() : 0
Console.WriteLine("${direct(5)} ${narrowed(5)} ${narrowed(nil)} ${directMeter(Meter())} ${narrowedMeter(Meter())} ${narrowedMeter(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 0 99 99 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Imported_Generic_Struct_Extension_Receivers_Keep_The_Narrowed_Binding() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public static class Extensions {
        public static int GetValueOrDefault<T>(this System.Collections.Generic.KeyValuePair<T, int> value) => value.Value + 100;
    }
}`)
        let result = CompileAndRun(`import System
import System.Collections.Generic
import Fixture4986
func direct(n KeyValuePair[string, int32]) int32 -> n.GetValueOrDefault()
func narrowed(n KeyValuePair[string, int32]?) int32 -> n != nil ? n.GetValueOrDefault() : -1
let pair = KeyValuePair[string, int32]("a", 7)
Console.WriteLine("${direct(pair)} ${narrowed(pair)} ${narrowed(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("107 107 -1" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("public static int GetValueOrDefault(this System.Enum value) => 99;")
    @InlineData("public static int GetValueOrDefault<T>(this T value) where T : class => 99;")
    func Incompatible_Imported_Extension_Receivers_Do_Not_Block_Storage(method string) {
        using let fixture = CSharpFixture("namespace Fixture4986 { public static class Extensions { " + method + " } }")
        let result = CompileAndRun(`import System
import Fixture4986
func narrowed(n int32?) int32 -> n != nil ? n.GetValueOrDefault() : 0
Console.WriteLine("${narrowed(7)} ${narrowed(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Other_Arguments_And_Explicit_Type_Arguments_Can_Widen_Receiver_Bounds() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public static class Extensions {
        public static int GetValueOrDefault<T>(this T value) where T : class => 81;
        public static int GetValueOrDefault<T>(this T value, T other) where T : class => 91;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func explicitPick(n int32?) int32 -> n != nil ? n.GetValueOrDefault[object]() : 0
func argument(n int32?) int32 -> n != nil ? n.GetValueOrDefault(Object()) : 0
Console.WriteLine("${explicitPick(7)} ${argument(7)} ${explicitPick(nil)} ${argument(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("81 91 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Other_Arguments_Can_Complete_Nullable_Extension_Receiver_Inference() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public static class Extensions {
        public static int GetValueOrDefault<T>(this T? value, T fallback) where T : struct => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n int32) int32 -> n.GetValueOrDefault(0)
func narrowed(n int32?) int32 -> n != nil ? n.GetValueOrDefault(0) : 0
func named(n int32?) int32 -> n != nil ? n.GetValueOrDefault(fallback: 0) : 0
func statement(n int32?) int32 {
    if n != nil { return n.GetValueOrDefault(0) }
    return 0
}
Console.WriteLine("${direct(7)} ${narrowed(7)} ${statement(7)} ${named(7)} ${narrowed(nil)} ${statement(nil)} ${named(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Other_Arguments_Can_Complete_Converted_Generic_Extension_Receiver_Inference() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Meter {
        public static implicit operator System.Collections.Generic.KeyValuePair<string, int>(Meter value) => default;
    }
    public static class Extensions {
        public static int GetValueOrDefault<T>(this System.Collections.Generic.KeyValuePair<T, int> value, T fallback) => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n Meter) int32 -> n.GetValueOrDefault("")
func narrowed(n Meter?) int32 -> n != nil ? n.GetValueOrDefault("") : 0
func statement(n Meter?) int32 {
    if n != nil { return n.GetValueOrDefault("") }
    return 0
}
Console.WriteLine("${direct(Meter())} ${narrowed(Meter())} ${statement(Meter())} ${narrowed(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("System.Collections.Generic.List<T>")
    @InlineData("System.Collections.Generic.IEnumerable<T>")
    @InlineData("T[]")
    func Impossible_Open_Generic_Receivers_Do_Not_Block_Storage(receiver string) {
        using let fixture = CSharpFixture(
            "namespace Fixture4986 { public static class Extensions { public static int GetValueOrDefault<T>(this " +
                receiver +
                " value, T fallback) => 99; } }"
        )
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n int32?) int32 -> n != nil ? n.GetValueOrDefault(0) : 0
func named(n int32?) int32 -> n != nil ? n.GetValueOrDefault(defaultValue: 0) : 0
func expression(n int32?) int32 -> if n != nil { n.GetValueOrDefault(0) } else { 0 }
func statement(n int32?) int32 {
    if n != nil { return n.GetValueOrDefault(0) }
    return 0
}
Console.WriteLine("${ternary(7)} ${expression(7)} ${statement(7)} ${named(7)} ${ternary(nil)} ${expression(nil)} ${statement(nil)} ${named(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 7 7 0 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("U")
    @InlineData("T")
    func Unrepairable_Receiver_Constraints_Do_Not_Block_Storage(fallbackType string) {
        using let fixture = CSharpFixture(
            "namespace Fixture4986 { public static class Extensions { public static int GetValueOrDefault<T,U>(" +
                "this System.Collections.Generic.KeyValuePair<T,U> value, " +
                fallbackType +
                " fallback) where T : class => 99; } }"
        )
        let result = CompileAndRun(`import System
import System.Collections.Generic
import Fixture4986
func ternary(n KeyValuePair[int32, int32]?) int32 -> n != nil ? n.GetValueOrDefault(default(KeyValuePair[int32, int32])).Value : 0
func expression(n KeyValuePair[int32, int32]?) int32 -> if n != nil { n.GetValueOrDefault(default(KeyValuePair[int32, int32])).Value } else { 0 }
func statement(n KeyValuePair[int32, int32]?) int32 {
    if n != nil { return n.GetValueOrDefault(default(KeyValuePair[int32, int32])).Value }
    return 0
}
let pair = KeyValuePair[int32, int32](1, 7)
Console.WriteLine("${ternary(pair)} ${expression(pair)} ${statement(pair)} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 7 0 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Inferred_Receiver_Conversions_Use_The_Closed_Symbolic_Parameter() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public static class Extensions {
        public static (int, int) GetValueOrDefault<T>(this (long, T) value) => (99, 99);
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n (int32, int32)) int32 -> n.GetValueOrDefault().Item1
func ternary(n (int32, int32)?) int32 -> n != nil ? n.GetValueOrDefault().Item1 : 0
func expression(n (int32, int32)?) int32 -> if n != nil { n.GetValueOrDefault().Item1 } else { 0 }
func statement(n (int32, int32)?) int32 {
    if n != nil { return n.GetValueOrDefault().Item1 }
    return 0
}
Console.WriteLine("${direct((1, 2))} ${ternary((1, 2))} ${expression((1, 2))} ${statement((1, 2))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("int", "string")
    @InlineData("string", "object")
    func Invariant_Operator_Output_Arguments_Do_Not_Block_Storage(sourceArgument string, targetArgument string) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Meter {
        public int V;
        public Meter(int value) { V = value; }
        public static implicit operator System.Collections.Generic.KeyValuePair<string, ` + sourceArgument + `>(Meter value) => default;
    }
    public static class Extensions {
        public static int GetValueOrDefault<T>(this System.Collections.Generic.KeyValuePair<T, ` + targetArgument + `> value, T fallback) => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n Meter?) int32 -> n != nil ? n.GetValueOrDefault(Meter()).V : 0
func expression(n Meter?) int32 -> if n != nil { n.GetValueOrDefault(Meter()).V } else { 0 }
func statement(n Meter?) int32 {
    if n != nil { return n.GetValueOrDefault(Meter()).V }
    return 0
}
Console.WriteLine("${ternary(Meter(7))} ${expression(Meter(7))} ${statement(Meter(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 7 0 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Other_Arguments_Can_Widen_Interface_Bounds_To_Object() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Probe : System.Collections.Generic.IEnumerable<System.ICloneable> {
        public System.Collections.Generic.IEnumerator<System.ICloneable> GetEnumerator() => throw new System.NotImplementedException();
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
    public static class Extensions {
        public static int GetValueOrDefault<T>(this System.Collections.Generic.IEnumerable<T> value, T fallback) where T : new() => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n Probe) int32 -> n.GetValueOrDefault(Object())
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Object()) : 0
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Object()) }
    return 0
}
Console.WriteLine("${direct(Probe())} ${ternary(Probe())} ${statement(Probe())} ${ternary(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("Input<U>", "Input[int32]", "Input[int32](7)", "Token(), 0", "T")
    @InlineData(
        "System.Collections.Generic.KeyValuePair<T,int>",
        "KeyValuePair[string,int32]",
        "KeyValuePair[string,int32](\"x\", 7)",
        "\"\", Token()",
        "U"
    )
    func Operator_Input_Independence_Is_Per_Type_Parameter(
        input string,
        receiverType string,
        present string,
        arguments string,
        constrainedParameter string
    ) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Input<T> { public int V; public Input(int value) { V = value; } }
    public struct Token : System.IDisposable { public void Dispose() {} }
    public struct Box<T,U> {
        public static implicit operator Box<T,U>(` + input + ` value) => default;
    }
    public static class Extensions {
        public static int GetValueOrDefault<T,U>(this Box<T,U> value, T fallback, U other)
            where ` + constrainedParameter + ` : struct, System.IDisposable => 99;
    }
}`)
        let result = CompileAndRun(`import System
import System.Collections.Generic
import Fixture4986
func direct(n RECEIVER) int32 -> n.GetValueOrDefault(ARGUMENTS)
func ternary(n RECEIVER?) int32 -> n != nil ? n.GetValueOrDefault(ARGUMENTS) : 0
func expression(n RECEIVER?) int32 -> if n != nil { n.GetValueOrDefault(ARGUMENTS) } else { 0 }
func statement(n RECEIVER?) int32 {
    if n != nil { return n.GetValueOrDefault(ARGUMENTS) }
    return 0
}
let present = PRESENT
Console.WriteLine("${direct(present)} ${ternary(present)} ${expression(present)} ${statement(present)} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`.Replace("RECEIVER", receiverType).Replace("ARGUMENTS", arguments).Replace("PRESENT", present), fixture.AssemblyPath)
        Assert.Equal("99 99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("", "0")
    @InlineData("where T : System.IDisposable, new()", "System.IO.MemoryStream()")
    @InlineData("where T : struct, System.IDisposable", "Token()")
    @InlineData("where T : struct, System.Enum", "DayOfWeek.Monday")
    func Other_Arguments_Complete_Target_Declared_Conversion_Bounds(constraint string, fallback string) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Box<T> {
        public static implicit operator Box<T>(int value) => default;
    }
    public struct Token : System.IDisposable {
        public void Dispose() {}
    }
    public static class Extensions {
        public static int GetValueOrDefault<T>(this Box<T> value, T fallback) ` + constraint + ` => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n int32) int32 -> n.GetValueOrDefault(FALLBACK)
func ternary(n int32?) int32 -> n != nil ? n.GetValueOrDefault(FALLBACK) : 0
func expression(n int32?) int32 -> if n != nil { n.GetValueOrDefault(FALLBACK) } else { 0 }
func statement(n int32?) int32 {
    if n != nil { return n.GetValueOrDefault(FALLBACK) }
    return 0
}
Console.WriteLine("${direct(7)} ${ternary(7)} ${expression(7)} ${statement(7)} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`.Replace("FALLBACK", fallback), fixture.AssemblyPath)
        Assert.Equal("99 99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Free_Operator_Output_Constraints_Substitute_Known_Input_Bounds() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Input<U> {}
    public struct Box<T,U> {
        public static implicit operator Box<T,U>(Input<U> value) => default;
    }
    public static class Extensions {
        public static int GetValueOrDefault<T,U>(this Box<T,U> value, T fallback, U other)
            where T : struct, System.IComparable<U> => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n Input[int32]) int32 -> n.GetValueOrDefault(0, 0)
func ternary(n Input[int32]?) int32 -> n != nil ? n.GetValueOrDefault(0, 0) : 0
func expression(n Input[int32]?) int32 -> if n != nil { n.GetValueOrDefault(0, 0) } else { 0 }
func statement(n Input[int32]?) int32 {
    if n != nil { return n.GetValueOrDefault(0, 0) }
    return 0
}
Console.WriteLine("${direct(Input[int32]())} ${ternary(Input[int32]())} ${expression(Input[int32]())} ${statement(Input[int32]())} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("Token", true)
    @InlineData("string", false)
    func Fixed_Operator_Input_Bounds_Preserve_Free_Output_Obligations(element string, applicable bool) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IBounds<T,U> {}
    public struct Token : System.IDisposable { public void Dispose() {} }
    public struct Input<U> : IBounds<Token,U> { public int V; public Input(int v) { V = v; } }
    public struct Box<T,U> {
        public static implicit operator Box<T,U>(Input<U> value) => default;
    }
    public static class Extensions {
        public static Input<U> GetValueOrDefault<T,U>(this Box<T,U> value, IBounds<T,U> fallback)
            where T : struct, System.IDisposable where U : System.Collections.Generic.IComparer<T> => new Input<U>(99);
    }
}`)
        let direct = if applicable {
            "func direct(n Receiver) int32 -> n.GetValueOrDefault(Receiver()).V\nConsole.WriteLine(direct(Receiver(7)))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import System.Collections.Generic
import Fixture4986
func ternary(n Receiver?) int32 -> n != nil ? n.GetValueOrDefault(Receiver()).V : 0
func expression(n Receiver?) int32 -> if n != nil { n.GetValueOrDefault(Receiver()).V } else { 0 }
func statement(n Receiver?) int32 {
    if n != nil { return n.GetValueOrDefault(Receiver()).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Receiver(7))} ${expression(Receiver(7))} ${statement(Receiver(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct).Replace("Receiver", "Input[Comparer[" + element + "]]"), fixture.AssemblyPath)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Fact
    func Impossible_Free_Output_Constraint_Does_Not_Block_Storage() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IBounds<T,U> {}
    public struct Token : System.IDisposable { public void Dispose() {} }
    public struct Input<U> : IBounds<Token,U> { public int V; public Input(int v) { V = v; } }
    public struct Box<T,U> {
        public static implicit operator Box<T,U>(Input<U> value) => default;
    }
    public static class Extensions {
        public static int GetValueOrDefault<T,U>(this Box<T,U> value, IBounds<T,U> fallback)
            where T : U, System.IDisposable => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n Input[string]?) int32 -> n != nil ? n.GetValueOrDefault(Input[string]()).V : 0
func expression(n Input[string]?) int32 -> if n != nil { n.GetValueOrDefault(Input[string]()).V } else { 0 }
func statement(n Input[string]?) int32 {
    if n != nil { return n.GetValueOrDefault(Input[string]()).V }
    return 0
}
Console.WriteLine("${ternary(Input[string](7))} ${expression(Input[string](7))} ${statement(Input[string](7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 7 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData(
        "in T,in U",
        "object,object",
        "System.IO.MemoryStream,System.IO.MemoryStream",
        "where T : U where U : System.IDisposable"
    )
    @InlineData(
        "in T,in U",
        "System.Collections.Generic.List<string>,object",
        "System.Collections.Generic.List<string>,string",
        "where T : System.Collections.Generic.List<U>"
    )
    @InlineData(
        "T,in U",
        "System.Collections.Generic.List<string>,object",
        "System.Collections.Generic.List<string>,string",
        "where T : System.Collections.Generic.List<U>"
    )
    @InlineData(
        "in T,in U",
        "object,object",
        "System.Collections.Generic.List<string>,string",
        "where T : System.Collections.Generic.List<U>"
    )
    @InlineData(
        "in T,in U",
        "System.Collections.Generic.List<string>,object",
        "DerivedList<string>,string",
        "where T : DerivedList<U>"
    )
    @InlineData(
        "in T,in U",
        "System.Collections.Generic.List<System.Collections.Generic.List<string>>,object",
        "System.Collections.Generic.List<System.Collections.Generic.List<string>>,string",
        "where T : System.Collections.Generic.List<System.Collections.Generic.List<U>>"
    )
    @InlineData(
        "in T,in U",
        "System.Collections.Generic.List<string[]>,object",
        "System.Collections.Generic.List<string[]>,string",
        "where T : System.Collections.Generic.List<U[]>"
    )
    @InlineData(
        "in T,in U",
        "System.IO.Stream,object",
        "System.IO.MemoryStream,System.IO.MemoryStream",
        "where T : U where U : System.IO.Stream"
    )
    func Dependent_Receiver_Bounds_Can_Refine_Together(
        variance string,
        receiverArguments string,
        fallbackArguments string,
        constraints string
    ) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public class DerivedList<T> : System.Collections.Generic.List<T> {}
    public interface IProbe<` + variance + `> {}
    public interface IBounds<in T,in U> {}
    public struct Probe : IProbe<` + receiverArguments + `>, IBounds<` + fallbackArguments + `> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T,U>(this IProbe<T,U> value, IBounds<T,U> fallback)
            ` + constraints + ` => new Probe(99);
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n Probe) int32 -> n.GetValueOrDefault(Probe()).V
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Probe()).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
Console.WriteLine("${direct(Probe(7))} ${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("System.Exception,object", "where T : System.Collections.Generic.List<U>")
    @InlineData(
        "System.Collections.Generic.List<string>,System.IO.Stream",
        "where T : System.Collections.Generic.List<U>"
    )
    @InlineData("DerivedList<string>,System.IO.Stream", "where T : System.Collections.Generic.List<U>")
    @InlineData(
        "System.Collections.Generic.List<System.Exception>,object",
        "where T : System.Collections.Generic.List<System.Collections.Generic.List<U>>"
    )
    @InlineData(
        "System.Collections.Generic.List<System.Exception>,object",
        "where T : System.Collections.Generic.List<U[]>"
    )
    @InlineData("System.Exception,object", "where T : U where U : System.IO.Stream")
    @InlineData("System.Exception,object", "where T : U where U : System.Collections.Generic.List<string>")
    func Impossible_Joint_Receiver_Bounds_Preserve_Nullable_Storage(receiverArguments string, constraints string) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public class DerivedList<T> : System.Collections.Generic.List<T> {}
    public interface IProbe<in T,in U> {}
    public interface IBounds<in T,in U> {}
    public struct Probe : IProbe<` + receiverArguments + `>, IBounds<object,object> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T,U>(this IProbe<T,U> value, IBounds<T,U> fallback)
            ` + constraints + ` => new Probe(99);
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Probe()).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 7 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("System.Exception", "string", "where T : System.Collections.Generic.List<U>")
    @InlineData("object", "string", "where T : System.IDisposable where U : T")
    @InlineData("object", "int", "where T : U")
    @InlineData(
        "object",
        "System.Collections.Generic.Comparer<string>",
        "where T : System.IDisposable where U : System.Collections.Generic.IComparer<T>"
    )
    func Dependent_Constraints_Preserve_Fixed_Argument_Obligations(
        bound string,
        fixedArgument string,
        constraints string
    ) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IProbe<in T, U> {}
    public struct Probe : IProbe<` + bound + `, ` + fixedArgument + `> {
        public int V;
        public Probe(int value) { V = value; }
    }
    public static class Extensions {
        public static int GetValueOrDefault<T,U>(this IProbe<T,U> value,
            System.Collections.Generic.IComparer<T> fallback) ` + constraints + ` => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Probe()).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 7 0 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Dependent_Contravariant_Constraints_Can_Refine_Unknown_Bounds() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IProbe<in T, U> {}
    public struct Probe : IProbe<object, System.Collections.Generic.Comparer<System.IO.MemoryStream>> {}
    public static class Extensions {
        public static int GetValueOrDefault<T,U>(this IProbe<T,U> value,
            System.Collections.Generic.IComparer<T> fallback) where T : System.IDisposable, new()
            where U : System.Collections.Generic.IComparer<T> => 99;
    }
}`)
        let result = CompileAndRun(`import System
import System.IO
import System.Collections.Generic
import Fixture4986
func direct(n Probe) int32 -> n.GetValueOrDefault(Comparer[MemoryStream].Default)
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Comparer[MemoryStream].Default) : 0
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Comparer[MemoryStream].Default) }
    return 0
}
Console.WriteLine("${direct(Probe())} ${ternary(Probe())} ${statement(Probe())} ${ternary(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("string", "System.IDisposable")
    @InlineData("System.IO.Stream", "System.Exception")
    func Impossible_Contravariant_Subtypes_Do_Not_Block_Storage(bound string, constraint string) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Probe : System.Collections.Generic.IComparer<` + bound + `> {
        public int V;
        public Probe(int value) { V = value; }
        public int Compare(` + bound + ` left, ` + bound + ` right) => 0;
    }
    public static class Extensions {
        public static int GetValueOrDefault<T>(this System.Collections.Generic.IComparer<T> value,
            System.Collections.Generic.IComparer<T> fallback) where T : ` + constraint + ` => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Probe()).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 7 0 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Possible_Subtypes_Do_Not_Mask_Other_Unrepairable_Constraints() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IProbe<in T, U> {}
    public struct Probe : IProbe<object, int> {
        public int V;
        public Probe(int value) { V = value; }
    }
    public static class Extensions {
        public static int GetValueOrDefault<T,U>(this IProbe<T,U> value,
            System.Collections.Generic.IComparer<T> fallback) where T : System.IDisposable where U : class => 99;
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
Console.WriteLine("${ternary(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("7 7 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("")
    @InlineData(", new()")
    func Other_Arguments_Refine_Contravariant_Receiver_Bounds(additionalConstraint string) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Probe : System.Collections.Generic.IComparer<object> {
        public int Compare(object left, object right) => 0;
    }
    public static class Extensions {
        public static int GetValueOrDefault<T>(this System.Collections.Generic.IComparer<T> value,
            System.Collections.Generic.IComparer<T> fallback) where T : System.IDisposable` + additionalConstraint + ` => 99;
    }
}`)
        let result = CompileAndRun(`import System
import System.IO
import System.Collections.Generic
import Fixture4986
func direct(n Probe) int32 -> n.GetValueOrDefault(Comparer[MemoryStream].Default)
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Comparer[MemoryStream].Default) : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Comparer[MemoryStream].Default) } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Comparer[MemoryStream].Default) }
    return 0
}
Console.WriteLine("${direct(Probe())} ${ternary(Probe())} ${expression(Probe())} ${statement(Probe())} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99 99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    /// A second argument bind hoisted another `out var`, reporting GS0102.
    @Fact
    func Arguments_Are_Bound_Once() {
        let result = CompileAndRun(`import System
func fallback(out x int32) int32 {
    x = 5
    return x
}
func declared(n int32?, o object) int32 -> n != nil ? n.GetValueOrDefault((o is string s) ? fallback(out var x) + s.Length : 0) : 0
Console.WriteLine("${declared(3, "z")} ${declared(nil, "z")}")
`)
        Assert.Equal("3 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func Open_Nonreceiver_Parameters_Retain_Dependent_Constraints(constructed bool, applicable bool) {
        let receiver = if constructed {
            "System.Collections.Generic.KeyValuePair<T,int>"
        } else {
            "T"
        }
        let constraints = if constructed {
            "where T : U where U : System.IO.Stream"
        } else {
            "where U : T, System.IDisposable"
        }
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Token : System.IDisposable {
        public int V; public Token(int v) { V = v; } public void Dispose() {}
    }
    public static class Extensions {
        public static ` + receiver + ` GetValueOrDefault<T,U>(this ` + receiver + ` value, U fallback)
            ` + constraints + ` => default;
    }
}`)
        let type = if constructed {
            if applicable {
                "KeyValuePair[System.IO.MemoryStream,int32]"
            } else {
                "KeyValuePair[string,int32]"
            }
        } else {
            if applicable {
                "Token"
            } else {
                "int32"
            }
        }
        let present = if constructed {
            type +
                "(" +
                (
                if applicable {
                    "System.IO.MemoryStream()"
                } else {
                    "\"\""
                }
            ) +
                ", 7)"
        } else {
            if applicable {
                "Token(7)"
            } else {
                "7"
            }
        }
        let fallback = if constructed {
            if applicable {
                "System.IO.MemoryStream()"
            } else {
                "default(" + type + ")"
            }
        } else {
            if applicable {
                "Token()"
            } else {
                "0"
            }
        }
        let read = if constructed {
            ".Value"
        } else {
            if applicable {
                ".V"
            } else {
                ""
            }
        }
        let direct = if applicable {
            "func direct(n RECEIVER) int32 -> n.GetValueOrDefault(FALLBACK)READ\nConsole.WriteLine(direct(PRESENT))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import System.Collections.Generic
import Fixture4986
func ternary(n RECEIVER?) int32 -> n != nil ? n.GetValueOrDefault(FALLBACK)READ : 0
func expression(n RECEIVER?) int32 -> if n != nil { n.GetValueOrDefault(FALLBACK)READ } else { 0 }
func statement(n RECEIVER?) int32 {
    if n != nil { return n.GetValueOrDefault(FALLBACK)READ }
    return 0
}
DIRECT
Console.WriteLine("${ternary(PRESENT)} ${expression(PRESENT)} ${statement(PRESENT)} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace(
                "DIRECT",
                direct
            ).Replace(
                "RECEIVER",
                type
            ).Replace("FALLBACK", fallback).Replace("READ", read).Replace("PRESENT", present), fixture.AssemblyPath)
        Assert.Equal(
            if applicable {
                "0" + Environment.NewLine + "0 0 0 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Theory
    @InlineData("none")
    @InlineData("fixed-input")
    @InlineData("dependent")
    func Impossible_Open_Receiver_Shapes_Are_Pruned_Before_Completion(mode string) {
        let (declaration, receiver, fallback, present, read) = switch mode {
            case "fixed-input": (`public struct Holder<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P> {
    public static implicit operator Holder<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P>(
        System.Collections.Generic.KeyValuePair<int,A> value) => default;
}
public static class Extensions {
    public static System.Collections.Generic.KeyValuePair<string,int> GetValueOrDefault<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P>(
        this Holder<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P> value,
        Holder<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P> fallback) => new("",99);
}`, "System.Collections.Generic.KeyValuePair[string,int32]", "default(System.Collections.Generic.KeyValuePair[string,int32])", "System.Collections.Generic.KeyValuePair[string,int32](\"\",7)", ".Value")
            case "dependent": (`public struct Input<U> { public int V; public Input(int v) { V = v; } }
public struct Box<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,U> {
    public static implicit operator Box<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,U>(Input<U> value) => default;
}
public static class Extensions {
    public static Input<U> GetValueOrDefault<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,U>(
        this Box<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,U> value,
        Box<A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,U> fallback)
        where A : U, System.IDisposable => new Input<U>(99);
}`, "Input[string]", "Input[string]()", "Input[string](7)", ".V")
            default: (`
    public struct Holder<A,B,C,D,E,F,G,H,I,J> {}
    public static class Extensions {
        public static int GetValueOrDefault<A,B,C,D,E,F,G,H,I,J>(
            this Holder<A,B,C,D,E,F,G,H,I,J> value, Holder<A,B,C,D,E,F,G,H,I,J> fallback) => 99;
    }
`, "int32", "0", "7", "")
        }
        using let fixture = CSharpFixture("namespace Fixture4986 {" + declaration + "}")
        let result = CompileAndRun((`import System
import Fixture4986
func ternary(n RECEIVER?) int32 -> n != nil ? n.GetValueOrDefault(FALLBACK)READ : 0
func expression(n RECEIVER?) int32 -> if n != nil { n.GetValueOrDefault(FALLBACK)READ } else { 0 }
func statement(n RECEIVER?) int32 {
    if n != nil { return n.GetValueOrDefault(FALLBACK)READ }
    return 0
}
Console.WriteLine("${ternary(PRESENT)} ${expression(PRESENT)} ${statement(PRESENT)} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace(
                "RECEIVER",
                receiver
            ).Replace(
                "FALLBACK",
                fallback
            ).Replace("PRESENT", present).Replace("READ", read), fixture.AssemblyPath, compileInSeparateProcess: true)
        Assert.Equal("7 7 7 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData("string", false)
    @InlineData("DualBad", false)
    @InlineData("DualGood", true)
    func Fixed_Argument_Constraint_Shapes_Retain_All_Interface_Alternatives(fixedArgument string, applicable bool) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IProbe<in T,U> {}
    public class DualBad : System.Collections.Generic.IComparer<string>, System.Collections.Generic.IComparer<int> {
        int System.Collections.Generic.IComparer<string>.Compare(string x, string y) => 0;
        int System.Collections.Generic.IComparer<int>.Compare(int x, int y) => 0;
    }
    public class DualGood : System.Collections.Generic.IComparer<string>, System.Collections.Generic.IComparer<System.IO.MemoryStream> {
        int System.Collections.Generic.IComparer<string>.Compare(string x, string y) => 0;
        int System.Collections.Generic.IComparer<System.IO.MemoryStream>.Compare(System.IO.MemoryStream x, System.IO.MemoryStream y) => 0;
    }
    public struct Probe : IProbe<object,` + fixedArgument + `> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T,U>(this IProbe<T,U> value,
            System.Collections.Generic.IComparer<T> fallback)
            where T : System.IDisposable where U : System.Collections.Generic.IComparer<T> => new Probe(99);
    }
}`)
        let argument = if applicable {
            "Comparer[System.IO.MemoryStream].Default"
        } else {
            "Probe()"
        }
        let direct = if applicable {
            "func direct(n Probe) int32 -> n.GetValueOrDefault(ARGUMENT).V\nConsole.WriteLine(direct(Probe(7)))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import System.Collections.Generic
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(ARGUMENT).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(ARGUMENT).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(ARGUMENT).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct).Replace("ARGUMENT", argument), fixture.AssemblyPath)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func Receiver_Interface_Alternatives_Remain_Available_To_Argument_Inference(applicable bool) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IProbe<T> {}
    public struct Probe : IProbe<string>, IProbe<` + (
                if applicable {
                    "System.IO.MemoryStream"
                } else {
                    "int"
                }
            ) + `> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T>(this IProbe<T> value, T fallback)
            where T : System.IDisposable => new Probe(99);
    }
}`)
        let argument = if applicable {
            "System.IO.MemoryStream()"
        } else {
            "Probe()"
        }
        let direct = if applicable {
            "func direct(n Probe) int32 -> n.GetValueOrDefault(ARGUMENT).V\nConsole.WriteLine(direct(Probe(7)))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(ARGUMENT).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(ARGUMENT).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(ARGUMENT).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct).Replace("ARGUMENT", argument), fixture.AssemblyPath)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Ambiguous_Fixed_Constraints_Retain_Joint_Class_Bounds(applicable bool) {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IProbe<in T,U,V> {}
    public class Left : System.Collections.Generic.IComparer<LEFT>, System.Collections.Generic.IComparer<System.Exception> {
        int System.Collections.Generic.IComparer<LEFT>.Compare(LEFT x, LEFT y) => 0;
        int System.Collections.Generic.IComparer<System.Exception>.Compare(System.Exception x, System.Exception y) => 0;
    }
    public class Right : System.Collections.Generic.IComparer<RIGHT>, System.Collections.Generic.IComparer<System.Collections.Generic.Dictionary<string,string>> {
        int System.Collections.Generic.IComparer<RIGHT>.Compare(RIGHT x, RIGHT y) => 0;
        int System.Collections.Generic.IComparer<System.Collections.Generic.Dictionary<string,string>>.Compare(
            System.Collections.Generic.Dictionary<string,string> x, System.Collections.Generic.Dictionary<string,string> y) => 0;
    }
    public struct Probe : IProbe<object,Left,Right> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T,U,V>(this IProbe<T,U,V> value,
            System.Collections.Generic.IComparer<T> fallback)
            where T : System.IDisposable where U : System.Collections.Generic.IComparer<T>
            where V : System.Collections.Generic.IComparer<T> => new Probe(99);
    }
}`.Replace(
                "LEFT",
                if applicable {
                    "System.IO.MemoryStream"
                } else {
                    "System.IO.Stream"
                }
            )
                .Replace(
                "RIGHT",
                if applicable {
                    "System.IO.MemoryStream"
                } else {
                    "System.Collections.Generic.List<string>"
                }
            ))
        let argument = if applicable {
            "Comparer[System.IO.MemoryStream].Default"
        } else {
            "Probe()"
        }
        let direct = if applicable {
            "func direct(n Probe) int32 -> n.GetValueOrDefault(ARGUMENT).V\nConsole.WriteLine(direct(Probe(7)))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import System.Collections.Generic
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(ARGUMENT).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(ARGUMENT).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(ARGUMENT).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct).Replace("ARGUMENT", argument), fixture.AssemblyPath)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Independent_Lower_Bound_Domains_Are_Pruned_Before_Pin_Search(applicable bool) {
        let slots = "A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P".Split(',')
        let names = String.Join(",", slots)
        let objects = String.Join(",", slots.Select((slot string) -> "object"))
        let strings = String.Join(",", slots.Select((slot string) -> "string"))
        using let fixture = CSharpFixture((`namespace Fixture4986 {
    public interface ICov<COVARIANT> {}
    public interface IProbe<CONTRAVARIANT,U> {}
    public class Cov : ICov<STRINGS> {}
    public struct Probe : IProbe<OBJECTS,Cov> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<NAMES,U>(this IProbe<NAMES,U> value, ICov<NAMES> fallback)
            where U : ICov<NAMES> where P : CONSTRAINT => new Probe(99);
    }
}`).Replace(
                "COVARIANT",
                String.Join(",", slots.Select((slot string) -> "out " + slot))
            ).Replace(
                "CONTRAVARIANT",
                String.Join(",", slots.Select((slot string) -> "in " + slot))
            ).Replace(
                "STRINGS",
                strings
            ).Replace(
                "OBJECTS",
                objects
            ).Replace(
                "NAMES",
                names
            ).Replace(
                "CONSTRAINT",
                if applicable {
                    "class"
                } else {
                    "System.IO.Stream"
                }
            ))
        let argument = if applicable {
            "Cov()"
        } else {
            "Probe()"
        }
        let direct = if applicable {
            "func direct(n Probe) int32 -> n.GetValueOrDefault(ARGUMENT).V\nConsole.WriteLine(direct(Probe(7)))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(ARGUMENT).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(ARGUMENT).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(ARGUMENT).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct).Replace("ARGUMENT", argument), fixture.AssemblyPath, compileInSeparateProcess: true)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Fact
    func Nested_Invariant_Leaves_Preserve_Contravariant_Inference_Direction() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public struct Probe : System.Collections.Generic.IComparer<System.Collections.Generic.List<string>> {
        public int V; public Probe(int v) { V = v; }
        public int Compare(System.Collections.Generic.List<string> x, System.Collections.Generic.List<string> y) => 0;
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T>(this System.Collections.Generic.IComparer<System.Collections.Generic.List<T>> value)
            => new Probe(99);
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n Probe) int32 -> n.GetValueOrDefault().V
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault().V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault().V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault().V }
    return 0
}
Console.WriteLine(direct(Probe(7)))
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Repeated_Variant_Parameters_Keep_Individual_Bounds(applicable bool) {
        using let fixture = CSharpFixture((`namespace Fixture4986 {
    public interface IPair<out A,out B> {}
    public interface IProbe<in T,U> {}
    public struct Pair : IPair<string,System.Exception> {}
    public struct Probe : IProbe<object,Pair> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T,U>(this IProbe<T,U> value, System.Collections.Generic.IComparer<T> fallback)
            where T : CONSTRAINT where U : IPair<T,T> => new Probe(99);
    }
}`).Replace(
                "CONSTRAINT",
                if applicable {
                    "class"
                } else {
                    "System.IO.Stream"
                }
            ))
        let argument = if applicable {
            "Comparer[object].Default"
        } else {
            "Probe()"
        }
        let direct = if applicable {
            "func direct(n Probe) int32 -> n.GetValueOrDefault(ARGUMENT).V\nConsole.WriteLine(direct(Probe(7)))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import System.Collections.Generic
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(ARGUMENT).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(ARGUMENT).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(ARGUMENT).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct).Replace("ARGUMENT", argument), fixture.AssemblyPath)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Closed_Covariant_Constructor_Domains_Do_Not_Multiply(applicable bool) {
        let slots = "A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P".Split(',')
        let names = String.Join(",", slots)
        let constraints = String.Join(" ", slots.Take(15).Select((slot string) -> "where " + slot + " : new()"))
        using let fixture = CSharpFixture((`namespace Fixture4986 {
    public interface IProbe<COVARIANT> {}
    public class Base { public Base() {} }
    public class Mid : Base { public Mid() {} }
    public class Leaf : Mid { public Leaf(int value) {} }
    public struct Probe : IProbe<LEAVES> {
        public int V; public Probe(int v) { V = v; }
    }
    public struct Wide : IProbe<MIDS> {}
    public static class Extensions {
        public static Probe GetValueOrDefault<NAMES>(this IProbe<NAMES> value, IProbe<NAMES> fallback)
            CONSTRAINTS where P : LAST => new Probe(99);
    }
}`).Replace(
                "COVARIANT",
                String.Join(",", slots.Select((slot string) -> "out " + slot))
            ).Replace(
                "LEAVES",
                String.Join(",", slots.Select((slot string) -> "Leaf"))
            ).Replace(
                "MIDS",
                String.Join(",", slots.Select((slot string) -> "Mid"))
            ).Replace(
                "NAMES",
                names
            ).Replace(
                "CONSTRAINTS",
                constraints
            ).Replace(
                "LAST",
                if applicable {
                    "new()"
                } else {
                    "System.IO.Stream, new()"
                }
            ))
        let argument = if applicable {
            "Wide()"
        } else {
            "Probe()"
        }
        let direct = if applicable {
            "func direct(n Probe) int32 -> n.GetValueOrDefault(ARGUMENT).V\nConsole.WriteLine(direct(Probe(7)))"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(ARGUMENT).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(ARGUMENT).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(ARGUMENT).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct).Replace("ARGUMENT", argument), fixture.AssemblyPath, compileInSeparateProcess: true)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Fact
    func Covariance_Derived_Common_Bounds_Keep_The_Underlying_Member() {
        using let fixture = CSharpFixture(`namespace Fixture4986 {
    public interface IProbe<in T,U,V> {}
    public struct Probe : IProbe<object,System.Collections.Generic.IEnumerable<string>,System.Collections.Generic.IEnumerable<System.Exception>>,
        System.Collections.Generic.IComparer<System.Collections.Generic.IEnumerable<object>> {
        public int V; public Probe(int v) { V = v; }
        public int Compare(System.Collections.Generic.IEnumerable<object> x, System.Collections.Generic.IEnumerable<object> y) => 0;
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T,U,V>(this IProbe<T,U,V> value, System.Collections.Generic.IComparer<T> fallback)
            where T : System.Collections.Generic.IEnumerable<object> where U : T where V : T => new Probe(99);
    }
}`)
        let result = CompileAndRun(`import System
import Fixture4986
func direct(n Probe) int32 -> n.GetValueOrDefault(Probe()).V
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Probe()).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
Console.WriteLine(direct(Probe(7)))
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Theory
    @InlineData(false, 0)
    @InlineData(true, 0)
    @InlineData(false, 12)
    func Constraint_Alternatives_Require_Joint_Support_Without_Multiplying_Independent_Domains(
        applicable bool,
        independent int32
    ) {
        let pairs = Enumerable.Range(0, independent).ToArray()
        let extraParameters = string.Join(",", pairs.Select((index int32) -> "A${index},B${index}"))
        let extraSlots = string.Join(",", pairs.Select((index int32) -> "in A${index},B${index}"))
        let extraArguments = string.Join(",", pairs.Select((index int32) -> "object,UnaryChoice"))
        let variables = string.Join(",", pairs.Select((index int32) -> "A${index}").Append("T").Append("U").Append("V"))
        let fallback = string.Join(
            ",",
            Enumerable.Repeat(
                if applicable {
                    "object"
                } else {
                    "System.IO.MemoryStream"
                },
                independent + 3
            )
        )
        let constraints = string.Join(
            " ",
            pairs.Select((index int32) -> "where B${index} : System.Collections.Generic.IComparer<A${index}>")
        )
        let prefix = func (text string) string {
            return if text.Length == 0 {
                ""
            } else {
                text + ","
            }
        }
        using let fixture = CSharpFixture((`namespace Fixture4986 {
    public interface IChoice<in T,in U> {}
    public interface IProbe<SLOTS> {}
    public interface IBounds<VARIABLES> {}
    public class UnaryChoice : System.Collections.Generic.IComparer<System.IO.Stream>, System.Collections.Generic.IComparer<System.Exception> {
        public int Compare(System.IO.Stream x, System.IO.Stream y) => 0;
        public int Compare(System.Exception x, System.Exception y) => 0;
    }
    public class ChoiceX : IChoice<S,S>, IChoice<System.Exception,System.Exception> {}
    public class ChoiceY : IChoice<S,S>, IChoice<System.Exception,System.Exception> {}
    public class ChoiceZ : ZCHOICES {}
    public struct Probe : IProbe<ARGUMENTS>, IBounds<FALLBACK> {
        public int V; public Probe(int v) { V = v; }
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<PARAMETERS>(this IProbe<PARAMETERS> value, IBounds<VARIABLES> fallback)
            CONSTRAINTS where X : IChoice<T,U> where Y : IChoice<U,V> where Z : IChoice<T,V> => new Probe(99);
    }
}`).Replace(
                "SLOTS",
                prefix(extraSlots) + "in T,in U,in V,X,Y,Z"
            ).Replace(
                "ARGUMENTS",
                prefix(extraArguments) + "object,object,object,ChoiceX,ChoiceY,ChoiceZ"
            ).Replace(
                "PARAMETERS",
                prefix(extraParameters) + "T,U,V,X,Y,Z"
            ).Replace(
                "VARIABLES",
                variables
            ).Replace(
                "FALLBACK",
                fallback
            ).Replace(
                "CONSTRAINTS",
                constraints
            ).Replace(
                "ZCHOICES",
                if applicable {
                    "IChoice<S,S>, IChoice<System.Exception,System.Exception>"
                } else {
                    "IChoice<S,System.Exception>, IChoice<System.Exception,S>"
                }
            ).Replace(
                "S,",
                if applicable {
                    "object,"
                } else {
                    "System.IO.Stream,"
                }
            ).Replace(
                ",S>",
                if applicable {
                    ",object>"
                } else {
                    ",System.IO.Stream>"
                }
            ))
        let direct = if applicable {
            "Console.WriteLine(Probe(7).GetValueOrDefault(Probe()).V)"
        } else {
            ""
        }
        let result = CompileAndRun((`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Probe()).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
DIRECT
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`).Replace("DIRECT", direct), fixture.AssemblyPath, compileInSeparateProcess: true)
        Assert.Equal(
            if applicable {
                "99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine
            } else {
                "7 7 7 0 0 0" + Environment.NewLine
            },
            result.Output
        )
    }

    @Theory
    @InlineData("System.Action<string>", "System.Action<object>")
    @InlineData("System.Func<object>", "System.Func<string>")
    func Variant_Sealed_Reference_Bounds_Keep_The_Underlying_Member(receiver string, candidate string) {
        using let fixture = CSharpFixture((`namespace Fixture4986 {
    public interface IProbe<in T,U> {}
    public struct Probe : IProbe<RECEIVER,System.Collections.Generic.Comparer<CANDIDATE>>, System.Collections.Generic.IComparer<CANDIDATE> {
        public int V; public Probe(int v) { V = v; }
        public int Compare(CANDIDATE x, CANDIDATE y) => 0;
    }
    public static class Extensions {
        public static Probe GetValueOrDefault<T,U>(this IProbe<T,U> value, System.Collections.Generic.IComparer<T> fallback)
            where U : System.Collections.Generic.IComparer<T> => new Probe(99);
    }
}`).Replace("RECEIVER", receiver).Replace("CANDIDATE", candidate))
        let result = CompileAndRun(`import System
import Fixture4986
func ternary(n Probe?) int32 -> n != nil ? n.GetValueOrDefault(Probe()).V : 0
func expression(n Probe?) int32 -> if n != nil { n.GetValueOrDefault(Probe()).V } else { 0 }
func statement(n Probe?) int32 {
    if n != nil { return n.GetValueOrDefault(Probe()).V }
    return 0
}
Console.WriteLine(Probe(7).GetValueOrDefault(Probe()).V)
Console.WriteLine("${ternary(Probe(7))} ${expression(Probe(7))} ${statement(Probe(7))} ${ternary(nil)} ${expression(nil)} ${statement(nil)}")
`, fixture.AssemblyPath)
        Assert.Equal("99" + Environment.NewLine + "99 99 99 0 0 0" + Environment.NewLine, result.Output)
    }

    @Fact
    func Nested_Fallbacks_Have_Linear_Binding_Work() {
        var nested = "0"
        for var i = 0; i < 22; i++ {
            nested = "n.GetValueOrDefault(" + nested + ")"
        }
        let timer = Stopwatch.StartNew()
        let result = CompileAndRun((`import System
func nested(n int32?) int32 -> n != nil ? ` + nested + ` : -1
Console.WriteLine("${nested(9)} ${nested(nil)}")
`))
        Assert.Equal("9 -1" + Environment.NewLine, result.Output)
        Assert.True(timer.Elapsed < TimeSpan.FromSeconds(30), "Nested nullable fallback binding must remain linear.")
    }

    @Fact
    func Argument_Ambiguity_Diagnostics_Are_Not_Discarded() {
        using let fixture = CSharpFixture(
            "namespace Alpha4986 { public static class Thing { public static string Name() => \"alpha\"; } } " +
                "namespace Beta4986 { public static class Thing { public static string Name() => \"beta\"; } }"
        )
        let result = Compile(`import Alpha4986
import Beta4986
func pick(n int32?) int32 -> n != nil ? n.GetValueOrDefault(Thing.Name().Length) : 0
`, fixture.AssemblyPath)
        Assert.NotEqual(0, result.ExitCode)
        Assert.True(Regex.IsMatch(result.Output, `\(3,61,3,66\): error GS0547:`), result.Output)
        Assert.Contains("Alpha4986.Thing", result.Output, StringComparison.Ordinal)
        Assert.Contains("Beta4986.Thing", result.Output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("struct Point { var X int32 }", "Point")
    @InlineData("enum Color { Red, Green }", "Color")
    func User_Value_Nullable_Method_Groups_Do_Not_Bind_Open_Methods(declaration string, typeName string) {
        let result = Compile(declaration + "\nfunc capture(p " + typeName + `?) int32 {
    let f () -> int32 = p.GetHashCode
    return f()
}
`)
        Assert.NotEqual(0, result.ExitCode)
        Assert.True(Regex.IsMatch(result.Output, `\(3,27,3,38\): error GS0158: [^\n]*GetHashCode`), result.Output)
    }

    /// The storage read is an ordinary `Nullable<T>.Value` property access, so
    /// it also works inside an expression-tree lambda, where the narrowed
    /// unwrap itself is rejected (#4974).
    @Fact
    func Storage_Read_Works_In_An_Expression_Tree() {
        let result = CompileAndRun(`import System
import System.Linq.Expressions
let e Expression[Func[int32?, int32]] = (v int32?) -> v != nil ? v.Value + 1 : 0
let h Expression[Func[int32?, bool]] = (v int32?) -> if v != nil { v.HasValue } else { false }
Console.WriteLine("${e.Compile()(4)} ${e.Compile()(nil)} ${h.Compile()(1)} ${h.Compile()(nil)}")
`)
        Assert.Equal("5 0 True False" + Environment.NewLine, result.Output)
    }

    shared {
        /// Compiles a library with an optional extra reference and returns the
        /// driver's exit code and output, without running anything.
        private func Compile(source string, reference string? = nil)(ExitCode int32, Output string) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4986NarrowedNullableMemberTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Library.gs")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    let arguments = List[string](
                        []string{
                            "/out:" + Path.Combine(outputDirectory, "Library.dll"),
                            "/target:library",
                            "/targetframework:net10.0",
                            sourcePath
                        }
                    )
                    if reference != nil {
                        arguments.Add("/reference:" + reference)
                    }
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                return (exitCode, standardOut.ToString() + standardError.ToString())
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }

        /// Compiles through the real driver, verifies IL, and executes.
        private func CompileAndRun(source string, reference string? = nil, compileInSeparateProcess bool = false)(
            Output string,
            CompilerOutput string
        ) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4986NarrowedNullableMemberTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue4986.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    let arguments = List[string](
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                    if reference != nil {
                        arguments.Add("/reference:" + reference)
                        File.Copy(reference, Path.Combine(outputDirectory, Path.GetFileName(reference)))
                    }
                    if compileInSeparateProcess {
                        let compileInfo = ProcessStartInfo("dotnet"){
                            RedirectStandardOutput = true,
                            RedirectStandardError = true,
                            UseShellExecute = false,
                            WorkingDirectory = outputDirectory
                        }
                        compileInfo.ArgumentList.Add("exec")
                        compileInfo.ArgumentList.Add("--runtimeconfig")
                        compileInfo.ArgumentList.Add(
                            Path.Combine(AppContext.BaseDirectory, "GSharp.Compiler.Tests.runtimeconfig.json")
                        )
                        compileInfo.ArgumentList.Add("--depsfile")
                        compileInfo.ArgumentList.Add(
                            Path.Combine(AppContext.BaseDirectory, "GSharp.Compiler.Tests.deps.json")
                        )
                        compileInfo.ArgumentList.Add(typeof(Program).Assembly.Location)
                        for argument in arguments {
                            compileInfo.ArgumentList.Add(argument)
                        }
                        let (code, stdout, stderr) = IlVerifier.RunProcess(compileInfo, outputPath, 30_000)
                        exitCode = code
                        Console.Write(stdout)
                        Console.Error.Write(stderr)
                    } else {
                        exitCode = Program.Main(arguments.ToArray())
                    }
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(
                    outputPath,
                    if reference != nil {
                        []string{reference}
                    } else {
                        Array.Empty[string]()
                    }
                )
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDirectory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                let (sampleExit, stdout, stderr) = IlVerifier.RunProcess(startInfo, outputPath, 30_000)
                Assert.True(sampleExit == 0, (`sample exited ` + "$sampleExit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    standardOut.ToString() + standardError.ToString()
                )
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }
    }
}
