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
        private func RunDriver(directory string, driver string, arguments[]string)(int32, string, string) {
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
            Assert.True(exited, "byte-string driver timed out")
            return (
                process.ExitCode,
                stdout.GetAwaiter().GetResult().ReplaceLineEndings("\n"),
                stderr.GetAwaiter().GetResult().ReplaceLineEndings("\n")
            )
        }

        func Programs() sequence[[]object] {
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
