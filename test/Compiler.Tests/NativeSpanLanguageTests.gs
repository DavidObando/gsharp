package GSharp.Compiler.Tests

import GSharp.Tests
import System
import Xunit

class NativeSpanLanguageTests {
    @Fact
    func AliasesDoNotBindAUserDefinedSystemSpanLookalike() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let counterfeit = fixture.CompileCSharp(`namespace System {
public class Span<T> { }
public class ReadOnlySpan<T> { }
}`, "SpanLookalike")
        let assembly = fixture.Compile(`package NativeSpanIdentity
import System
func Main() {
    let value readonly span[byte] = []byte{65}
    Console.WriteLine(typeof(span[byte]).IsByRefLike)
    Console.WriteLine(typeof(readonly span[byte]).Assembly == typeof(object).Assembly)
    Console.WriteLine(Convert.ToHexString(value.ToArray()))
}`, "native-span-identity", true, "/reference:" + counterfeit)
        IlVerifier.Verify(assembly, []string{counterfeit})
        Assert.Equal("True\nTrue\n41\n", fixture.Run(assembly))
    }

    @Fact
    func AliasesKeepClrIdentityAndByteAccessThroughTheDriver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.CompileCSharp(`using System;
namespace NativeSpanContract;
public static class Contract {
    public static int Sum(ReadOnlySpan<byte> value) {
        int sum = 0;
        foreach (byte item in value) sum += item;
        return sum;
    }
}`, "NativeSpanContract")
        let assembly = fixture.Compile(`package NativeSpanWitness
import System
import NativeSpanContract
enum Code { A = 1, B = 4 }
func First[T](value readonly span[T]) T -> value[0]
func Main() {
    let raw = []byte{65, 0, 195, 169}
    let writable = span[byte](raw)
    writable[0] = 66
    let view readonly span[byte] = writable
    let clr ReadOnlySpan[byte] = view
    Console.WriteLine(typeof(span[byte]) == typeof(Span[byte]))
    Console.WriteLine(typeof(readonly span[byte]) == typeof(ReadOnlySpan[byte]))
    Console.WriteLine(typeof(span[_]) == typeof(Span[_]))
    Console.WriteLine(typeof(readonly span[_]) == typeof(ReadOnlySpan[_]))
    Console.WriteLine(view.Length)
    Console.WriteLine(Convert.ToHexString(clr.ToArray()))
    Console.WriteLine(Contract.Sum(view))
    Console.WriteLine(First[byte](view))
    Console.WriteLine(readonly span[byte].Empty.Length)
    Console.WriteLine(span[byte].Empty.Length)
    let codes = readonly span[Code]([]Code{Code.B, Code.A})
    Console.WriteLine(int32(First[Code](codes)))
    var total = 0
    for code in codes { total += int32(code) }
    Console.WriteLine(total)
}`, "native-span-witness", true, "/reference:" + contract)
        IlVerifier.Verify(assembly, []string{contract})
        Assert.Equal("True\nTrue\nTrue\nTrue\n4\n4200C3A9\n430\n66\n0\n0\n4\n5\n", fixture.Run(assembly))
    }

    @Theory
    @InlineData("let value readonly span[int32, int32]", "exactly one element type")
    @InlineData("let value span[void]", "ordinary heap-storable element type")
    @InlineData("let value span[Span[byte]]", "ordinary heap-storable element type")
    @InlineData("let value = readonly span[byte]{1, 2}", "no collection-literal allocation")
    func InvalidAliasesReportLocatedDiagnostics(statement string, reason string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package NativeSpanReject\nimport System\nfunc Main() {\n" + statement + "\n}",
            "native-span-reject",
            true
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0631", output, StringComparison.Ordinal)
        Assert.Contains(reason, output, StringComparison.Ordinal)
        Assert.Contains(".gs(4,", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`class span[T] { var Value T }
func Main() {
    let value span[int32] = span[int32]{Value: 7}
    let escaped $span[int32] = $span[int32]{Value: 9}
    let clr System.ReadOnlySpan[byte] = []byte{1, 2, 3}
    Console.WriteLine(value.Value + escaped.Value)
    Console.WriteLine(clr.Length)
}`, "16\n3\n")
    @InlineData(`func span[T](value T) T -> value
func Main() { Console.WriteLine(span[int32](7)) }`, "7\n")
    func OrdinaryUserNamesKeepPrecedence(declarations string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(
            "package NativeSpanOrdinary\nimport System\n" + declarations,
            "native-span-ordinary",
            true
        )
        IlVerifier.Verify(assembly)
        Assert.Equal(expected, fixture.Run(assembly))
    }

    @Fact
    func AliasesKeepAsyncLivenessAndHeapStorageRestrictions() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package NativeSpanAsync
import System
import System.Threading.Tasks
async func Read(data []byte) Task[int32] {
    let view readonly span[byte] = data
    let length = view.Length
    await Task.Yield()
    return length
}
func Main() { Console.WriteLine(Read([]byte{1, 2, 3}).Result) }`, "native-span-async", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("3\n", fixture.Run(assembly))
        let (code, output) = fixture.TryCompile(`package NativeSpanUnsafe
import System.Threading.Tasks
class Heap { prop Value span[byte] }
async func Read(data []byte) Task[int32] {
    let view readonly span[byte] = data
    await Task.Yield()
    return view.Length
}`, "native-span-unsafe", false)
        Assert.NotEqual(0, code)
        for location in[]string{".gs(3,", ".gs(5,"} {
            Assert.Contains(
                output.Split('\n'),
                (line string) ->
                line.Contains("GS0219", StringComparison.Ordinal) && line.Contains(location, StringComparison.Ordinal)
            )
        }
    }

    @Fact
    func ReadonlyAliasRejectsElementStores() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package NativeSpanReadonly
func Main() {
    let view readonly span[byte] = []byte{65}
    view[0] = 66
}`, "native-span-readonly", true)
        Assert.NotEqual(0, code)
        Assert.Contains(
            output.Split('\n'),
            (line string) ->
            line.Contains("GS0226", StringComparison.Ordinal) && line.Contains(".gs(4,", StringComparison.Ordinal)
        )
    }

    @Fact
    func ReadonlyDoesNotSilentlyModifyAShadowingUserType() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package NativeSpanShadowReject
class span[T] { var Value T }
func Main() {
    let value readonly span[int32]
    let reflected = typeof(readonly span[_])
}`, "native-span-shadow-reject", true)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0631", output, StringComparison.Ordinal)
        Assert.Contains(".gs(4,", output, StringComparison.Ordinal)
        Assert.Contains(
            output.Split('\n'),
            (line string) ->
            line.Contains("GS0631", StringComparison.Ordinal) && line.Contains(".gs(5,", StringComparison.Ordinal)
        )
    }
}
