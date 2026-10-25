package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text
import Xunit

class Utf8LiteralLanguageTests {
    @Theory
    @InlineData("u8\"AB\".Slice(0, 1)", false)
    @InlineData("ReadOnlySpan[byte]([]byte{65})", false)
    @InlineData("u8\"AB\".Slice(0, 1)", true)
    func InferredCallSuspensionChecksAlreadyAsyncBodies(expression string, lambda bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let body = if lambda {
            `func Create() {
    let read = async func(ch chan[int32]) int32 {
        return Consume(EXPRESSION, Take(ch))
    }
}`
        } else {
            `async func Read(ch chan[int32]) int32 {
    return Consume(EXPRESSION, Take(ch))
}
func Main() {
    let channel = chan[int32]()
    let pending = Read(channel)
    channel <- 1
    Console.WriteLine(pending.Result)
}`
        }
        let (code, output) = fixture.TryCompile(`package Utf8InferredCall
import System
func Take(ch chan[int32]) int32 -> <-ch
func Consume(value readonly span[byte], extra int32) int32 -> value.Length * 100 + extra
BODY
`.Replace("BODY", body).Replace("EXPRESSION", expression), "Utf8InferredCall", false)
        Assert.NotEqual(0, code)
        let diagnostic = Assert.Single(
            output.Split('\n').Where((line string) -> line.Contains("GS0219", StringComparison.Ordinal))
        )
        Assert.Contains(
            if lambda {
                "(7,"
            } else {
                "(6,"
            },
            diagnostic,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Utf8InferredCall.dll")))
    }

    @Fact
    func InferredCallAnalysisDoesNotDuplicateExistingSuspensionDiagnostics() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package Utf8InferredDuplicate
func Take(ch chan[int32]) int32 -> <-ch
func Consume(value readonly span[byte], extra int32) int32 -> value.Length + extra
async func Read(ch chan[int32]) int32 {
    let value = u8"A"
    let received = <-ch
    return Consume(value, received) + Take(ch)
}
`, "Utf8InferredDuplicate", false)
        Assert.NotEqual(0, code)
        let diagnostic = Assert.Single(
            output.Split('\n').Where((line string) -> line.Contains("GS0219", StringComparison.Ordinal))
        )
        Assert.Contains("(5,", diagnostic, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Utf8InferredDuplicate.dll")))
    }

    @Fact
    func InferredCallsPreserveSafeLiteralAndPostSuspensionConstructionOnEmptyChannels() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8InferredSafe
import System
func Take(ch chan[int32]) int32 -> <-ch
func Consume(value readonly span[byte], extra int32) int32 -> int32(value[0]) + extra
func ConsumeAfter(extra int32, value readonly span[byte]) int32 -> value.Length * 100 + extra
async func Literal(ch chan[int32]) int32 -> Consume(u8"A", Take(ch))
async func After(ch chan[int32]) int32 -> ConsumeAfter(Take(ch), u8"AB".Slice(0, 1))
func Main() {
    let first = chan[int32]()
    let literal = Literal(first)
    Console.WriteLine(literal.IsCompleted)
    first <- 1
    Console.WriteLine(literal.Result)
    let second = chan[int32]()
    let after = After(second)
    Console.WriteLine(after.IsCompleted)
    second <- 1
    Console.WriteLine(after.Result)
}`, "Utf8InferredSafe", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("False\n66\nFalse\n101\n", fixture.Run(assembly))
    }

