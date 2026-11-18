package GSharp.Compiler.Tests

import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue6086SharedAddressOfTests {
    @Theory
    @InlineData("ref", "value++\nreturn value", "4:4", "value = next\nreturn value", "9")
    @InlineData("out", "value = 7\nreturn value", "7:7", "value = next\nreturn value", "9")
    @InlineData("in", "return value * 2", "3:6", "return value", "3")
    func SharedAddressOf_PreservesAliasingAndFreeFunctionControls(
        kind string,
        body string,
        expected string,
        genericBody string,
        genericExpected string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
unsafe class Native {
    shared {
        public func Transform(KIND value int32) int32 { BODY }
        public func Echo[T](KIND value T, next T) T { GENERIC_BODY }
        public func Forward[T](seed T, next T) T {
            var value T = seed
            Native.Echo[T](&value, next)
            return value
        }
        public func Invoke() {
            var value int32 = 3
            let result = Transform(&value)
            Console.Write("${value}:${result}|")
            value = 3
            let qualified = Native.Transform(&value)
            Console.Write("${value}:${qualified}|")
        }
    }
}
func Safe(KIND value int32) int32 { BODY }
unsafe func Unsafe(KIND value int32) int32 { BODY }
func Control() {
    var value int32 = 3
    let result = Safe(&value)
    Console.Write("${value}:${result}|")
}
unsafe func UnsafeControl() {
    var value int32 = 3
    let result = Unsafe(&value)
    Console.Write("${value}:${result}")
}
Native.Invoke()
Control()
UnsafeControl()
Console.Write("|")
Console.Write(Native.Forward[int32](3, 9))
`.Replace("KIND", kind).Replace("GENERIC_BODY", genericBody).Replace("BODY", body)
        let image = fixture.Compile(source, "Shared", true)
        IlVerifier.Verify(image)
        Assert.Equal(
            Encoding.UTF8.GetBytes("$expected|$expected|$expected|$expected|$genericExpected"),
            fixture.RunBytes(image)
        )
    }

    @Theory
    @InlineData("ref")
    @InlineData("out")
    @InlineData("in")
    func SharedPInvokeAddressOf_CompilesWithoutInvokingNativeSymbol(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System.Runtime.InteropServices
unsafe class Native {
    shared {
        @DllImport("libc")
        private func Inspect(KIND value int32);
        public func Invoke() {
            var value int32 = 3
            Inspect(&value)
            Native.Inspect(&value)
        }
    }
}
`.Replace("KIND", kind)
        let image = fixture.Compile(source, "PInvoke", false)
        IlVerifier.Verify(image)
    }

    @Theory
    @InlineData("ref", "value++")
    @InlineData("out", "value = 7")
    @InlineData("in", "")
    func SharedAddressOf_RejectsDifferentPointeeStorage(kind string, body string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `unsafe class Native {
    shared {
        private func Inspect(KIND value int32) { BODY }
        public func Invoke() {
            var value int64 = 3
            Inspect(&value)
        }
    }
}
`.Replace("KIND", kind).Replace("BODY", body)
        let (code, log) = fixture.TryCompile(source, "Mismatch", false)
        Assert.NotEqual(0, code)
        let actual = Assert.Single(Regex.Matches(log, `(?m)^.*\((\d+,\d+,\d+,\d+)\): error (GS\d+): (.*)$`))
        Assert.Equal("6,21,6,27", actual.Groups[1].Value)
        Assert.Equal("GS0154", actual.Groups[2].Value)
        Assert.Equal(
            "Parameter 'value' requires a value of type 'int32' but was given a value of type 'int64'.",
            actual.Groups[3].Value
        )
    }
}
