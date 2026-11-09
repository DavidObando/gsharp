package GSharp.Compiler.Tests

import System
import System.Text
import Xunit

class Issue5815OptionalAndHeaderLiteralDriverTests {
    @Fact
    func Review6CheckedWritableAliasReportsTheCastLocation() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`import System.Collections.Generic
func One[T](value T) List[T] -> List[T]{value}
let f = (x int32 = 7) -> x
let values = One(f)
let alias = cast[IList[(int32) -> int32]](values)
`, "checked-alias", true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0155", output, StringComparison.Ordinal)
        Assert.Contains(".gs(5,", output, StringComparison.Ordinal)
    }

    @Fact
    func Review6NestedMapDefaultsVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package MapDefaults5815
import System
func Wrap[T](value T) map[int32, T] -> map[int32, T]{0: value}
let first = () -> Wrap((x int32 = 7) -> x)
let second = () -> Wrap((x int32 = 9) -> x)
Console.Write("${first()[0]()}:" )
Console.Write(second()[0]())
`, "map-defaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("7:9"), fixture.RunBytes(dll))
    }

    @Fact
    func Review6DiscardedValuesStillInvokeTheDefaultOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package DiscardDefaults5815
import System
var trace = 0
var f = func(x int32 = 7) void {}
f = func(x int32 = 7) int32 { return trace += x }
f()
Console.Write(trace)
`, "discard-defaults", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("7"), fixture.RunBytes(dll))
    }

    @Fact
    func Review4WrittenGenericFunctionCastsVerifyAndRequireAllArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package ErasedGeneric5815
import System
func Run[T](value T) T {
return cast[(int32) -> T](func(x int32 = 7) T { return value })(3)
}
Console.Write(Run(7))
`
        let dll = fixture.Compile(source, "generic-erased", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("7"), fixture.RunBytes(dll))
        let rejected = source.Replace("})(3)", "})()")
        Assert.NotEqual(source, rejected)
        let (code, output) = fixture.TryCompile(rejected, "generic-erased-omitted", true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0144", output, StringComparison.Ordinal)
        Assert.Contains(".gs(4,", output, StringComparison.Ordinal)
    }

    @Fact
    func Review4ThrowArgumentsAndWrapperResultsVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ContractControls5815
import System
class Box[T] {
var Value T
init(value T) { Value = value }
func operator implicit(value Box[T]) T -> value.Value
func operator implicit(value T) Box[T] -> Box[T](value)
}
func MakeBox[T](value T) Box[T] -> Box[T](value)
func Choose[T](left T, right T) T -> left
func Choose(left int32, right int32) int32 -> left
var f = (x int32 = 7) -> x
f = MakeBox(f)
var box = MakeBox(f)
box = (x int32 = 7) -> x + 1
f = box
try { Choose(f, throw InvalidOperationException()) } catch { Console.Write("caught:") }
Console.Write(f())
`, "contract-controls", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("caught:8"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("x int32 = 9")
    @InlineData("x int32")
    func Review3GenericLambdaReassignmentsReportConversionErrors(replacement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`func Run[T](value T) T {
var f = func(x int32 = 7) T { return value }
f = func(` + replacement + `) T { return value }
return f()
}
Run(1)`, "generic", true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0155", output, StringComparison.Ordinal)
        Assert.Contains(".gs(3,", output, StringComparison.Ordinal)
    }

    @Fact
    func Review3LeadingZeroMinimumLiteralsVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package LeadingZero5872
import System
Console.Write("${-09223372036854775808}:${-0_9223372036854775808}")
`, "leading-zero", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("-9223372036854775808:-9223372036854775808"), fixture.RunBytes(dll))
    }

    @Fact
    func Review2NumericAdapterVerifiesAndInvokesTheDeclaredDefault() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Adapter5815
import System
var f = func(x int32 = 7) int64 { return int64(x) }
f = func(x int32 = 7) int32 { return x }
Console.Write(f())
`, "adapter", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("7"), fixture.RunBytes(dll))
    }

    @Fact
    func ReviewUnsignedBoundarySuffixesVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Unsigned5872
import System
let first = 9223372036854775808UL
let second = +0x8000_0000_0000_0000uL
Console.Write("${first}:${second}")
`, "unsigned", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("9223372036854775808:9223372036854775808"), fixture.RunBytes(dll))
        let (code, output) = fixture.TryCompile("let value = -9223372036854775808UL", "negative-unsigned", true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0128", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0004", output, StringComparison.Ordinal)
    }

    @Fact
    func ReviewNestedCallableWideningVerifiesAndRequiresAllArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let prefix = `package Nested5815
import System
let f = (x int32 = 7) -> x
let pair = (f, 0)
let erased = cast[((int32) -> int32, int32)](pair)
`
        let dll = fixture.Compile(prefix + "Console.Write(erased.Item1(3))", "nested", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("3"), fixture.RunBytes(dll))
        let (code, output) = fixture.TryCompile(prefix + "Console.Write(erased.Item1())", "nested-omitted", true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0144", output, StringComparison.Ordinal)
        Assert.Contains(".gs(6,", output, StringComparison.Ordinal)
    }

    @Fact
    func InferredFunctionDefaultsVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Optional5815
import System
let f = func(x int32 = 7) int32 { return x }
let g = (x int32 = 9) -> x
let named = (x int32 = 7, y int32) -> x + y
let many = (x int32 = 7, tail ...int32) -> x + tail.Length
let nullable = (x int32? = 7) -> x ?? -1
let money = (x decimal = default(decimal)) -> x
Console.Write("${f()}:${g()}:${named(y: 3)}:${many()}:${many(tail: []int32{1, 2})}:")
Console.Write("${(func(x int32 = 11) int32 { return x })()}:${nullable()}:${money()}")
`, "optional", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("7:9:10:7:9:11:7:0"), fixture.RunBytes(dll))
    }

    @Fact
    func InlineForeachArrayConstructorsVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Header5864
import System
class Item { var Value int32 }
for item in []Item{Item{Value: 1}} { Console.Write(item.Value) }
for item in [1]Item{Item{Value: 2}} { Console.Write(item.Value) }
for items in [][]Item{[]Item{Item{Value: 3}}} { Console.Write(items[0].Value) }
`, "header", true)
        IlVerifier.Verify(dll)
        Assert.Equal(Encoding.UTF8.GetBytes("123"), fixture.RunBytes(dll))
    }

    @Fact
    func SignedInt64MinimumVerifiesAndExecutesAndPositiveBoundaryIsRejected() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Boundary5872
import System
func Minimum() int64 -> -9223372036854775808L
Console.Write("${Minimum()}:${-9_223_372_036_854_775_808l}:${-9223372036854775808}")
`, "boundary", true)
        IlVerifier.Verify(dll)
        Assert.Equal(
            Encoding.UTF8.GetBytes("-9223372036854775808:-9223372036854775808:-9223372036854775808"),
            fixture.RunBytes(dll)
        )
        for expression in[]string{"9223372036854775808L", "+9223372036854775808L"} {
            let (code, output) = fixture.TryCompile("func Positive() int64 -> " + expression, "positive", false)
            Assert.NotEqual(0, code)
            Assert.Contains("GS0004", output, StringComparison.Ordinal)
            Assert.Contains(".gs(1,", output, StringComparison.Ordinal)
        }
    }
}
