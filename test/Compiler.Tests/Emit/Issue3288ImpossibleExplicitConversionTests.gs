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
