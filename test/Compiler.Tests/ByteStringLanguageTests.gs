// <copyright file="ByteStringLanguageTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import Xunit

class ByteStringLanguageTests {
    @Fact
    func CodePointCollectionsBindVerifyAndRunWithIndependentCSharpContracts() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = fixture.CompileCSharp(`using System;
using Gsharp.Values;
namespace CodePointInteropContract;
public static class CodePointContract {
    public static ByteString Encode(ReadOnlySlice<int> source, CodePointEncoding policy) =>
        ByteString.FromCodePoints(source, policy);
    public static Slice<int> Decode(ByteString value, Utf8Decoding policy) =>
        value.DecodeCodePoints(policy);
    public static string InvalidPoint() {
        try {
            ByteString.FromCodePoints(ReadOnlySlice<int>.FromArray(new[] { 65, -1, 0xD800 }),
                CodePointEncoding.Strict);
            return "accepted";
        } catch (ByteStringEncodingException error) { return $"{error.InputKind}:{error.Offset}"; }
    }
    public static string InvalidBytes(ByteString value) {
        try { value.DecodeCodePoints(Utf8Decoding.Strict); return "accepted"; }
        catch (ByteStringEncodingException error) { return $"{error.InputKind}:{error.Offset}"; }
    }
}`, "CodePointContract")
        let assembly = fixture.Compile(`package CodePointInterop
import System
import Gsharp.Values
import CodePointInteropContract
func Main() {
    var points = slice[int32]{-1, 0, 65279, 128512, 65533, -1}
    let view readonly slice[int32] = points[1..5]
    let encoded bytestring = ByteString.FromCodePoints(view, CodePointEncoding.Strict)
    points[1] = 65
    Console.WriteLine(encoded == b"\0\xEF\xBB\xBF😀\xEF\xBF\xBD")
    Console.WriteLine(CodePointContract.Encode(view, CodePointEncoding.Strict) == b"A\xEF\xBB\xBF😀\xEF\xBF\xBD")
    Console.WriteLine(CodePointContract.Encode(points[4..], CodePointEncoding.ReplaceInvalidCodePoint) == b"\xEF\xBF\xBD\xEF\xBF\xBD")
    var first slice[int32] = encoded.DecodeCodePoints(Utf8Decoding.Strict)
    var second = CodePointContract.Decode(encoded, Utf8Decoding.ReplaceInvalidByte)
    first[0] = 66
    second[1] = 67
    for point in first { Console.WriteLine(point) }
    for point in second { Console.WriteLine(point) }
    for point in b"\xFF\x41\xE2\x82\xEF\xBF\xBD"[1..].DecodeCodePoints(Utf8Decoding.ReplaceInvalidByte) {
        Console.WriteLine(point)
    }
    Console.WriteLine(CodePointContract.InvalidPoint())
    Console.WriteLine(CodePointContract.InvalidBytes(b"\xFF\x41\xC2\xA2\xE2\x82"[1..]))
    let empty = b"".DecodeCodePoints(Utf8Decoding.Strict)
    Console.WriteLine(empty == default(Slice[int32]))
    Console.WriteLine(empty.Length)
}`, "codepoint-interop", true, "/reference:" + reference)
        IlVerifier.Verify(assembly, []string{reference})
        Assert.Equal(
            "True\nTrue\nTrue\n66\n65279\n128512\n65533\n0\n67\n128512\n65533\n65\n65533\n65533\n65533\nCodePoints:1\nUtf8:3\nFalse\n0\n",
            fixture.Run(assembly)
        )
    }

    @Fact
    func Utf8ScalarForeachBindsVerifiesAndRunsThroughIndependentCSharp() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = fixture.CompileCSharp(`using System;
using System.Text;
using Gsharp.Values;
namespace ScalarInteropContract;
public static class ScalarContract {
    public static string Items(ByteString value, Utf8Decoding policy) {
        var result = new StringBuilder();
        foreach (Utf8Item item in value.DecodeUtf8Scalars(policy))
            result.Append($"{item.ByteOffset}:{item.Value}:{item.ByteLength};");
        return result.ToString();
    }
    public static string Fault(ByteString value) {
        var iterator = value.DecodeUtf8Scalars(Utf8Decoding.Strict).GetEnumerator();
        var result = new StringBuilder();
        iterator.MoveNext();
        result.Append($"{iterator.Current.ByteOffset}:{iterator.Current.Value}:{iterator.Current.ByteLength};");
        for (int retry = 0; retry < 2; retry++) {
            try { result.Append(iterator.MoveNext() ? "advanced;" : "eof;"); }
            catch (ByteStringEncodingException error) {
                result.Append($"{error.InputKind}:{error.Offset};");
            }
        }
        return result.ToString();
    }
}`, "ScalarContract")
        let assembly = fixture.Compile(`package ScalarInterop
import System
import Gsharp.Values
import ScalarInteropContract
func Main() {
    let value = b"\xFF\xEF\xBB\xBF\0Aé😀\xEF\xBF\xBD\xE2\x82"[1..]
    for item in value.DecodeUtf8Scalars(Utf8Decoding.ReplaceInvalidByte) {
        Console.WriteLine("${item.ByteOffset}:${item.Value}:${item.ByteLength}")
    }
    Console.WriteLine(ScalarContract.Items(value, Utf8Decoding.ReplaceInvalidByte))
    Console.WriteLine(ScalarContract.Items(b"\xFFé😀\xFF"[1..7], Utf8Decoding.Strict))
    Console.WriteLine(ScalarContract.Fault(b"\xFF\x41\xE2\x82"[1..]))
    var iterator = b"A\xFF".DecodeUtf8Scalars(Utf8Decoding.Strict).GetEnumerator()
    Console.WriteLine(iterator.MoveNext())
    for var retry = 0; retry < 2; retry++ {
        try {
            Console.WriteLine(iterator.MoveNext())
        } catch (error ByteStringEncodingException) {
            Console.WriteLine("${error.InputKind}:${error.Offset}")
        }
    }
    for item in default(ByteString.Utf8Enumerable) {
        Console.WriteLine("unexpected")
    }
}`, "scalar-interop", true, "/reference:" + reference)
        IlVerifier.Verify(assembly, []string{reference})
        Assert.Equal(
            "0:65279:3\n3:0:1\n4:65:1\n5:233:2\n7:128512:4\n11:65533:3\n14:65533:1\n15:65533:1\n" +
                "0:65279:3;3:0:1;4:65:1;5:233:2;7:128512:4;11:65533:3;14:65533:1;15:65533:1;\n" +
                "0:233:2;2:128512:4;\n0:65:1;Utf8:1;Utf8:1;\nTrue\nUtf8:1\nUtf8:1\n",
            fixture.Run(assembly)
        )
    }

    @Fact
    func Utf8BoundariesBindVerifyAndInteroperateWithIndependentCSharpContracts() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = fixture.CompileCSharp(`using System;
using Gsharp.Values;
namespace Utf8InteropContract;
public static class Utf8Contract {
    public static ByteString Encode() =>
        ByteString.EncodeUtf8("\0\uFEFFé\U0001F600", Utf16Encoding.Strict);
    public static string Decode(ByteString value) => value.DecodeUtf8(Utf8Decoding.ReplaceInvalidByte);
    public static string Failure(ByteString value) {
        try { return value.DecodeUtf8(Utf8Decoding.Strict); }
        catch (ByteStringEncodingException error) {
            return $"{error.InputKind}:{error.Offset}";
        }
    }
    public static string NullText() {
        try { ByteString.EncodeUtf8(null!, Utf16Encoding.Strict); return "accepted"; }
        catch (ArgumentNullException error) { return error.ParamName!; }
    }
    public static string Unpaired() {
        try { ByteString.EncodeUtf8("A\uD800", Utf16Encoding.Strict); return "accepted"; }
        catch (ByteStringEncodingException error) {
            return $"{error.InputKind}:{error.Offset}";
        }
    }
}`, "Utf8Contract")
        let assembly = fixture.Compile(`package Utf8Interop
import System
import Gsharp.Values
import Utf8InteropContract
func Main() {
    Console.WriteLine(Utf8Contract.Encode() == b"\0\xEF\xBB\xBFé😀")
    Console.WriteLine(ByteString.EncodeUtf8("Aé😀", Utf16Encoding.Strict) == b"Aé😀")
    Console.WriteLine(b"é😀".DecodeUtf8(Utf8Decoding.Strict) == "é😀")
    Console.WriteLine(Utf8Contract.Decode(b"\xE2\x82\xEF\xBF\xBD") == "\uFFFD\uFFFD\uFFFD")
    Console.WriteLine(Utf8Contract.Failure(b"\xFF\x41\xE2\x82"[1..]))
    Console.WriteLine(Utf8Contract.NullText())
    Console.WriteLine(Utf8Contract.Unpaired())
    Console.WriteLine(b"".DecodeUtf8(Utf8Decoding.Strict).Length)
}`, "utf8-interop", true, "/reference:" + reference)
        IlVerifier.Verify(assembly, []string{reference})
        Assert.Equal("True\nTrue\nTrue\nTrue\nUtf8:1\ntext\nUtf16:1\n0\n", fixture.Run(assembly))
    }

    @Theory
    @MemberData("Programs")
    func ByteProgramsVerifyAndExecute(source string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(source, "bytes", true)
        IlVerifier.Verify(assembly)
        Assert.Equal(expected, fixture.Run(assembly))
    }

    @Theory
    @InlineData("Compiler", "gsc.dll")
    @InlineData("Repl", "gsi.dll")
    func StandaloneDriversResolveBytesWithoutExplicitReferences(directory string, driver string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Path.Combine(fixture.Directory, "driver.gs")
        File.WriteAllText(source, "import System\nConsole.WriteLine(b\"\\xFF\".Length)\n")
        let assembly = Path.Combine(fixture.Directory, "driver.dll")
        let arguments = if driver == "gsc.dll" {
            []string{"/target:exe", "/targetframework:net10.0", "/out:" + assembly, source}
        } else {
            []string{source}
        }
        let (code, stdout, stderr) = RunDriver(directory, driver, arguments)
        Assert.True(code == 0, stdout + stderr)
        Assert.Equal(
            "1\n",
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
    func FileDriversRejectLossyByteLiteralDecoding(directory string, driver string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = Path.Combine(fixture.Directory, "invalid.gs")
        let original = Encoding.UTF8.GetBytes("let value = b\"")
        let bytes = [original.Length + 3]uint8
        original.CopyTo(bytes, 0)
        bytes[original.Length] = 0xFF
        bytes[original.Length + 1] = 34
        bytes[original.Length + 2] = 10
        File.WriteAllBytes(source, bytes)
        let arguments = if driver == "gsc.dll" {
            []string{
                "/target:library",
                "/targetframework:net10.0",
                "/out:" + Path.Combine(fixture.Directory, "invalid.dll"),
                source
            }
        } else if driver == "gsfmt.dll" {
            []string{"--write", source}
        } else {
            []string{source}
        }
        let (code, stdout, stderr) = RunDriver(directory, driver, arguments)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0628", stdout + stderr, StringComparison.Ordinal)
        Assert.Equal(bytes, File.ReadAllBytes(source))
    }

    @Theory
    @InlineData("let value bytestring = \"text\"", "GS0155")
    @InlineData("let value string = b\"text\"", "GS0155")
    @InlineData("let value bytestring = nil", "GS0155")
    @InlineData("var value $$bytestring", "GS0113")
    @InlineData("let value = $$bytestring()", "GS0130")
    func InvalidByteStringUsesFailAtTheSource(statement string, diagnostic string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package ByteReject\nimport System\nfunc Main() {\n" + statement + "\n}",
            "reject",
            true
        )
        Assert.NotEqual(0, code)
        Assert.Contains(diagnostic, output, StringComparison.Ordinal)
        Assert.Contains(".gs(4,", output, StringComparison.Ordinal)
    }

    @Fact
    func MissingRuntimeReportsAnActionableDiagnosticAtTheNativeSpelling() {
        using let references = ReferenceResolver.WithReferences([]string{typeof(object).Assembly.Location})
        const source = "package MissingBytes\nfunc Use(value bytestring) { }"
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(references, SyntaxTree.Parse(source))
        let diagnostic = Assert.Single(
            compilation.GlobalScope.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0627"
        )
        Assert.Contains("Gsharp.Runtime.Values", diagnostic.Message, StringComparison.Ordinal)
        Assert.Equal("bytestring", source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length))
    }

    @Fact
    func NominalValuesRoundTripThroughAnIndependentCSharpConsumer() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = fixture.CompileCSharp(`using System.Collections.Generic;
using Gsharp.Values;
namespace ByteInteropContract;
public static class ByteContract {
    public static ByteString Transform(ByteString value) {
        var copy = value.ToArray();
        copy[0] = 99;
        return value[1..] + ByteString.CopyFrom(new byte[] { 128 });
    }
    public static int PresentLength(ByteString? value) => value?.Length ?? -1;
    public static int Lookup(ByteString key) {
        var values = new Dictionary<ByteString, int> {
            [ByteString.CopyFrom(new byte[] { 0, 255, 128 })] = 7
        };
        return values[key];
    }
}`, "ByteContract")
        let assembly = fixture.Compile(`package ByteInterop
import System
import ByteInteropContract
func Main() {
    let original = b"\x01\x00\xFF"
    let result = ByteContract.Transform(original)
    Console.WriteLine(original == b"\x01\x00\xFF")
    Console.WriteLine(result == b"\x00\xFF\x80")
    Console.WriteLine(ByteContract.PresentLength(nil))
    Console.WriteLine(ByteContract.PresentLength(b""))
    Console.WriteLine(ByteContract.Lookup(result))
}`, "interop", true, "/reference:" + reference)
        IlVerifier.Verify(assembly, []string{reference})
        Assert.Equal("True\nTrue\n-1\n0\n7\n", fixture.Run(assembly))
    }

    @Fact
    func ALookalikeRuntimeWithAnIncompleteSurfaceIsRejected() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = fixture.CompileCSharp(`namespace Gsharp.Values;
public struct ByteString {
    public int Length => 0;
    public static ByteString FromLiteral(string hex) => default;
}`, "Gsharp.Runtime.Values")
        using let references = ReferenceResolver.WithReferences([]string{typeof(object).Assembly.Location, reference})
        const source = "package WrongBytes\nfunc Use(value bytestring) { }"
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(references, SyntaxTree.Parse(source))
        let diagnostic = Assert.Single(
            compilation.GlobalScope.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0627"
        )
        Assert.Equal("bytestring", source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length))
    }

    @Theory
    @InlineData("class Constants {\nconst Value bytestring = b\"x\"\n}", "GS0376")
    @InlineData("func Optional(value bytestring = b\"x\") { }", "GS0265")
    @InlineData(`func Match(value bytestring) int32 {
return switch value {
case b"x": 1
default: 0
}
}`, "GS0170")
    func ByteLiteralsAreValuesRatherThanMetadataOrPatternConstants(declaration string, diagnostic string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile("package ByteConstants\n" + declaration, "constants", false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains(diagnostic, StringComparison.Ordinal), output)
        Assert.Contains(".gs(", output, StringComparison.Ordinal)
    }

    shared {
        internal func RunDriver(directory string, driver string, arguments[]string)(int32, string, string) {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            start.ArgumentList.Add(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", directory, driver)))
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start)!!
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            let exited = process.WaitForExit(30_000)
            if !exited {
                process.Kill(entireProcessTree: true)
            }
            Assert.True(exited, "literal driver timed out")
            return (
                process.ExitCode,
                stdout.GetAwaiter().GetResult().ReplaceLineEndings("\n"),
                stderr.GetAwaiter().GetResult().ReplaceLineEndings("\n")
            )
        }

        func Programs() sequence[[]object] {
            yield[]object{`package ByteDefaultConstruction
import System
func Main() {
    let empty = bytestring()
    Console.WriteLine(empty == b"")
    Console.WriteLine(empty.Length)
    Console.WriteLine(empty == Gsharp.Values.ByteString())
}`, "True\n0\nTrue\n"}
            yield[]object{`package ByteNul
import System
func Main() {
    Console.WriteLine("${b"` + "\u0000" + `"[0]}")
    Console.WriteLine("${b"\0"[0]}")
}`, "0\n0\n"}
            yield[]object{`package ByteArrayConversion
import System
func Main() {
    let inferred = []bytestring{b"x", b"\xFF"}
    let fixed = [2]bytestring
    let boxed object = inferred[1]
    Console.WriteLine(bytestring(boxed) == b"\xFF")
    Console.WriteLine(bytestring?(boxed) == b"\xFF")
    Console.WriteLine(inferred[0] == b"x")
    Console.WriteLine(fixed[1] == b"")
}`, "True\nTrue\nTrue\nTrue\n"}
            yield[]object{`package ByteCallable
import System
func bytestring(value object) int32 -> 42
func bytestring() int32 -> 17
func Main() {
    let values = []bytestring{b"x"}
    Console.WriteLine(bytestring(values[0]))
    Console.WriteLine($bytestring(values[0]))
    Console.WriteLine(bytestring())
    Console.WriteLine($bytestring())
}`, "42\n42\n17\n17\n"}
            yield[]object{`package ByteProtocol
import System
func ReadPayload(packet bytestring) bytestring {
    if packet.Length < 4 || !packet.StartsWith(b"\xCA\xFE") {
        throw FormatException("Invalid packet header")
    }
    let length = int32(packet[2]) * 256 + int32(packet[3])
    if length != packet.Length - 4 { throw FormatException("Invalid length") }
    return packet[4..]
}
func Main() {
    let payload = ReadPayload(b"\xCA\xFE\x00\x04a\xFF\x00:")
    Console.WriteLine(Convert.ToHexString(payload.ToArray()))
    Console.WriteLine(payload.IndexOf(b":"))
    Console.WriteLine(payload[..^1] == b"a\xFF\0")
    Console.WriteLine(bytestring.Empty == default(bytestring))
    let absent bytestring? = nil
    let present bytestring? = b""
    Console.WriteLine(absent == present)
    var sum = 0
    for value in payload { sum += int32(value) }
    Console.WriteLine(sum)
}`, "61FF003A\n3\nTrue\nTrue\nFalse\n410\n"}
            yield[]object{`package ByteEscapes
import System
func Main() {
    let value = b"\u00E9\U0001F600\u0000\xFF$name${notInterpolation}"
    Console.WriteLine(Convert.ToHexString(value[..8].ToArray()))
    Console.WriteLine(value[8..] == b"$name${notInterpolation}")
    Console.WriteLine(b"\x000" == b"\0\x30")
    Console.WriteLine(b"\xFF" > b"\x7F")
    Console.WriteLine("${b"${".Length}")
}`, "C3A9F09F988000FF\nTrue\nTrue\nTrue\n2\n"}
            yield[]object{`package ByteShadow
import System
class bytestring { var Value int32 }
func Main() {
    let ordinary bytestring = bytestring{Value: 7}
    let escaped $bytestring = ordinary
    let literal = b"\xFF"
    let nominal Gsharp.Values.ByteString = literal
    Console.WriteLine(escaped.Value)
    Console.WriteLine(nominal.Length)
    Console.WriteLine(literal == b"\xFF")
}`, "7\n1\nTrue\n"}
            yield[]object{`package ByteAlias
import System
type bytestring = int32
func Main() {
    let plain bytestring = 7
    let escaped $bytestring = 9
    Console.WriteLine(plain + escaped)
    Console.WriteLine(b"still bytes".Length)
}`, "16\n11\n"}
            yield[]object{`package ByteTypeParameter
import System
func Echo[bytestring any](value bytestring) bytestring -> value
func Main() {
    Console.WriteLine(Echo[int32](17))
    Console.WriteLine(b"native".Length)
}`, "17\n6\n"}
            yield[]object{`package ByteEvaluation
import System
var trace string = ""
func Receiver() bytestring {
    trace += "R"
    return b"abcd"
}
func Low() int32 {
    trace += "L"
    return 1
}
func High() int32 {
    trace += "H"
    return 3
}
func Literal() bytestring -> b"\x00\xFF"
func Main() {
    let part = Receiver()[Low()..High()]
    Console.WriteLine(trace)
    Console.WriteLine(part == b"bc")
    Literal()
    let before = GC.GetAllocatedBytesForCurrentThread()
    var count = 0
    for var i = 0; i < 10000; i++ { count += Literal().Length }
    let allocated = GC.GetAllocatedBytesForCurrentThread() - before
    Console.WriteLine(count)
    Console.WriteLine(allocated)
}
Main()`, "RLH\nTrue\n20000\n0\n"}
        }
    }
}
