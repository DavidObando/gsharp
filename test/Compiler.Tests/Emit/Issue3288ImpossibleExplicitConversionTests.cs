// <copyright file="Issue3288ImpossibleExplicitConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3288: impossible string-to-primitive conversions are rejected by
/// binding instead of reaching the emitter as GS9998.
/// </summary>
[Collection("ConsoleIo")]
public sealed class Issue3288ImpossibleExplicitConversionTests
{
    public static TheoryData<string, string, string, int, int, int, int, string> InvalidConversions => new()
    {
        {
            "int32(\"wrong\")",
            "GS0155",
            "Cannot convert type 'string' to 'int32'.",
            0,
            6,
            0,
            13,
            "\"wrong\""
        },
        {
            "bool(\"true\")",
            "GS0155",
            "Cannot convert type 'string' to 'bool'.",
            0,
            5,
            0,
            11,
            "\"true\""
        },
        {
            "func Id[T](value T) T -> value\nId[int32](\"wrong\")",
            "GS0154",
            "Parameter 'value' requires a value of type 'int32' but was given a value of type 'string'.",
            1,
            10,
            1,
            17,
            "\"wrong\""
        },
        {
            "class Box { func Id[T](value T) T -> value }\nBox().Id[int32](\"wrong\")",
            "GS0155",
            "Cannot convert type 'string' to 'int32'.",
            1,
            16,
            1,
            23,
            "\"wrong\""
        },
        {
            "func (self string) Id[T](value T) T -> value\n\"receiver\".Id[int32](\"wrong\")",
            "GS0155",
            "Cannot convert type 'string' to 'int32'.",
            1,
            21,
            1,
            28,
            "\"wrong\""
        },
    };