    @Theory
    @InlineData(`return Consume(u8"AB".Slice(0, 1), <-ch)`, "GS0219")
    @InlineData(`return Consume(ReadOnlySpan[byte]([]byte{65}), <-ch)`, "GS0219")
    @InlineData(`let value = u8"A"
return Consume(value, <-ch)`, "GS0219")
    @InlineData(`let ref readonly value = u8"A"[0]
let received = <-ch
return int32(value) + received`, "GS0258")
    func ImplicitChannelSuspensionChecksSourceLocalsAndOperandTemporaries(body string, diagnostic string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package Utf8ChannelTemporary
import System
func Consume(value readonly span[byte], extra int32) int32 -> value.Length + extra
async func Read(ch chan[int32]) int32 {
BODY
}
`.Replace("BODY", body), "Utf8ChannelTemporary", false)
        Assert.NotEqual(0, code)
        Assert.Contains(diagnostic, output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Utf8ChannelTemporary.dll")))
    }

    @Fact
    func AsyncLambdaChannelSuspensionCannotLoseSpanOperands() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package Utf8ChannelLambda
func Consume(value readonly span[byte], extra int32) int32 -> value.Length + extra
func Create() {
    let read = async func(ch chan[int32]) int32 {
        return Consume(u8"AB".Slice(0, 1), <-ch)
    }
}
`, "Utf8ChannelLambda", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    @Fact
    func ImplicitChannelSuspensionPreservesPureLiteralsAndAfterAwaitConstruction() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8ChannelSafe
import System
func Consume(value readonly span[byte], extra int32) int32 -> int32(value[0]) + extra
func ConsumeAfter(extra int32, value readonly span[byte]) int32 -> value.Length * 100 + extra
async func Literal(ch chan[int32]) int32 -> Consume(u8"A" + u8"", <-ch)
async func After(ch chan[int32]) int32 -> ConsumeAfter(<-ch, u8"AB".Slice(0, 1))
func Main() {
    let first = chan[int32]()
    let literal = Literal(first)
    first <- 1
    Console.WriteLine(literal.Result)
    let second = chan[int32]()
    let after = After(second)
    second <- 1
    Console.WriteLine(after.Result)
}`, "Utf8ChannelSafe", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("66\n101\n", fixture.Run(assembly))
    }

    @Theory
    @InlineData("u8\"AB\".Slice(0, 1)")
    @InlineData("View()")
    @InlineData("ReadOnlySpan[byte]([]byte{65})")
    @InlineData("(if true { u8\"A\" } else { u8\"B\" })")
    func RefLikeOperandTemporariesCannotDisappearAcrossAwait(expression string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package Utf8Temporary
import System
import System.Threading.Tasks
func View() readonly span[byte] -> u8"A"
func Consume(value readonly span[byte], extra int32) int32 -> value.Length + extra
async func Read(pending Task[int32]) Task[int32] -> Consume(EXPRESSION, await pending)
`.Replace("EXPRESSION", expression), "Utf8Temporary", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Utf8Temporary.dll")))
    }

    @Fact
    func DerivedSpanReceiverTemporariesCannotDisappearAcrossAwait() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package Utf8TemporaryReceiver
import System.Threading.Tasks
async func Read(pending Task[int32]) Task[int32] -> u8"AB".Slice(0, 1).Slice(await pending, 0).Length
`, "Utf8TemporaryReceiver", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    @Fact
    func AwaitedConditionalsAndArgumentsOnlyDeferStaticLiteralValues() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8Spill
import System
import System.Threading.Tasks
func Consume(value readonly span[byte], extra int32) int32 -> int32(value[0]) + extra
func ConsumeAfter(extra int32, value readonly span[byte]) int32 -> value.Length * 100 + extra
async func Read(pending Task[bool]) Task[string] {
    let value = (await pending) ? u8"Aé" : u8"B\0"
    return Convert.ToHexString(value)
}
async func Argument(pending Task[int32]) Task[int32] -> Consume(u8"A" + u8"", await pending)
async func Receiver(pending Task[int32]) Task[int32] -> int32(u8"AB".Slice(await pending, 1)[0])
async func After(pending Task[int32]) Task[int32] -> ConsumeAfter(await pending, u8"AB".Slice(0, 1))
func Main() {
    let trueGate = TaskCompletionSource[bool]()
    let whenTrue = Read(trueGate.Task)
    trueGate.SetResult(true)
    Console.WriteLine(whenTrue.Result)
    let falseGate = TaskCompletionSource[bool]()
    let whenFalse = Read(falseGate.Task)
    falseGate.SetResult(false)
    Console.WriteLine(whenFalse.Result)
    let argumentGate = TaskCompletionSource[int32]()
    let argument = Argument(argumentGate.Task)
    argumentGate.SetResult(1)
    Console.WriteLine(argument.Result)
    let receiverGate = TaskCompletionSource[int32]()
    let receiver = Receiver(receiverGate.Task)
    receiverGate.SetResult(1)
    Console.WriteLine(receiver.Result)
    let afterGate = TaskCompletionSource[int32]()
    let after = After(afterGate.Task)
    afterGate.SetResult(1)
    Console.WriteLine(after.Result)
}`, "Utf8Spill", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("41C3A9\n4200\n66\n66\n101\n", fixture.Run(assembly))
    }

    @Fact
    func StaticLiteralElementsCanEscapeAsReadonlyReferences() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8Element
