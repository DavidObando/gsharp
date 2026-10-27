// <copyright file="Issue3288ImpossibleExplicitConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #3288: impossible string-to-primitive conversions are rejected by
/// binding instead of reaching the emitter as GS9998.
@Collection("ConsoleIo")
class Issue3288ImpossibleExplicitConversionTests {
    @Theory
    @MemberData("InvalidConversions")
    func ImpossibleConversions_ReportUserDiagnosticsAtOperand(
        source string,
        expectedId string,
        expectedMessage string,
        startLine int32,
        startCharacter int32,
        endLine int32,
        endCharacter int32,
        coveredText string
    ) {
        let diagnostic = Assert.Single(GetErrors(source))
        Assert.Equal(expectedId, diagnostic.Id)
        Assert.Equal(expectedMessage, diagnostic.Message)
        Assert.Equal(startLine, diagnostic.Location.StartLine)
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter)
        Assert.Equal(endLine, diagnostic.Location.EndLine)
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter)
        Assert.Equal(coveredText, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func Classifier_SeparatesParsingFromRealExplicitConversions() {
        let dayOfWeek = TypeSymbol.FromClrType(typeof(DayOfWeek))
        let disposable = TypeSymbol.FromClrType(typeof(IDisposable))
        let nullableInt64 = NullableTypeSymbol.Get(TypeSymbol.Int64)
        let nullableInt32 = NullableTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(Conversion.Classify(TypeSymbol.String, TypeSymbol.Int32).Exists)
        Assert.False(Conversion.Classify(TypeSymbol.String, TypeSymbol.Bool).Exists)
        Assert.False(Conversion.Classify(disposable, TypeSymbol.Int32).Exists)
        Assert.True(Conversion.Classify(TypeSymbol.Float64, TypeSymbol.Int32).IsExplicit)
        Assert.True(Conversion.Classify(TypeSymbol.Int32, TypeSymbol.Int64).IsImplicit)
        Assert.True(Conversion.Classify(dayOfWeek, TypeSymbol.Int32).IsExplicit)
        Assert.True(Conversion.Classify(TypeSymbol.Int32, dayOfWeek).IsExplicit)
        Assert.True(Conversion.Classify(TypeSymbol.String, TypeSymbol.Object).IsImplicit)
        Assert.True(Conversion.Classify(TypeSymbol.Int32, TypeSymbol.Object).IsImplicit)
        Assert.True(Conversion.Classify(TypeSymbol.Object, TypeSymbol.Int32).IsExplicit)
        Assert.True(Conversion.Classify(nullableInt64, nullableInt32).IsExplicit)
    }

    @Fact
    func Gs0156_CastGuidance_IsProvablyActionable() {
        const invalidSource = "let value int32 = 3.14"
        let diagnostic = Assert.Single(GetErrors(invalidSource))
        Assert.Equal("GS0156", diagnostic.Id)
        Assert.Equal(
            "Cannot convert type 'float64' to 'int32'. An explicit conversion exists (are you missing a cast?)",
            diagnostic.Message
        )
        Assert.Equal(0, diagnostic.Location.StartLine)
        Assert.Equal(18, diagnostic.Location.StartCharacter)
        Assert.Equal(0, diagnostic.Location.EndLine)
        Assert.Equal(22, diagnostic.Location.EndCharacter)
        Assert.Equal("3.14", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        let remedy = CompileAndRun(`package Issue3288Guidance
import System

Console.WriteLine(int32(3.14))`)
        Assert.Equal(0, remedy.CompileExitCode)
        Assert.Equal(0, remedy.RunExitCode)
        Assert.Equal("3${Environment.NewLine}", remedy.Stdout)
        Assert.Equal(string.Empty, remedy.Stderr)
    }

    @Fact
    func NullableToUnderlying_Gs0156CastGuidance_IsProvablyActionable() {
        const invalidSource = "let nullableValue int32? = 42\nlet value int32 = nullableValue"
        let diagnostic = Assert.Single(GetErrors(invalidSource))
        Assert.Equal("GS0156", diagnostic.Id)
        Assert.Equal(
            "Cannot convert type 'int32?' to 'int32'. An explicit conversion exists (are you missing a cast?)",
            diagnostic.Message
        )
        Assert.Equal(1, diagnostic.Location.StartLine)
        Assert.Equal(18, diagnostic.Location.StartCharacter)
        Assert.Equal(1, diagnostic.Location.EndLine)
        Assert.Equal(31, diagnostic.Location.EndCharacter)
        Assert.Equal("nullableValue", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        let remedy = CompileAndRun(`package Issue3288NullableGuidance
import System

let nullableValue int32? = 42
Console.WriteLine(int32(nullableValue))`)
        Assert.Equal(0, remedy.CompileExitCode)
        Assert.Equal(0, remedy.RunExitCode)
        Assert.Equal("42${Environment.NewLine}", remedy.Stdout)
        Assert.Equal(string.Empty, remedy.Stderr)
    }

    @Fact
    func NullableNumericCasts_ExtractOnceBeforeConverting() {
        let result = CompileAndRun(`package Issue5400
import System

func Widen(value uint32?) uint64 -> cast[uint64](value)
func Narrow(value uint64?) uint32 -> uint32(value)
func Signed(value int32?) uint64 -> cast[uint64](value)
func ToFloat(value uint64?) float64 -> cast[float64](value)
func FromDecimal(value decimal?) int32 -> cast[int32](value)
func Checked(value uint64?) uint32 -> checked(cast[uint32](value))
func Lift(value uint32?) uint64? -> cast[uint64?](value)
func Wrap(value uint32) uint64? -> cast[uint64?](value)

class Counter {
    var Reads int32
    func Read(value uint32?) uint32? {
        Reads++
        return value
    }
}

Console.WriteLine(Widen(0u))
Console.WriteLine(Widen(2147483648))
Console.WriteLine(Widen(4294967295))
Console.WriteLine(Narrow(4294967296ul))
Console.WriteLine(Signed(-1))
Console.WriteLine(ToFloat(18446744073709551615) > 0)
Console.WriteLine(FromDecimal(19.75m))
Console.WriteLine(Checked(4294967295ul))
try {
    Console.WriteLine(Checked(4294967296ul))
} catch (e OverflowException) {
    Console.WriteLine("overflow")
}
try {
    Console.WriteLine(Checked(nil))
} catch (e InvalidOperationException) {
    Console.WriteLine("missing before overflow")
}
Console.WriteLine(Lift(nil) == nil)
Console.WriteLine(Lift(4294967295)!!)
Console.WriteLine(Wrap(4294967295)!!)
let counter = Counter()
Console.WriteLine(cast[uint64](counter.Read(4294967295)))
Console.WriteLine(counter.Reads)
try {
    Console.WriteLine(cast[uint64](counter.Read(nil)))
} catch (e InvalidOperationException) {
    Console.WriteLine("missing")
}
Console.WriteLine(counter.Reads)`)
        Assert.Equal(0, result.CompileExitCode)
        Assert.Equal(0, result.RunExitCode)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "0",
                "2147483648",
                "4294967295",
                "0",
                "18446744073709551615",
                "True",
                "19",
                "4294967295",
                "overflow",
                "missing before overflow",
                "True",
                "4294967295",
                "4294967295",
                "4294967295",
                "1",
                "missing",
                "2"
            ) +
                Environment.NewLine,
            result.Stdout
        )
        Assert.Equal(string.Empty, result.Stderr)
    }

    @Theory
    @InlineData("uint32", "uint64")
    @InlineData("uint64", "uint32")
    func NullableNumericConversions_RequireExplicitConversionAtOperand(from string, to string) {
        let source = "func Invalid(value ${from}?) $to -> value"
        let tree = SyntaxTree.Parse(SourceText.From(source, "Issue5400.gs"))
        using let output = MemoryStream()
        let result = Compilation(tree).Emit(output)
        Assert.False(result.Success)
        Assert.Equal(0L, output.Length)
        let diagnostic = Assert.Single(result.Diagnostics.Where((item Diagnostic) -> item.IsError))
        Assert.Equal("GS0156", diagnostic.Id)
        Assert.Equal(
            "Cannot convert type '${from}?' to '$to'. An explicit conversion exists (are you missing a cast?)",
            diagnostic.Message
        )
        Assert.Equal(0, diagnostic.Location.StartLine)
        Assert.Equal(38, diagnostic.Location.StartCharacter)
        Assert.Equal(0, diagnostic.Location.EndLine)
        Assert.Equal(43, diagnostic.Location.EndCharacter)
        Assert.Equal("value", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func NullableNumericCasts_InExpressionTrees_PreserveConversionAndMissingValueException() {
        let result = CompileAndRun(`package Issue5400ExpressionTree
import System
import System.Linq.Expressions

let tree Expression[Func[uint32?, uint64]] = (value uint32?) -> cast[uint64](value)
let convert = tree.Compile()
Console.WriteLine(tree.Body.NodeType)
Console.WriteLine(convert(4294967295))
try {
    Console.WriteLine(convert(nil))
} catch (e InvalidOperationException) {
    Console.WriteLine("missing")
}
let lifted Expression[Func[uint32?, uint64?]] = (value uint32?) -> cast[uint64?](value)
let lift = lifted.Compile()
Console.WriteLine(lift(nil) == nil)
Console.WriteLine(lift(4294967295)!!)`)
        Assert.Equal(0, result.CompileExitCode)
        Assert.Equal(0, result.RunExitCode)
        Assert.Equal(
            string.Join(Environment.NewLine, "Convert", "4294967295", "missing", "True", "4294967295") +
                Environment.NewLine,
            result.Stdout
        )
        Assert.Equal(string.Empty, result.Stderr)
    }

    @Fact
    func LegalConversionLattice_CompilesAndRuns() {
        let result = CompileAndRun(`package Issue3288Controls
import System

enum Shade { Zero, One, Two }

struct Wrapped { var Value int32 }
func operator explicit (value int32) Wrapped {
    return Wrapped{Value: value}
}

func CastClass[T class](value object) T -> T(value)
func CastStruct[T struct](value object) T -> T(value)
func Box[T](value T) object -> object(value)
func Narrow(value int64?) int32? -> int32?(value)

let widened int64 = 7
let boxed = Box[int32](8)
let nullableSource int64? = 9
let nullableValue = Narrow(nullableSource)
let referenced object = "reference"

Console.WriteLine(int32(3.14))
Console.WriteLine(widened)
Console.WriteLine(boxed.GetType())
Console.WriteLine(int32(boxed))
Console.WriteLine(int32(Shade.Two))
Console.WriteLine(Shade(1))
Console.WriteLine(nullableValue!!)
Console.WriteLine(Wrapped(10).Value)
Console.WriteLine(CastStruct[int32](object(11)))
Console.WriteLine(CastClass[string](referenced))
Console.WriteLine(int32.Parse("42"))

let wrongBox object = "wrong"
try {
    Console.WriteLine(int32(wrongBox))
} catch (e InvalidCastException) {
    Console.WriteLine(e.GetType().Name)
}`)
        Assert.Equal(0, result.CompileExitCode)
        Assert.Equal(0, result.RunExitCode)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "3",
                "7",
                "System.Int32",
                "8",
                "2",
                "1",
                "9",
                "10",
                "11",
                "reference",
                "42",
                "InvalidCastException"
            ) +
                Environment.NewLine,
            result.Stdout
        )
        Assert.Equal(string.Empty, result.Stderr)
    }

    shared {
        prop InvalidConversions TheoryData[string, string, string, int32, int32, int32, int32, string] -> {
            let values = TheoryData[string, string, string, int32, int32, int32, int32, string]()
            values.Add(
                "int32(\"wrong\")",
                "GS0155",
                "Cannot convert type 'string' to 'int32'.",
                0,
                6,
                0,
                13,
                "\"wrong\""
            )
            values.Add("bool(\"true\")", "GS0155", "Cannot convert type 'string' to 'bool'.", 0, 5, 0, 11, "\"true\"")
            values.Add(
                "func Id[T](value T) T -> value\nId[int32](\"wrong\")",
                "GS0154",
                "Parameter 'value' requires a value of type 'int32' but was given a value of type 'string'.",
                1,
                10,
                1,
                17,
                "\"wrong\""
            )
            values.Add(
                "class Box { func Id[T](value T) T -> value }\nBox().Id[int32](\"wrong\")",
                "GS0154",
                "Parameter 'value' requires a value of type 'int32' but was given a value of type 'string'.",
                1,
                16,
                1,
                23,
                "\"wrong\""
            )
            values.Add(
                "func (self string) Id[T](value T) T -> value\n\"receiver\".Id[int32](\"wrong\")",
                "GS0154",
                "Parameter 'value' requires a value of type 'int32' but was given a value of type 'string'.",
                1,
                21,
                1,
                28,
                "\"wrong\""
            )
            values
        }

        private func GetErrors(source string)[]Diagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source, "Issue3288.gs"))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError).ToArray()
        }

        private func CompileAndRun(source string)(
            CompileExitCode int32,
            RunExitCode int32,
            Stdout string,
            Stderr string
        ) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue3288", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let compilerStdout = StringWriter()
                using let compilerStderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(compilerStdout)
                Console.SetError(compilerStderr)
                var compileExitCode int32
                try {
                    compileExitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                if compileExitCode != 0 {
                    return (compileExitCode, -1, compilerStdout.ToString(), compilerStderr.ToString())
                }
                IlVerifier.Verify(assemblyPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(assemblyPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                return (
                    compileExitCode,
                    process.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