    [Theory]
    [MemberData(nameof(InvalidConversions))]
    public void ImpossibleConversions_ReportUserDiagnosticsAtOperand(
        string source,
        string expectedId,
        string expectedMessage,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        string coveredText)
    {
        var diagnostic = Assert.Single(GetErrors(source));

        Assert.Equal(expectedId, diagnostic.Id);
        Assert.Equal(expectedMessage, diagnostic.Message);
        Assert.Equal(startLine, diagnostic.Location.StartLine);
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter);
        Assert.Equal(endLine, diagnostic.Location.EndLine);
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter);
        Assert.Equal(coveredText, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void Classifier_SeparatesParsingFromRealExplicitConversions()
    {
        var dayOfWeek = TypeSymbol.FromClrType(typeof(DayOfWeek));
        var disposable = TypeSymbol.FromClrType(typeof(IDisposable));
        var nullableInt64 = NullableTypeSymbol.Get(TypeSymbol.Int64);
        var nullableInt32 = NullableTypeSymbol.Get(TypeSymbol.Int32);

        Assert.False(Conversion.Classify(TypeSymbol.String, TypeSymbol.Int32).Exists);
        Assert.False(Conversion.Classify(TypeSymbol.String, TypeSymbol.Bool).Exists);
        Assert.False(Conversion.Classify(disposable, TypeSymbol.Int32).Exists);
        Assert.True(Conversion.Classify(TypeSymbol.Float64, TypeSymbol.Int32).IsExplicit);
        Assert.True(Conversion.Classify(TypeSymbol.Int32, TypeSymbol.Int64).IsImplicit);
        Assert.True(Conversion.Classify(dayOfWeek, TypeSymbol.Int32).IsExplicit);
        Assert.True(Conversion.Classify(TypeSymbol.Int32, dayOfWeek).IsExplicit);
        Assert.True(Conversion.Classify(TypeSymbol.String, TypeSymbol.Object).IsImplicit);
        Assert.True(Conversion.Classify(TypeSymbol.Int32, TypeSymbol.Object).IsImplicit);
        Assert.True(Conversion.Classify(TypeSymbol.Object, TypeSymbol.Int32).IsExplicit);
        Assert.True(Conversion.Classify(nullableInt64, nullableInt32).IsExplicit);
    }

    [Fact]
    public void Gs0156_CastGuidance_IsProvablyActionable()
    {
        const string invalidSource = "let value int32 = 3.14";
        var diagnostic = Assert.Single(GetErrors(invalidSource));

        Assert.Equal("GS0156", diagnostic.Id);
        Assert.Equal(
            "Cannot convert type 'float64' to 'int32'. An explicit conversion exists (are you missing a cast?)",
            diagnostic.Message);
        Assert.Equal(0, diagnostic.Location.StartLine);
        Assert.Equal(18, diagnostic.Location.StartCharacter);
        Assert.Equal(0, diagnostic.Location.EndLine);
        Assert.Equal(22, diagnostic.Location.EndCharacter);
        Assert.Equal("3.14", diagnostic.Location.Text.ToString(diagnostic.Location.Span));

        var remedy = CompileAndRun("""
            package Issue3288Guidance
            import System

            Console.WriteLine(int32(3.14))
            """);

        Assert.Equal(0, remedy.CompileExitCode);
        Assert.Equal(0, remedy.RunExitCode);
        Assert.Equal($"3{Environment.NewLine}", remedy.Stdout);
        Assert.Equal(string.Empty, remedy.Stderr);
    }

    [Fact]
    public void NullableToUnderlying_Gs0156CastGuidance_IsProvablyActionable()
    {
        const string invalidSource = """
            let nullableValue int32? = 42
            let value int32 = nullableValue
            """;
        var diagnostic = Assert.Single(GetErrors(invalidSource));

        Assert.Equal("GS0156", diagnostic.Id);
        Assert.Equal(
            "Cannot convert type 'int32?' to 'int32'. An explicit conversion exists (are you missing a cast?)",
            diagnostic.Message);
        Assert.Equal(1, diagnostic.Location.StartLine);
        Assert.Equal(18, diagnostic.Location.StartCharacter);
        Assert.Equal(1, diagnostic.Location.EndLine);
        Assert.Equal(31, diagnostic.Location.EndCharacter);
        Assert.Equal("nullableValue", diagnostic.Location.Text.ToString(diagnostic.Location.Span));

        var remedy = CompileAndRun("""
            package Issue3288NullableGuidance
            import System

            let nullableValue int32? = 42
            Console.WriteLine(int32(nullableValue))
            """);

        Assert.Equal(0, remedy.CompileExitCode);
        Assert.Equal(0, remedy.RunExitCode);
        Assert.Equal($"42{Environment.NewLine}", remedy.Stdout);
        Assert.Equal(string.Empty, remedy.Stderr);
    }

    [Fact]
    public void LegalConversionLattice_CompilesAndRuns()
    {
        var result = CompileAndRun("""
            package Issue3288Controls
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
            }
            """);

        Assert.Equal(0, result.CompileExitCode);
        Assert.Equal(0, result.RunExitCode);
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
                "InvalidCastException") + Environment.NewLine,
            result.Stdout);
        Assert.Equal(string.Empty, result.Stderr);
    }

    private static Diagnostic[] GetErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, "Issue3288.gs"));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();
    }

    private static (int CompileExitCode, int RunExitCode, string Stdout, string Stderr) CompileAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3288",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var compilerStdout = new StringWriter();
            using var compilerStderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(compilerStdout);
            Console.SetError(compilerStderr);
            int compileExitCode;
            try
            {
                compileExitCode = Program.Main(new[]
                {
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            if (compileExitCode != 0)
            {
                return (
                    compileExitCode,
                    -1,
                    compilerStdout.ToString(),
                    compilerStderr.ToString());
            }

            IlVerifier.Verify(assemblyPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            return (
                compileExitCode,
                process.ExitCode,
                stdout.ReplaceLineEndings(Environment.NewLine),
                stderr.ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