import System
func First() ref readonly byte { return ref u8"A"[0] }
func Last() ref readonly byte { return ref (u8"A" + u8"B")[1] }
func Main() {
    let ref readonly saved = First()
    GC.Collect()
    GC.WaitForPendingFinalizers()
    Console.WriteLine(int32(saved))
    Console.WriteLine(int32(Last()))
}`, "Utf8Element", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("65\n66\n", fixture.Run(assembly))
    }

    @Theory
    @InlineData(`func Bad(scoped value readonly span[byte]) ref readonly byte { return ref value[0] }`)
    @InlineData(`func Bad() ref readonly byte {
    let value = default(readonly span[byte])
    return ref value[0]
}`)
    func ArbitraryReadonlySpansDoNotAcquireStaticLiteralReferentScope(source string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile("package Utf8RefReject\n" + source, "Utf8RefReject", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0254", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    @Fact
    func LambdaBodiesAndExplicitCopyBoundariesRetainLiteralBytes() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8Copies
import System
import Gsharp.Values
func Main() {
    let size = func() int32 { return u8"\U0001F600".Length }
    let copy = ByteString.CopyFrom(u8"Aé\0")
    let exported = copy.ToArray()
    exported[0] = 66
    Console.WriteLine(size())
    Console.WriteLine(Convert.ToHexString(copy.ToArray()))
    Console.WriteLine(Convert.ToHexString(exported))
    Console.WriteLine(Convert.ToHexString(u8"Aé\0"))
}`, "Utf8Copies", true)
        IlVerifier.Verify(assembly, []string{typeof(Gsharp.Values.ByteString).Assembly.Location})
        Assert.Equal("4\n41C3A900\n42C3A900\n41C3A900\n", fixture.Run(assembly))
    }

    @Theory
    @InlineData("Compiler", "gsc.dll")
    @InlineData("Repl", "gsi.dll")
    func StandaloneCompiledDriversConsumeTheSameNativeSpan(directory string, driver string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Path.Combine(fixture.Directory, "driver.gs")
        File.WriteAllText(source, `import System
Console.WriteLine(u8"Aé\0".Length)`)
        let assembly = Path.Combine(fixture.Directory, "driver.dll")
        let arguments = if driver == "gsc.dll" {
            []string{"/target:exe", "/targetframework:net10.0", "/out:" + assembly, source}
        } else {
            []string{source}
        }
        let (code, stdout, stderr) = ByteStringLanguageTests.RunDriver(directory, driver, arguments)
        Assert.True(code == 0, stdout + stderr)
        Assert.Equal(
            "4\n",
            if driver == "gsc.dll" {
                fixture.Run(assembly)
            } else {
                stdout
            }
        )
    }

    @Theory
    @InlineData("Compiler", "gsc.dll")
    @InlineData("Repl", "gsi.dll")
    @InlineData("Gsfmt.Cli", "gsfmt.dll")
    func FileDriversRejectLossyUtf8DecodingWithoutRewritingTheInput(directory string, driver string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Path.Combine(fixture.Directory, "invalid.gs")
        let prefix = Encoding.UTF8.GetBytes("let value = u8\"")
        let bytes = [prefix.Length + 3]uint8
        prefix.CopyTo(bytes, 0)
        bytes[prefix.Length] = 0xFF
        bytes[prefix.Length + 1] = 34
        bytes[prefix.Length + 2] = 10
        File.WriteAllBytes(source, bytes)
        let arguments = if driver == "gsc.dll" {
            []string{"/target:library", "/targetframework:net10.0", "/out:" + source + ".dll", source}
        } else if driver == "gsfmt.dll" {
            []string{"--write", source}
        } else {
            []string{source}
        }
        let (code, stdout, stderr) = ByteStringLanguageTests.RunDriver(directory, driver, arguments)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0632", stdout + stderr, StringComparison.Ordinal)
        Assert.Equal(bytes, File.ReadAllBytes(source))
    }

    @Fact
    func StaticStorageDoesNotPermitALiveRefStructAcrossAwait() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8Async
import System
import System.Threading.Tasks
async func Read() Task[int32] {
    let before = u8"Aé"
    let length = before.Length
    await Task.Yield()
    let after = u8"\U0001F600"
    return length + after.Length
}
func Main() { Console.WriteLine(Read().Result) }`, "Utf8Async", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("7\n", fixture.Run(assembly))
        let (code, output) = fixture.TryCompile(`package Utf8Live
