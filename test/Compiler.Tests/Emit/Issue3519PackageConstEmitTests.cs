// <copyright file="Issue3519PackageConstEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #3519: package constants remain constants across source files and emitted bodies.</summary>
public sealed class Issue3519PackageConstEmitTests
{
    [Fact]
    public void PackageConst_FromAnotherSourceFile_EmitsLiteralAndProcessExitsZero()
    {
        using var program = Compile(
            ("Main.gs", """
                package FindingPackageConstZero

                import System

                func Check() int32 { return Expected == 42 ? 0 : 1 }

                Environment.Exit(Check())
                """),
            ("Value.gs", """
                package FindingPackageConstZero

                const Expected int32 = 42
                """));

        var run = Run(program.OutputPath);
        Assert.True(
            run.ExitCode == 0,
            $"program exited {run.ExitCode}\nstdout:\n{run.StandardOutput}\nstderr:\n{run.StandardError}");

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var expected = container.GetField("Expected", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(expected);
        Assert.True(expected!.IsLiteral);
        Assert.Equal(42, expected.GetRawConstantValue());

        var check = container.GetMethod("Check", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(check);
        var instructions = IlInstructionReader.Read(check!.GetMethodBody()!.GetILAsByteArray()!);
        Assert.DoesNotContain(instructions, instruction => instruction.OpCode == OpCodes.Ldsfld);
    }

    [Fact]
    public void PackageConstExpressions_FromAnotherSourceFile_InlineAcrossFunctionAndLambdaBodies()
    {
        using var program = Compile(
            ("Reader.gs", """
                package FindingPackageConstExpressions

                func CheckExpressions() int32 {
                    let read = func() string { return Greeting }
                    return Widened == int64(42)
                        && Negative == -1
                        && Sum == 42
                        && Prior == 43
                        && Tiny == int8(7)
                        && Unsigned == uint64(9)
                        && Fraction == float32(1.5)
                        && Enabled
                        && Letter == 'Q'
                        && read() == "ready"
                        && Missing == nil
                        && Sum.ToString() == "42"
                        ? 0 : 1
                }
                """),
            ("Values.gs", """
                package FindingPackageConstExpressions

                const Widened int64 = 42
                const Negative = -1
                const Sum = 40 + 2
                const Prior = Sum + 1
                const Tiny int8 = 7
                const Unsigned uint64 = 9
                const Fraction float32 = 1.5f
                const Enabled bool = true
                const Letter char = 'Q'
                const Greeting string = "ready"
                const Missing string? = nil
                """));

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var check = container.GetMethod("CheckExpressions", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(check);
        Assert.Equal(0, check!.Invoke(null, null));

        var instructions = IlInstructionReader.Read(check.GetMethodBody()!.GetILAsByteArray()!);
        Assert.DoesNotContain(instructions, instruction => instruction.OpCode == OpCodes.Ldsfld);

        Assert.Equal(42L, GetLiteral(container, "Widened").GetRawConstantValue());
        Assert.Equal(-1, GetLiteral(container, "Negative").GetRawConstantValue());
        Assert.Equal(42, GetLiteral(container, "Sum").GetRawConstantValue());
        Assert.Equal(43, GetLiteral(container, "Prior").GetRawConstantValue());
        Assert.Equal((sbyte)7, GetLiteral(container, "Tiny").GetRawConstantValue());
        Assert.Equal(9UL, GetLiteral(container, "Unsigned").GetRawConstantValue());
        Assert.Equal(1.5F, GetLiteral(container, "Fraction").GetRawConstantValue());
        Assert.Equal(true, GetLiteral(container, "Enabled").GetRawConstantValue());
        Assert.Equal('Q', GetLiteral(container, "Letter").GetRawConstantValue());
        Assert.Equal("ready", GetLiteral(container, "Greeting").GetRawConstantValue());
        Assert.Null(GetLiteral(container, "Missing").GetRawConstantValue());
    }

    [Fact]
    public void DecimalPackageConst_FromAnotherSourceFile_UsesInitializedReadOnlyStorage()
    {
        using var program = Compile(
            ("Reader.gs", """
                package FindingPackageDecimalConst

                func CheckDecimal() int32 { return Amount == -405.5m ? 0 : 1 }
                """),
            ("Values.gs", """
                package FindingPackageDecimalConst

                const Amount decimal = -405.5m
                """));

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        Assert.NotNull(container.TypeInitializer);
        var check = container.GetMethod("CheckDecimal", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(check);
        Assert.Equal(0, check!.Invoke(null, null));

        var amount = container.GetField("Amount", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(amount);
        Assert.True(amount!.IsInitOnly);
        Assert.False(amount.IsLiteral);
        Assert.False(amount.Attributes.HasFlag(FieldAttributes.HasDefault));
        Assert.Equal(-405.5M, amount.GetCustomAttribute<DecimalConstantAttribute>()!.Value);
        Assert.Equal(-405.5M, amount.GetValue(null));
        Assert.DoesNotContain(
            IlInstructionReader.Read(check.GetMethodBody()!.GetILAsByteArray()!),
            instruction => instruction.OpCode == OpCodes.Ldsfld);
    }

    [Fact]
    public void DecimalTypeConstants_UseInitializedReadOnlyStorage()
    {
        using var program = Compile(
            ("Main.gs", """
                package FindingDecimalTypeConstants

                class Constants {
                    shared {
                        const ClassAmount decimal = 12.5m
                    }
                }

                interface IConstants {
                    shared {
                        const InterfaceAmount decimal = 2.5m
                    }
                }

                func CheckTypeConstants() int32 {
                    return Constants.ClassAmount == 12.5m
                        && IConstants.InterfaceAmount == 2.5m
                        ? 0 : 1
                }
                """));

        var assembly = program.Load();
        var programType = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var check = programType.GetMethod("CheckTypeConstants", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(check);
        Assert.Equal(0, check!.Invoke(null, null));
        Assert.DoesNotContain(
            IlInstructionReader.Read(check.GetMethodBody()!.GetILAsByteArray()!),
            instruction => instruction.OpCode == OpCodes.Ldsfld);

        AssertDecimalReadOnlyField(assembly.GetType("FindingDecimalTypeConstants.Constants")!, "ClassAmount", 12.5M);
        AssertDecimalReadOnlyField(assembly.GetType("FindingDecimalTypeConstants.IConstants")!, "InterfaceAmount", 2.5M);
    }

    [Theory]
    [InlineData("nint")]
    [InlineData("nuint")]
    public void NativeWidthPackageConst_ReportsTargetedDiagnostic(string type)
    {
        var tree = SyntaxTree.Parse(
            SourceText.From(
                $$"""
                package FindingPackageNativeConst

                const Platform {{type}} = 42
                """,
                "Values.gs"));
        using var peStream = new MemoryStream();
        var result = new Compilation(tree).Emit(peStream);

        Assert.False(result.Success);
        Assert.Equal("GS0538", Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.IsError)).Id);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Fact]
    public void NativeWidthTypeConstants_ReportTargetedDiagnostics()
    {
        var tree = SyntaxTree.Parse(
            SourceText.From(
                """
                package FindingNativeTypeConstants

                class Constants {
                    const Direct nint = 1
                    shared {
                        const Shared nuint = 2
                    }
                }

                interface IConstants {
                    shared {
                        const InterfaceValue nint = 3
                    }
                }
                """,
                "Values.gs"));
        using var peStream = new MemoryStream();
        var result = new Compilation(tree).Emit(peStream);

        Assert.False(result.Success);
        var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
        Assert.Equal(3, errors.Length);
        Assert.All(errors, diagnostic => Assert.Equal("GS0538", diagnostic.Id));
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    private static FieldInfo GetLiteral(Type container, string name)
    {
        var field = container.GetField(name, BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(field);
        Assert.True(field!.IsLiteral);
        return field;
    }

    private static void AssertDecimalReadOnlyField(Type container, string name, decimal expected)
    {
        var field = container.GetField(name, BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(field);
        Assert.NotNull(container.TypeInitializer);
        Assert.True(field!.IsInitOnly);
        Assert.False(field.IsLiteral);
        Assert.Equal(expected, field.GetCustomAttribute<DecimalConstantAttribute>()!.Value);
        Assert.Equal(expected, field.GetValue(null));
    }

    private static CompiledProgram Compile(params (string FileName, string Source)[] sources)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3519-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var sourcePaths = new List<string>(sources.Length);
            foreach (var source in sources)
            {
                var path = Path.Combine(directory, source.FileName);
                File.WriteAllText(path, source.Source);
                sourcePaths.Add(path);
            }

            var outputPath = Path.Combine(directory, "Issue3519.dll");
            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            arguments.AddRange(sourcePaths);

            var exitCode = Program.Main(arguments.ToArray());
            Assert.Equal(0, exitCode);
            Assert.True(File.Exists(outputPath));
            IlVerifier.Verify(outputPath);
            return new CompiledProgram(directory, outputPath);
        }
        catch
        {
            Directory.Delete(directory, recursive: true);
            throw;
        }
    }

    private static ProcessResult Run(string outputPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(outputPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)!;
        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        return new ProcessResult(process.ExitCode, standardOutput, standardError);
    }

    private sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);

    private sealed class CompiledProgram : IDisposable
    {
        public CompiledProgram(string directory, string outputPath)
        {
            Directory = directory;
            OutputPath = outputPath;
        }

        public string Directory { get; }

        public string OutputPath { get; }

        public Assembly Load() => Assembly.Load(File.ReadAllBytes(OutputPath));

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
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
