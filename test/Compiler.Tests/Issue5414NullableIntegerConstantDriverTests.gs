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

    @Fact
    func EnumArguments_RequireExplicitIntegerConversion() {
        for member in[]string{"Zero", "One"} {
            Check(`package EnumProbe
enum Number { Zero = 0, One = 1 }
func F(value uint32?) bool -> value == 0
func Test() bool -> F(Number.` + member + `)
`, "", "GS0154", "4,23,4," + (30 + member.Length).ToString())
        }
        Check(`import System
enum Number { Zero = 0, One = 1 }
func F(value uint32?) uint32 -> value ?? 99
Console.WriteLine(F(uint32(Number.Zero)))
Console.WriteLine(F(uint32(Number.One)))
`, "0\n1\n")
    }

    @Fact
    func EnumTupleReturns_RequireExplicitIntegerConversion() {
        for member in[]string{"Zero", "One"} {
            Check(`package EnumProbe
enum Number { Zero = 0, One = 1 }
func Pair() (uint32?, int32) -> (Number.` + member + `, 9)
`, "", "GS0156", "3,33,3," + (45 + member.Length).ToString())
        }
        Check(`import System
enum Number { Zero = 0, One = 1 }
func Zero() (uint32?, int32) -> (uint32(Number.Zero), 9)
func One() (uint32?, int32) -> (uint32(Number.One), 9)
let zero = Zero()
let one = One()
Console.WriteLine(zero.Item1 ?? 99)
Console.WriteLine(zero.Item2)
Console.WriteLine(one.Item1 ?? 99)
Console.WriteLine(one.Item2)
`, "0\n9\n1\n9\n")
    }

    @Fact
    func NullableIntegerOverloads_RankUnderlyingConversionsBeforeChoosingBody() {
        Check(`import System
func F(value int32?) string -> "signed"
func F(value uint32?) string -> "unsigned"
func Reversed(value uint32?) string -> "unsigned"
func Reversed(value int32?) string -> "signed"
func Widen(value int32?) string -> "int32"
func Widen(value int64?) string -> "int64"
func Width(value uint32?) string -> "uint32"
func Width(value uint64?) string -> "uint64"
func Exact(value int32) string -> "nonnullable"
func Exact(value uint32?) string -> "nullable"
func Many(values ...int32?) string -> "signed-tail"
func Many(values ...uint32?) string -> "unsigned-tail"
Console.WriteLine(F(0))
Console.WriteLine(Reversed(0))
Console.WriteLine(F(4294967295))
Console.WriteLine(Widen(0))
let small int16 = 7
Console.WriteLine(Widen(small))
Console.WriteLine(Width(0))
Console.WriteLine(Width(5000000000))
Console.WriteLine(Exact(0))
Console.WriteLine(Many(0, 42))
`, "signed\nsigned\nunsigned\nint32\nint32\nuint32\nuint64\nnonnullable\nsigned-tail\n")
    }

    @Fact
    func NullableIntegerOverloads_PreservePriorityAgainstOtherTargets() {
        Check(`import System
func F(value int64?) string -> "integer"
func F(value float64?) string -> "float"
func Reversed(value float64?) string -> "float"
func Reversed(value int64?) string -> "integer"
func Box(value int64?) string -> "integer"
func Box(value object) string -> "object"
func BoxReversed(value object) string -> "object"
func BoxReversed(value int64?) string -> "integer"
Console.WriteLine(F(0))
Console.WriteLine(Reversed(0))
Console.WriteLine(Box(0))
Console.WriteLine(BoxReversed(0))
let value int32 = 7
Console.WriteLine(F(value))
Console.WriteLine(Reversed(value))
Console.WriteLine(Box(value))
Console.WriteLine(BoxReversed(value))
`, "integer\ninteger\ninteger\ninteger\ninteger\ninteger\ninteger\ninteger\n")
    }

    @Fact
    func ImportedNullableIntegerOverloads_CompareUnderlyingTargets() {
        using let fixture = GSharp.Core.Tests.CSharpFixture(`namespace RankingContract {
public static class NullableRanks {
    public static string F(byte? value) => "byte";
    public static string F(ushort? value) => "ushort";
    public static string Signed(int? value) => "signed";
    public static string Signed(uint? value) => "unsigned";
    public static string Box(uint? value) => "nullable";
    public static string Box(object value) => "object";
}}`)
        Check(`import System
import RankingContract
Console.WriteLine(NullableRanks.F(0))
Console.WriteLine(NullableRanks.F(255))
Console.WriteLine(NullableRanks.F(256))
Console.WriteLine(NullableRanks.F(65535))
Console.WriteLine(NullableRanks.F(uint8(0)))
Console.WriteLine(NullableRanks.Signed(0))
Console.WriteLine(NullableRanks.Signed(4294967295))
Console.WriteLine(NullableRanks.Box(0))
`, "byte\nbyte\nushort\nushort\nbyte\nsigned\nunsigned\nnullable\n", additionalReference: fixture.AssemblyPath)
    }

    @Fact
    func NullableNumericTargets_UseConversionDirectionInsteadOfUnderlyingIdentity() {
        Check(`import System
func F(value uint8?) string -> "byte"
func F(value int32?) string -> "int"
func Reversed(value int32?) string -> "int"
func Reversed(value uint8?) string -> "byte"
Console.WriteLine(F(0))
Console.WriteLine(Reversed(0))
Console.WriteLine(F(255))
Console.WriteLine(F(256))
let value int32 = 0
Console.WriteLine(F(value))
`, "byte\nbyte\nbyte\nint\nint\n")
    }

    @Theory
    @InlineData("Direction", "byte\nbyte\n")
    @InlineData("Readonly", "nullable\n")
    @InlineData("Interface", "byte\n")
    func ImportedNullableNumericTargets_RankValueReadonlyAndBoxingTargets(method string, expected string) {
        using let fixture = GSharp.Core.Tests.CSharpFixture(`namespace FinalRankingContract {
public static class Choices {
    public static string Direction(byte? value) => "byte";
    public static string Direction(int? value) => "int";
    public static string Reversed(int? value) => "int";
    public static string Reversed(byte? value) => "byte";
    public static string Readonly(in uint? value) => "nullable";
    public static string Readonly(object value) => "object";
    public static string Interface(byte? value) => "byte";
    public static string Interface(System.IComparable value) => "interface";
}}`)
        var source = "import System\nimport FinalRankingContract\nConsole.WriteLine(Choices." + method + "(0))\n"
        if method == "Direction" {
            source += "Console.WriteLine(Choices.Reversed(0))\n"
        }
        Check(source, expected, additionalReference: fixture.AssemblyPath)
    }

    @Fact
    func BaseConstructors_UseSharedNullableNumericRankingWithoutRepeatingArguments() {
        Check(`import System
open class B {
    init(value int32?) { Console.WriteLine("signed") }
    init(value uint32?) { Console.WriteLine("unsigned") }
}
class D : B { init() : base(0) {} }
open class Reverse {
    init(value uint32?) { Console.WriteLine("unsigned") }
    init(value int32?) { Console.WriteLine("signed") }
}
class Reversed : Reverse { init() : base(0) {} }
open class Generic[T] {
    init(marker T, value int32?, extra int32 = 9) { Console.WriteLine("generic-signed") }
    init(marker T, value uint32?, extra int32 = 9) { Console.WriteLine("generic-unsigned") }
}
func Mark() string {
    Console.WriteLine("marker")
    return "tag"
}
class Closed : Generic[string] { init() : base(Mark(), 0) {} }
let direct = D()
let reversed = Reversed()
let closed = Closed()
`, "signed\nsigned\nmarker\ngeneric-signed\n")
    }

    @Fact
    func ImportedSetterOnlyIndexers_UseSharedNullableNumericRanking() {
        using let fixture = GSharp.Core.Tests.CSharpFixture(`namespace SetterRankingContract {
public sealed class Forward {
    public string Selected = "";
    public int this[long? key] { set { Selected = "signed"; } }
    public int this[ulong? key] { set { Selected = "unsigned"; } }
}
public sealed class Reversed {
    public string Selected = "";
    public int this[ulong? key] { set { Selected = "unsigned"; } }
    public int this[long? key] { set { Selected = "signed"; } }
}}`)
        Check(`import System
import SetterRankingContract
let first = Forward()
first[0] = 9
Console.WriteLine(first.Selected)
let second = Reversed()
second[0] = 9
Console.WriteLine(second.Selected)
`, "signed\nsigned\n", additionalReference: fixture.AssemblyPath)
    }

    @Fact
    func BaseConstructors_CompareConstantNumericTargetsBeforeOptionalArity() {
        Check(`import System
open class B {
    init(value uint8) { Console.WriteLine("byte") }
    init(value int64, extra int32 = 0) { Console.WriteLine("wide") }
}
open class Reverse {
    init(value int64, extra int32 = 0) { Console.WriteLine("wide") }
    init(value uint8) { Console.WriteLine("byte") }
}
open class Identity {
    init(value uint8, extra int32 = 0) { Console.WriteLine("byte") }
    init(value int32) { Console.WriteLine("int") }
}
func Mark() int32 {
    Console.WriteLine("marker")
    return 0
}
class D : B { init() : base(0) {} }
class Reversed : Reverse { init() : base(0) {} }
class Upper : B { init() : base(255) {} }
class Outside : B { init() : base(256) {} }
class Explicit : B { init() : base(0, 9) {} }
class Nonconstant : B { init() : base(Mark()) {} }
class Exact : Identity { init() : base(0) {} }
let direct = D()
let reversed = Reversed()
let upper = Upper()
let outside = Outside()
let withExtra = Explicit()
let nonconstant = Nonconstant()
let exact = Exact()
`, "byte\nbyte\nbyte\nwide\nwide\nmarker\nwide\nint\n")
    }

    @Fact
    func IntegerConstantOverloads_CompareNumericTargetsAndPreserveTrueIdentity() {
        using let fixture = GSharp.Core.Tests.CSharpFixture(`namespace ConstantRankingContract {
public static class Choices {
    public static string F(byte value) => "byte";
    public static string F(long value, int extra = 0) => "wide";
    public static string Reversed(long value, int extra = 0) => "wide";
    public static string Reversed(byte value) => "byte";
    public static string Exact(byte value) => "byte";
    public static string Exact(int value) => "int";
    public static string Control() => F(0);
}}`)
        Check(`import System
import ConstantRankingContract
func F(value uint8) string -> "byte"
func F(value int64, extra int32 = 0) string -> "wide"
func Reversed(value int64, extra int32 = 0) string -> "wide"
func Reversed(value uint8) string -> "byte"
func Exact(value uint8) string -> "byte"
func Exact(value int32) string -> "int"
Console.WriteLine(F(0))
Console.WriteLine(Reversed(0))
Console.WriteLine(F(255))
Console.WriteLine(F(256))
Console.WriteLine(F(0, 9))
let value int32 = 0
Console.WriteLine(F(value))
Console.WriteLine(Exact(0))
Console.WriteLine(Exact(uint8(0)))
Console.WriteLine(Choices.F(0))
Console.WriteLine(Choices.Reversed(0))
Console.WriteLine(Choices.F(255))
Console.WriteLine(Choices.F(256))
Console.WriteLine(Choices.F(0, 9))
Console.WriteLine(Choices.F(value))
Console.WriteLine(Choices.Exact(0))
Console.WriteLine(Choices.Exact(uint8(0)))
Console.WriteLine(Choices.Control())
`, "byte\nbyte\nbyte\nwide\nwide\nwide\nint\nbyte\nbyte\nbyte\nbyte\nwide\nwide\nwide\nint\nbyte\nbyte\n", additionalReference: fixture.AssemblyPath)
    }

    shared {
        private func Check(
            sourceText string,
            expected string,
            diagnosticId string? = nil,
            diagnosticSpan string? = nil,
            additionalReference string? = nil
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
            if additionalReference != nil {
                arguments.Add("/r:" + additionalReference)
                File.Copy(additionalReference, Path.Combine(fixture.Directory, Path.GetFileName(additionalReference)))
            }
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
            if additionalReference != nil {
                verify.Add("-r")
                verify.Add(additionalReference)
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