import System.Threading.Tasks
async func Read() Task[int32] {
    let view = u8"Aé"
    await Task.Yield()
    return view.Length
}`, "Utf8Live", false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    @Fact
    func RvaPoolingIsExactSortedDeduplicatedDeterministicAndAbsentFromReferenceAssemblies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `package Utf8Data
public class Uses {
    shared {
        public func B() int32 -> u8"B".Length
        public func A() int32 -> u8"A".Length
        public func Empty() int32 -> u8"".Length
        public func Again() int32 -> u8"A".Length
        public func Fold() int32 -> (u8"" + u8"A").Length
        public func Size(value readonly span[byte]) int32 -> value.Length
    }
}`
        let reference = Path.Combine(fixture.Directory, "Utf8Data.ref.dll")
        let assembly = fixture.Compile(source, "Utf8Data", false, "/refout:" + reference)
        let first = File.ReadAllBytes(assembly)
        fixture.Compile(source, "Utf8Data", false, "/refout:" + reference)
        Assert.Equal(first, File.ReadAllBytes(assembly))
        IlVerifier.Verify(assembly)
        using let stream = File.OpenRead(assembly)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        let fields = reader.FieldDefinitions.ToArray()
        Assert.Equal(3, fields.Length)
        let expected = []string{"00", "4100", "4200"}
        for var index = 0; index < fields.Length; index++ {
            let field = reader.GetFieldDefinition(fields[index])
            Assert.Equal(
                FieldAttributes.Private | FieldAttributes.Static | FieldAttributes.InitOnly | FieldAttributes.HasFieldRVA,
                field.Attributes
            )
            Assert.Equal("__Utf8_" + index.ToString(), reader.GetString(field.Name))
            var signature = reader.GetBlobReader(field.Signature)
            Assert.Equal(uint8(0x06), signature.ReadByte())
            Assert.Equal(uint8(0x11), signature.ReadByte())
            let codedType = signature.ReadCompressedInteger()
            Assert.Equal(0, codedType & 3)
            let holder = reader.GetTypeDefinition(MetadataTokens.TypeDefinitionHandle(codedType >> 2))
            Assert.Equal(TypeAttributes.NestedPrivate, holder.Attributes & TypeAttributes.VisibilityMask)
            Assert.Equal(TypeAttributes.ExplicitLayout, holder.Attributes & TypeAttributes.LayoutMask)
            let layout = holder.GetLayout()
            Assert.Equal(1, layout.PackingSize)
            Assert.Equal(
                expected[index],
                Convert.ToHexString(
                    pe.GetSectionData(field.GetRelativeVirtualAddress()).GetContent(0, layout.Size).AsSpan()
                )
            )
        }
        using let refStream = File.OpenRead(reference)
        using let refPe = PEReader(refStream)
        let refReader = refPe.GetMetadataReader()
        Assert.Empty(refReader.FieldDefinitions)
        Assert.DoesNotContain(
            refReader.TypeDefinitions,
            (handle TypeDefinitionHandle) ->
            refReader.GetString(refReader.GetTypeDefinition(handle).Name).Contains("__Utf8", StringComparison.Ordinal)
        )
        let csharp = fixture.CompileCSharp(`using System;
public static class Consumer {
    public static int Run(byte[] value) => Utf8Data.Uses.Size(value);
}`, "Utf8ReferenceConsumer", reference)
        IlVerifier.Verify(csharp, []string{assembly})
    }

    @Theory
    @InlineData(`u8""`, "", 0)
    @InlineData(`u8"Aé😀\0"`, "41C3A9F09F988000", 8)
    @InlineData(`u8"\xFF"`, "C3BF", 2)
    @InlineData(`u8"\uD83D\uDE00"`, "F09F9880", 4)
    @InlineData(`u8"\U0001F600"`, "F09F9880", 4)
    @InlineData(`u8"\u007F\u0080\u07FF\u0800"`, "7FC280DFBFE0A080", 8)
    @InlineData(`u8"\uD7FF\uE000\U0010FFFF"`, "ED9FBFEE8080F48FBFBF", 10)
    @InlineData(`u8"\uFEFF\uFFFFé e\u0301"`, "EFBBBFEFBFBFC3A92065CC81", 12)
    @InlineData(`u8"$name ${sideEffect()} $$"`, "246E616D6520247B7369646545666665637428297D202424", 24)
    @InlineData(`u8"\0\a\b\f\n\r\t\v\'\"\\"`, "0007080C0A0D090B27225C", 11)
    func ExactBytesAndLogicalLengthUseTheRealDriver(expression string, hex string, length int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8Vector
import System
func Main() {
    let value = EXPRESSION
    Console.WriteLine(Convert.ToHexString(value))
    Console.WriteLine(value.Length)
}`.Replace("EXPRESSION", expression), "Utf8Vector", true)
        IlVerifier.Verify(assembly)
        Assert.Equal(hex + "\n" + length.ToString() + "\n", fixture.Run(assembly))
    }

    @Fact
    func LiteralOnlyFoldingPreservesTheNaturalReadonlySpanType() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package Utf8Fold
