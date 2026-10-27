package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5414NullableIntegerConstantDriverTests {
    @Fact
    func NullableArguments_KeepRepresentableConstantsAndRejectInvalidNarrowing() {
        for expression in[]string{"-1", "4294967296", "value"} {
            Check(`package Rejected
func F(value uint32?) {}
func Test(value int32) { F(` + expression + `) }
`, "", "GS0154", "3,28,3," + (28 + expression.Length).ToString())
        }
        Check(`import System
func F(value uint32?) bool -> value == 0
func Test() bool -> F(0)
func Byte(value uint8?) uint8 -> value ?? uint8(0)
func Short(value uint16?) uint16 -> value ?? uint16(0)
func Unsigned(value uint32?) uint32 -> value ?? 0
func Wide(value uint64?) uint64 -> value ?? 0
func Signed(value int8?) int8 -> value ?? int8(0)
func SignedShort(value int16?) int16 -> value ?? int16(0)
Console.WriteLine(Test())
Console.WriteLine(F(42))
Console.WriteLine(Byte(255))
Console.WriteLine(Short(65535))
Console.WriteLine(Unsigned(+(-(-42))))
Console.WriteLine(Unsigned(4294967295))
Console.WriteLine(Wide(18446744073709551615))
Console.WriteLine(Signed(-128))
Console.WriteLine(SignedShort(-32768))
Console.WriteLine(Unsigned(nil))
let small uint16 = 17
Console.WriteLine(Unsigned(small))
`, "True\nFalse\n255\n65535\n42\n4294967295\n18446744073709551615\n-128\n-32768\n0\n17\n")
    }

    @Fact
    func TupleReturns_KeepNestedConstantsAndEvaluateOtherElementsOnceInOrder() {
        for expression in[]string{"-1", "4294967296", "value"} {
            Check(`package Rejected
func Test(value int32) (uint32?, int32) -> (` + expression + `, 9)
`, "", "GS0156", "2,44,2," + (49 + expression.Length).ToString())
        }
        Check(`import System
var trace string = ""
func Mark(name string) int32 {
    trace += name
    return trace.Length
}
func Pair() (uint32?, int32) -> (0, 9)
func Nested() ((uint8?, int32), (uint16?, int32), uint32?) ->
    ((255, Mark("a")), (65535, Mark("b")), +(-(-42)))
func Signed() (int8?, int16?) -> (-128, -32768)
func Wide() (uint32?, uint64?) -> (4294967295, 18446744073709551615)
let pair = Pair()
Console.WriteLine(pair.Item1 ?? 99)
Console.WriteLine(pair.Item2)
let nested = Nested()
Console.WriteLine(nested.Item1.Item1 ?? 0)
Console.WriteLine(nested.Item1.Item2)
Console.WriteLine(nested.Item2.Item1 ?? 0)
Console.WriteLine(nested.Item2.Item2)
Console.WriteLine(nested.Item3 ?? 0)
Console.WriteLine(trace)
let signed = Signed()
Console.WriteLine(signed.Item1 ?? 0)
Console.WriteLine(signed.Item2 ?? 0)
let wide = Wide()
Console.WriteLine(wide.Item1 ?? 0)
Console.WriteLine(wide.Item2 ?? 0)
`, "0\n9\n255\n1\n65535\n2\n42\nab\n-128\n-32768\n4294967295\n18446744073709551615\n")
    }

    shared {
        private func Check(
            sourceText string,
            expected string,
            diagnosticId string? = nil,
            diagnosticSpan string? = nil
        ) {
            using let fixture = NativeSliceLanguageTests.Fixture()
            let source = Path.Combine(fixture.Directory, "Constants.gs")
            let image = Path.Combine(fixture.Directory, "Constants.dll")
            let reference = Path.Combine(fixture.Directory, "Constants.ref.dll")
            let pdb = Path.ChangeExtension(image, ".pdb")
            File.WriteAllText(source, sourceText)
            let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator)
                .Where((path string) -> Path.GetDirectoryName(path) == runtimeDirectory)
                .OrderBy((path string) -> path, StringComparer.Ordinal)
                .ToArray()
            Assert.NotEmpty(references)
            let arguments = List[string]{
                typeof(Program).Assembly.Location,
                source,
                "/target:exe",
                "/targetframework:net10.0",
                "--nullability=platform-types",
                "/deterministic+",
                "/debug:portable",
                "/out:" + image,
                "/refout:" + reference
            }
            arguments.AddRange(references.Select((path string) -> "/r:" + path))
            let result = Run(arguments)
            let diagnostics = Encoding.UTF8.GetString(result.Output)
            if diagnosticId != nil {
                Assert.Equal(1, result.Code)
                Assert.Equal("Failed.\n", result.Error.ReplaceLineEndings("\n"))
                let located = Assert.Single(
                    Regex.Matches(diagnostics, `(?m)^([^\r\n]+)\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
                )
                Assert.Equal(source, located.Groups[1].Value)
                Assert.Equal(diagnosticSpan, located.Groups[2].Value)
                Assert.Equal(diagnosticId, located.Groups[3].Value)
                Assert.False(File.Exists(image))
                Assert.False(File.Exists(reference))
                Assert.False(File.Exists(pdb))
                Assert.False(File.Exists(Path.ChangeExtension(image, ".runtimeconfig.json")))
                return
            }
            Assert.True(result.Code == 0, diagnostics + result.Error)
            Assert.Empty(result.Error)
            let bytes = File.ReadAllBytes(image)
            let refBytes = File.ReadAllBytes(reference)
            let pdbBytes = File.ReadAllBytes(pdb)
            Assert.NotEmpty(bytes)
            Assert.NotEmpty(refBytes)
            Assert.NotEmpty(pdbBytes)
            let verify = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
            for path in references {
                verify.Add("-r")
                verify.Add(path)
            }
            let verified = Run(verify)
            Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
            Assert.Empty(verified.Error)
            let executed = Run([]string{image})
            Assert.Equal(0, executed.Code)
            Assert.Empty(executed.Error)
            Assert.Equal(Encoding.UTF8.GetBytes(expected.ReplaceLineEndings(Environment.NewLine)), executed.Output)
            let repeated = Run(arguments)
            Assert.Equal(0, repeated.Code)
            Assert.Equal(result.Output, repeated.Output)
            Assert.Equal(result.Error, repeated.Error)
            Assert.Equal(bytes, File.ReadAllBytes(image))
            Assert.Equal(refBytes, File.ReadAllBytes(reference))
            Assert.Equal(pdbBytes, File.ReadAllBytes(pdb))
        }

        private func Run(arguments IEnumerable[string])(Code int32, Output[]uint8, Error string) {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(output)
            let error = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("Nullable integer constant driver exceeded 30 seconds.")
            }
            read.GetAwaiter().GetResult()
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
