// <copyright file="Issue3114ReadOnlySpanDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Driver coverage for issue #3114 read-only span samples; every driver path uses emitted execution.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3114ReadOnlySpanDriverTests
{
    public enum Driver
    {
        CompilerEmitToMemory,
        CompilerEmitToFile,
        ReplEmitToMemory,
    }

    public static IEnumerable<object[]> SampleDriverCases()
    {
        foreach (var (sample, expected) in new[]
        {
            ("SpanComprehensive.gs", "60\n10\n2\n"),
            ("RefStructGenericField.gs", "3\n"),
            ("SpanIndexing.gs", "60\n402\n"),
        })
        {
            foreach (var driver in Enum.GetValues<Driver>())
            {
                yield return new object[] { sample, expected, driver };
            }
        }
    }

    public static IEnumerable<object[]> Drivers()
    {
        foreach (var driver in Enum.GetValues<Driver>())
        {
            yield return new object[] { driver };
        }
    }

    [Theory]
    [MemberData(nameof(SampleDriverCases))]
    public void ShippedSpanSample_MatchesGoldenAcrossDrivers(string sample, string expected, Driver driver)
    {
        var sourcePath = Path.Combine(LocateSamplesDirectory(), sample);
        var root = Path.Combine(Environment.CurrentDirectory, $".issue3114-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileAndRun(root, sample, sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            expected = expected.Replace("\n", Environment.NewLine, StringComparison.Ordinal);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory ? expected + $"Success.{Environment.NewLine}" : expected,
                result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void SpanConversionMutationAndSlicing_AgreeAcrossDrivers(Driver driver)
    {
        const string Source = """
            import System

            func Main() {
                var values = []int32{11, 22, 33}
                var writable Span[int32] = values
                var readOnly ReadOnlySpan[int32] = writable
                writable[1] = 44
                var tail = readOnly.Slice(1)
                var window = tail.Slice(0, 2)
                var letters = []char{'a', 'b', 'c', 'd', 'e'}
                var writableChars Span[char] = letters
                var readOnlyChars ReadOnlySpan[char] = writableChars
                var charWindow = readOnlyChars.Slice(1, 3)
                Console.WriteLine(readOnly.Length)
                Console.WriteLine(readOnly[1])
                Console.WriteLine(window[1])
                Console.WriteLine(writable.ToString())
                Console.WriteLine(readOnly.ToString())
                Console.WriteLine(window.ToString())
                Console.WriteLine(writableChars.ToString())
                Console.WriteLine(readOnlyChars.ToString())
                Console.WriteLine(charWindow.ToString())
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3114-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "span-operations.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var emitted = CompileAndRun(root, "span-operations.gs", sourcePath);
            Assert.Equal(
                $"3{Environment.NewLine}44{Environment.NewLine}33{Environment.NewLine}System.Span<Int32>[3]{Environment.NewLine}System.ReadOnlySpan<Int32>[3]{Environment.NewLine}System.ReadOnlySpan<Int32>[2]{Environment.NewLine}abcde{Environment.NewLine}abcde{Environment.NewLine}bcd{Environment.NewLine}",
                emitted.StandardOutput);

            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => emitted,
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory
                    ? emitted.StandardOutput + $"Success.{Environment.NewLine}"
                    : emitted.StandardOutput,
                result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>
    /// #3183: emitted interpolation routes ByRefLike holes through their CLR
    /// <c>ToString()</c> method instead of closing generic
    /// <c>AppendFormatted&lt;T&gt;</c> over an unsupported type argument.
    /// </summary>
    /// <param name="driver">The driver under test.</param>
    [Theory]
    [MemberData(nameof(Drivers))]
    public void SpanInterpolation_RendersAcrossFileDrivers(Driver driver)
    {
        const string Source = """
            import System

            func Main() {
                var values = []int32{11, 22, 33}
                var writable Span[int32] = values
                var readOnly ReadOnlySpan[int32] = writable
                var letters = []char{'h', 'e', 'l', 'l', 'o'}
                var writableChars Span[char] = letters
                var readOnlyChars ReadOnlySpan[char] = writableChars
                Console.WriteLine("writable=${writable}")
                Console.WriteLine("readonly=${readOnly}")
                Console.WriteLine("writableChars=${writableChars}")
                Console.WriteLine("chars=${readOnlyChars}")
                Console.WriteLine("aligned=${readOnlyChars,8}")
                Console.WriteLine("format=${readOnlyChars:X}")
                Console.WriteLine("alignedFormat=${readOnlyChars,8:X}")
                Console.WriteLine("left=${readOnlyChars,-8}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3114-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "span-interpolation.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileAndRun(root, "span-interpolation.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory
                    ? $"writable=System.Span<Int32>[3]{Environment.NewLine}readonly=System.ReadOnlySpan<Int32>[3]{Environment.NewLine}writableChars=hello{Environment.NewLine}chars=hello{Environment.NewLine}aligned=   hello{Environment.NewLine}format=hello{Environment.NewLine}alignedFormat=   hello{Environment.NewLine}left=hello   {Environment.NewLine}Success.{Environment.NewLine}"
                    : $"writable=System.Span<Int32>[3]{Environment.NewLine}readonly=System.ReadOnlySpan<Int32>[3]{Environment.NewLine}writableChars=hello{Environment.NewLine}chars=hello{Environment.NewLine}aligned=   hello{Environment.NewLine}format=hello{Environment.NewLine}alignedFormat=   hello{Environment.NewLine}left=hello   {Environment.NewLine}",
                result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void OrdinaryInterpolation_RemainsUnchangedAcrossFileDrivers(Driver driver)
    {
        const string Source = """
            import System

            func Main() {
                var value = 42
                Console.WriteLine("value=${value}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3183-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "ordinary-interpolation.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileAndRun(root, "ordinary-interpolation.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            Assert.Equal(
                driver == Driver.CompilerEmitToMemory
                    ? $"value=42{Environment.NewLine}Success.{Environment.NewLine}"
                    : $"value=42{Environment.NewLine}",
                result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void UserRefStructInterpolation_UsesDeclaredToStringAcrossFileDrivers(Driver driver)
    {
        const string Source = """
            import System

            ref struct ReceiverToken {
                var value int32
            }

            func (token ReceiverToken) ToString() string -> String.Format("Receiver#{0}", token.value)

            ref struct InBodyToken {
                var value int32
                func ToString() string -> String.Format("InBody#{0}", value)
            }

            func Main() {
                var receiver ReceiverToken = ReceiverToken{value: 42}
                var inBody InBodyToken = InBodyToken{value: 43}
                Console.WriteLine("receiver=${receiver}")
                Console.WriteLine("inbody=${inBody}")
            }
            """;
        string Expected = $"receiver=Receiver#42{Environment.NewLine}inbody=InBody#43{Environment.NewLine}";
        var root = Path.Combine(Environment.CurrentDirectory, $".issue3220-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "user-ref-struct-tostring.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileAndRun(root, "user-ref-struct-tostring.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(0, result.ExitCode);
            if (driver == Driver.CompilerEmitToMemory)
            {
                Assert.StartsWith(Expected, result.StandardOutput, StringComparison.Ordinal);
                Assert.Contains("warning GS0314:", result.StandardOutput, StringComparison.Ordinal);
                Assert.EndsWith($"Success.{Environment.NewLine}", result.StandardOutput, StringComparison.Ordinal);
                Assert.Equal(string.Empty, result.StandardError);
            }
            else
            {
                Assert.Equal(Expected, result.StandardOutput);
                if (driver == Driver.ReplEmitToMemory)
                {
                    Assert.Contains("warning GS0314:", result.StandardError, StringComparison.Ordinal);
                }
                else
                {
                    Assert.Equal(string.Empty, result.StandardError);
                }
            }
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ImportedRefStructInterpolation_WithOverloadedToString_CompilesAndRuns()
    {
        const string Source = """
            import System
            import Issue3220External

            func Main() {
                let token ExtTok = ExtTok()
                Console.WriteLine("interp=${token}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3220-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var referencePath = Path.Combine(root, "Issue3220.External.dll");
        var sourcePath = Path.Combine(root, "imported-overloaded-tostring.gs");
        EmitOverloadedToStringRefStructAssembly(referencePath);
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = CompileAndRun(root, "imported-overloaded-tostring.gs", sourcePath, referencePath);
            Assert.Equal(0, result.ExitCode);
            Assert.Equal($"interp=ExtTok!{Environment.NewLine}", result.StandardOutput);
            Assert.Equal(string.Empty, result.StandardError);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void UserRefStructInterpolation_WithoutDeclaredToStringReportsGS0519AcrossFileDrivers(Driver driver)
    {
        const string Source = """
            ref struct Token {
                var value int32
            }

            func Main() {
                var token Token = Token{value: 42}
                Console.WriteLine("token=${token}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3183-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "user-ref-struct-interpolation.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileOnly(root, "user-ref-struct-interpolation.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(1, result.ExitCode);
            var diagnosticStream = driver == Driver.ReplEmitToMemory
                ? result.StandardError
                : result.StandardOutput;
            Assert.Equal(
                driver == Driver.ReplEmitToMemory ? string.Empty : $"Failed.{Environment.NewLine}",
                driver == Driver.ReplEmitToMemory ? result.StandardOutput : result.StandardError);

            var diagnostic = Assert.Single(
                diagnosticStream.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries),
                line => line.Contains("error GS0519:", StringComparison.Ordinal));
            AssertByRefLikeInterpolationDiagnostic(diagnostic, sourcePath, 7, "Token");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(Drivers))]
    public void UserRefStructInterpolation_WithoutParameterlessToStringReportsGS0519AcrossFileDrivers(Driver driver)
    {
        const string Source = """
            import System

            ref struct Token {
                func ToString(value int32) string -> String.Format("Token#{0}", value)
            }

            func Main() {
                let token Token = Token{}
                Console.WriteLine("interp=${token}")
            }
            """;

        var root = Path.Combine(Environment.CurrentDirectory, $".issue3220-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var sourcePath = Path.Combine(root, "user-ref-struct-arity-interpolation.gs");
        File.WriteAllText(sourcePath, Source);

        try
        {
            var result = driver switch
            {
                Driver.CompilerEmitToMemory => CaptureConsole(
                    () => GSharp.Compiler.Program.Main([sourcePath])),
                Driver.CompilerEmitToFile => CompileOnly(root, "user-ref-struct-arity-interpolation.gs", sourcePath),
                Driver.ReplEmitToMemory => CaptureConsole(
                    () => GSharp.Repl.Program.Main([sourcePath])),
                _ => throw new InvalidOperationException($"Unexpected driver {driver}."),
            };

            Assert.Equal(1, result.ExitCode);
            var diagnosticStream = driver == Driver.ReplEmitToMemory
                ? result.StandardError
                : result.StandardOutput;
            Assert.Equal(
                driver == Driver.ReplEmitToMemory ? string.Empty : $"Failed.{Environment.NewLine}",
                driver == Driver.ReplEmitToMemory ? result.StandardOutput : result.StandardError);

            var boundDiagnostic = Assert.Single(
                GSharp.Tests.EmittedOracle.Evaluate(Source).Diagnostics,
                item => item.Id == "GS0519");
            var location = boundDiagnostic.Location;
            Assert.Equal(
                (Span: "(9,33,9,38)", Text: "token"),
                (
                    Span: $"({location.StartLine + 1},{location.StartCharacter + 1},{location.EndLine + 1},{location.EndCharacter + 1})",
                    Text: location.Text.ToString(location.Span)));

            var diagnostic = Assert.Single(
                diagnosticStream.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries),
                line => line.Contains("error GS0519:", StringComparison.Ordinal));
            Assert.StartsWith($"{sourcePath}(9,33,9,38): error GS0519:", diagnostic, StringComparison.Ordinal);
            AssertByRefLikeInterpolationDiagnostic(diagnostic, sourcePath, 9, "Token");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void AssertByRefLikeInterpolationDiagnostic(
        string line,
        string sourcePath,
        int startLine,
        string typeName)
    {
        Assert.StartsWith($"{sourcePath}({startLine},", line, StringComparison.Ordinal);
        Assert.Contains(": error GS0519:", line, StringComparison.Ordinal);
        Assert.Contains(typeName, line, StringComparison.Ordinal);
        Assert.Contains("has no usable parameterless ToString method", line, StringComparison.Ordinal);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CompileOnly(
        string root,
        string sample,
        string sourcePath)
    {
        var outputDirectory = Path.Combine(root, "emit");
        Directory.CreateDirectory(outputDirectory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory));
        var assemblyPath = Path.Combine(outputDirectory, Path.GetFileNameWithoutExtension(sample) + ".dll");
        return CaptureConsole(
            () => GSharp.Compiler.Program.Main(
                ["/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath]));
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CompileAndRun(
        string root,
        string sample,
        string sourcePath,
        string referencePath = null)
    {
        var outputDirectory = Path.Combine(root, "emit");
        Directory.CreateDirectory(outputDirectory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory));
        var assemblyPath = Path.Combine(outputDirectory, Path.GetFileNameWithoutExtension(sample) + ".dll");
        var arguments = new List<string>
        {
            "/out:" + assemblyPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        if (referencePath != null)
        {
            arguments.Add("/r:" + referencePath);
        }

        arguments.Add(sourcePath);
        var compile = CaptureConsole(
            () => GSharp.Compiler.Program.Main(arguments.ToArray()));

        Assert.Equal(0, compile.ExitCode);
        Assert.True(File.Exists(assemblyPath), compile.StandardOutput + compile.StandardError);
        CollectibleAssembly.Inspect(assemblyPath, assembly => Assert.NotEmpty(assembly.GetTypes()));
        if (referencePath != null)
        {
            File.Copy(referencePath, Path.Combine(outputDirectory, Path.GetFileName(referencePath)));
        }

        var result = DotnetProcess.Run(outputDirectory, assemblyPath);

        return (
            result.ExitCode,
            result.StandardOutput.ReplaceLineEndings(Environment.NewLine),
            result.StandardError.ReplaceLineEndings(Environment.NewLine));
    }

    private static void EmitOverloadedToStringRefStructAssembly(string outputPath)
    {
        var builder = new PersistedAssemblyBuilder(new AssemblyName("Issue3220.External"), typeof(object).Assembly);
        var module = builder.DefineDynamicModule("Issue3220.External");
        var type = module.DefineType(
            "Issue3220External.ExtTok",
            TypeAttributes.Public | TypeAttributes.Sealed | TypeAttributes.SequentialLayout,
            typeof(ValueType));
        type.SetCustomAttribute(
            new CustomAttributeBuilder(
                typeof(System.Runtime.CompilerServices.IsByRefLikeAttribute).GetConstructor(Type.EmptyTypes)!,
                []));

        var parameterless = type.DefineMethod(
            nameof(ToString),
            MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig,
            typeof(string),
            Type.EmptyTypes);
        var il = parameterless.GetILGenerator();
        il.Emit(OpCodes.Ldstr, "ExtTok!");
        il.Emit(OpCodes.Ret);
        type.DefineMethodOverride(parameterless, typeof(object).GetMethod(nameof(ToString), Type.EmptyTypes)!);

        var overload = type.DefineMethod(
            nameof(ToString),
            MethodAttributes.Public | MethodAttributes.HideBySig,
            typeof(string),
            [typeof(string)]);
        il = overload.GetILGenerator();
        il.Emit(OpCodes.Ldstr, "unused");
        il.Emit(OpCodes.Ret);

        type.CreateType();
        builder.Save(outputPath);
    }

    private static (int ExitCode, string StandardOutput, string StandardError) CaptureConsole(
        Func<int> action)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();
        var previousOutput = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            return (
                action(),
                output.ToString().ReplaceLineEndings(Environment.NewLine),
                error.ToString().ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
        }
    }

    private static string LocateSamplesDirectory()
    {
        var directory = new DirectoryInfo(Environment.CurrentDirectory);
        while (directory != null)
        {
            var samples = Path.Combine(directory.FullName, "samples");
            if (Directory.Exists(samples) && File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return samples;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate the samples directory.");
    }
}