import System
func Kind(value readonly span[byte]) string -> "readonly"
func Kind(value span[byte]) string -> "writable"
func Kind(value string) string -> "text"
func Kind(value bytestring) string -> "bytes"
func Main() {
    let value = (u8"A" + (u8"é" + u8"\0")) + u8""
    Console.WriteLine(Kind(value))
    Console.WriteLine(Convert.ToHexString(value))
    Console.WriteLine(value.Length)
    Console.WriteLine(Convert.ToHexString(b"\xFF".ToArray()))
}`, "Utf8Fold", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("readonly\n41C3A900\n4\nFF\n", fixture.Run(assembly))
    }

    @Theory
    @InlineData(`u8"\uD800"`)
    @InlineData(`u8"\uDC00"`)
    @InlineData(`u8"\uDC00\uD800"`)
    @InlineData(`u8"\U0000D800"`)
    @InlineData(`u8"\U00110000"`)
    @InlineData(`u8"\x"`)
    @InlineData(`u8"\u123"`)
    @InlineData(`u8"\U1234567"`)
    @InlineData(`u8"\q"`)
    @InlineData(`u8"\uD800" + u8"\uDC00"`)
    func InvalidDecodedScalarsAndEscapesAreLocatedAndNeverEmit(expression string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package Utf8Reject\nfunc Main() {\n    let value = " + expression + "\n}",
            "Utf8Reject",
            true
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0632", output, StringComparison.Ordinal)
        Assert.Contains(".gs(3,", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("let a = u8\"A\"\nlet value = a + u8\"B\"", "GS0129", 4)
    @InlineData(`let value = cast[readonly span[byte]](u8"A") + u8"B"`, "GS0129", 3)
    @InlineData(`let value = (if true { u8"A" } else { u8"B" }) + u8"C"`, "GS0129", 3)
    @InlineData(`let value = u8"A" + "B"`, "GS0129", 3)
    @InlineData(`let value = u8"A" + b"B"`, "GS0129", 3)
    @InlineData(`var value span[byte] = u8"A"`, "GS0155", 3)
    @InlineData(`let value []byte = u8"A"`, "GS0155", 3)
    @InlineData(`let value string = u8"A"`, "GS0155", 3)
    @InlineData(`let value bytestring = u8"A"`, "GS0155", 3)
    @InlineData(`const value = u8"A"`, "GS0632", 3)
    @InlineData(`const value = (if true { u8"A" } else { u8"B" })`, "GS0632", 3)
    @InlineData("let span = u8\"A\"\nconst value = span", "GS0632", 4)
    @InlineData(`const value = default(readonly span[byte])`, "GS0632", 3)
    @InlineData(`let value = u8"A"u8"B"`, "GS0632", 3)
    @InlineData(`let value = (u8"A")u8"B"`, "GS0632", 3)
    @InlineData(`let value = "A"u8"B"`, "GS0632", 3)
    @InlineData(`u8"A"[0] = 66`, "GS0226", 3)
    @InlineData("let value = u8`A`", "GS0632", 3)
    @InlineData("let value = u8\"\"\"A\"\"\"", "GS0632", 3)
    @InlineData("let value = u8\"A\nB\"", "GS0003", 3)
    func RejectedNeighborsDoNotAcquireNewConversionsOrConstantSemantics(
        statement string,
        diagnostic string,
        line int32
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package Utf8Neighbor\nfunc Main() {\n" + statement + "\n}",
            "Utf8Neighbor",
            true
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error " + diagnostic + ":", output, StringComparison.Ordinal)
        Assert.Contains(".gs(" + line.ToString() + ",", output, StringComparison.Ordinal)
        Assert.DoesNotContain("Variable 'u8' doesn't exist.", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
    }
}
