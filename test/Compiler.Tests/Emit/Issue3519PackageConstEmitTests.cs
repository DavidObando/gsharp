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
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using CSharpCompilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation;
using CSharpCompilationOptions = Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions;
using CSharpSyntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using MetadataReference = Microsoft.CodeAnalysis.MetadataReference;
using OutputKind = Microsoft.CodeAnalysis.OutputKind;

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
    public void PackageConstOperators_FromAnotherSourceFile_FoldWithBoundTypes()
    {
        using var program = Compile(
            ("Reader.gs", """
                package FindingPackageConstOperators

                func CheckOperators() int32 {
                    return NotFalse
                        && U64Sum == 9ul
                        && Compared
                        && Equal
                        && Logical
                        && Cleared == 9u
                        && Complement == 0xFFFFFFF0u
                        && BitMix == 10u
                        && Coalesced == "fallback"
                        && Asserted == "ok"
                        ? 0 : 1
                }
                """),
            ("Values.gs", """
                package FindingPackageConstOperators

                const NotFalse = !false
                const U64Sum = 5ul + 4ul
                const Compared = 3 < 4 && 4 >= 4
                const Equal = 7 == 7 && 8 != 9
                const Logical = false || true
                const Cleared = 15u &^ 6u
                const Complement = ^15u
                const BitMix = (12u & 10u) | (1u ^ 3u)
                const Coalesced = nil ?? "fallback"
                const Asserted = "ok"!!
                """));

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var check = container.GetMethod("CheckOperators", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(check);
        Assert.Equal(0, check!.Invoke(null, null));
        Assert.DoesNotContain(
            IlInstructionReader.Read(check.GetMethodBody()!.GetILAsByteArray()!),
            instruction => instruction.OpCode == OpCodes.Ldsfld);

        Assert.Equal(true, GetLiteral(container, "NotFalse").GetRawConstantValue());
        Assert.Equal(9UL, GetLiteral(container, "U64Sum").GetRawConstantValue());
        Assert.Equal(true, GetLiteral(container, "Compared").GetRawConstantValue());
        Assert.Equal(true, GetLiteral(container, "Equal").GetRawConstantValue());
        Assert.Equal(true, GetLiteral(container, "Logical").GetRawConstantValue());
        Assert.Equal(9U, GetLiteral(container, "Cleared").GetRawConstantValue());
        Assert.Equal(0xFFFFFFF0U, GetLiteral(container, "Complement").GetRawConstantValue());
        Assert.Equal(10U, GetLiteral(container, "BitMix").GetRawConstantValue());
        Assert.Equal("fallback", GetLiteral(container, "Coalesced").GetRawConstantValue());
        Assert.Equal("ok", GetLiteral(container, "Asserted").GetRawConstantValue());
    }

    [Fact]
    public void PackageConstConversions_FromAnotherSourceFile_PreserveClrSemantics()
    {
        using var program = Compile(
            ("Reader.gs", """
                package FindingPackageConstConversions

                func CheckConversions() int32 {
                    return Truncated == 3
                        && Rounded == 16777216.0
                        && Narrowed == 1
                        && WrappedThenWidened == -2147483648L
                        && UncheckedNegatedMin == int32.MinValue
                        && ZeroExtended == 4294967295L
                        && UnsignedWrap == uint64.MaxValue
                        && CheckedFloat == 4.0f
                        ? 0 : 1
                }
                """),
            ("Values.gs", """
                package FindingPackageConstConversions

                const Truncated int32 = int32(3.9)
                const Rounded float64 = float64(float32(16777217) + 1.0f)
                const Narrowed int8 = int8(257)
                const WrappedThenWidened int64 = int32.MaxValue + 1
                const UncheckedNegatedMin = -int32.MinValue
                const ZeroExtended int64 = int64(uint32.MaxValue)
                const UnsignedWrap uint64 = uint64(-1)
                const CheckedFloat = checked(1.5f + 2.5f)
                """));

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var check = container.GetMethod("CheckConversions", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(check);
        Assert.Equal(0, check!.Invoke(null, null));
        Assert.DoesNotContain(
            IlInstructionReader.Read(check.GetMethodBody()!.GetILAsByteArray()!),
            instruction => instruction.OpCode == OpCodes.Ldsfld);

        Assert.Equal(3, GetLiteral(container, "Truncated").GetRawConstantValue());
        Assert.Equal(16777216.0, GetLiteral(container, "Rounded").GetRawConstantValue());
        Assert.Equal((sbyte)1, GetLiteral(container, "Narrowed").GetRawConstantValue());
        Assert.Equal(-2147483648L, GetLiteral(container, "WrappedThenWidened").GetRawConstantValue());
        Assert.Equal(int.MinValue, GetLiteral(container, "UncheckedNegatedMin").GetRawConstantValue());
        Assert.Equal(4294967295L, GetLiteral(container, "ZeroExtended").GetRawConstantValue());
        Assert.Equal(ulong.MaxValue, GetLiteral(container, "UnsignedWrap").GetRawConstantValue());
        Assert.Equal(4.0F, GetLiteral(container, "CheckedFloat").GetRawConstantValue());
    }

    [Fact]
    public void ImportedEnumPackageConst_FromAnotherSourceFile_UsesUnderlyingMetadataPayload()
    {
        using var program = Compile(
            ("Reader.gs", """
                package FindingImportedEnumPackageConst

                func CheckImportedEnum() int32 {
                    return D == System.DayOfWeek.Monday ? 0 : 1
                }
                """),
            ("Values.gs", """
                package FindingImportedEnumPackageConst

                const D System.DayOfWeek = System.DayOfWeek.Monday
                """));

        var assembly = program.Load();
        var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var check = container.GetMethod("CheckImportedEnum", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(check);
        Assert.Equal(0, check!.Invoke(null, null));
        Assert.DoesNotContain(
            IlInstructionReader.Read(check.GetMethodBody()!.GetILAsByteArray()!),
            instruction => instruction.OpCode == OpCodes.Ldsfld);

        var field = GetLiteral(container, "D");
        Assert.Equal(typeof(DayOfWeek), field.FieldType);
        var raw = field.GetRawConstantValue();
        Assert.IsType<int>(raw);
        Assert.Equal((int)DayOfWeek.Monday, raw);
    }

    [Fact]
    public void ExplicitReferenceEnumPackageConsts_UseExactUnderlyingMetadataPayloads()
    {
        var fixturePath = CompileExplicitEnumFixture();
        try
        {
            var fixture = AssemblyLoadContext.Default.LoadFromAssemblyPath(fixturePath);
            using var program = CompileWithReferences(
                new[] { fixturePath },
                ("Reader.gs", """
                    package FindingExplicitReferenceEnumPackageConsts

                    import Issue3519.ExplicitEnums

                    func CheckExplicitEnums() int32 {
                        return U == ByteCode.Combined && S == SByteCode.Adjusted ? 0 : 1
                    }
                    """),
                ("Values.gs", """
                    package FindingExplicitReferenceEnumPackageConsts

                    import Issue3519.ExplicitEnums

                    const U ByteCode = ByteCode.High | ByteCode.Low
                    const S SByteCode = SByteCode.Negative + int8(2)
                    """));

            var assembly = program.Load();
            var container = assembly.GetTypes().Single(type => type.Name == "<Program>");
            var check = container.GetMethod("CheckExplicitEnums", BindingFlags.Public | BindingFlags.Static);
            Assert.NotNull(check);
            Assert.Equal(0, check!.Invoke(null, null));
            Assert.DoesNotContain(
                IlInstructionReader.Read(check.GetMethodBody()!.GetILAsByteArray()!),
                instruction => instruction.OpCode == OpCodes.Ldsfld);

            var byteEnum = fixture.GetType("Issue3519.ExplicitEnums.ByteCode")!;
            var sbyteEnum = fixture.GetType("Issue3519.ExplicitEnums.SByteCode")!;
            var unsigned = GetLiteral(container, "U");
            var signed = GetLiteral(container, "S");
            Assert.Equal(byteEnum, unsigned.FieldType);
            Assert.Equal(sbyteEnum, signed.FieldType);
            Assert.Equal((byte)201, Assert.IsType<byte>(unsigned.GetRawConstantValue()));
            Assert.Equal((sbyte)-5, Assert.IsType<sbyte>(signed.GetRawConstantValue()));
        }
        finally
        {
            File.Delete(fixturePath);
        }
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
        var result = EmitForDiagnostics($$"""
            package FindingPackageNativeConst

            const Platform {{type}} = 42
            """);

        Assert.False(result.Success);
        Assert.Equal("GS0538", Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.IsError)).Id);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Fact]
    public void NestedNativeWidthConversionInPackageConst_ReportsGs0538()
    {
        var result = EmitForDiagnostics("""
            package FindingNestedNativeConst

            const PlatformValue int64 = nint(4294967297L)
            """);

        Assert.False(result.Success);
        Assert.Equal("GS0538", Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.IsError)).Id);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Theory]
    [InlineData("const Bad = checked(int32.MaxValue + 1)")]
    [InlineData("const Bad = checked(-int32.MinValue)")]
    [InlineData("const Bad = checked(int8(257))")]
    [InlineData("const Bad = 1 / 0")]
    [InlineData("const Bad = 1m / 0m")]
    [InlineData("const Bad = int64.MinValue / -1L")]
    [InlineData("const Bad = 79228162514264337593543950335m + 1m")]
    [InlineData("const Bad = System.DateTime.Now.Ticks")]
    public void InvalidPackageConstExpression_ReportsGs0376WithoutCompilerException(string declaration)
    {
        var result = EmitForDiagnostics($$"""
            package FindingInvalidPackageConst

            {{declaration}}
            """);

        Assert.False(result.Success);
        Assert.Equal("GS0376", Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.IsError)).Id);
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
                    const Nested int64 = nint(4)
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
        Assert.Equal(4, errors.Length);
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

    private static EmitResult EmitForDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, "Values.gs"));
        using var peStream = new MemoryStream();
        return new GsCompilation(tree).Emit(peStream);
    }

    private static CompiledProgram Compile(params (string FileName, string Source)[] sources)
        => CompileWithReferences(Array.Empty<string>(), sources);

    private static CompiledProgram CompileWithReferences(
        IReadOnlyList<string> references,
        params (string FileName, string Source)[] sources)
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
            foreach (var reference in references)
            {
                arguments.Add("/r:" + reference);
            }

            arguments.AddRange(sourcePaths);

            var exitCode = Program.Main(arguments.ToArray());
            Assert.Equal(0, exitCode);
            Assert.True(File.Exists(outputPath));
            IlVerifier.Verify(outputPath, additionalReferences: references);
            return new CompiledProgram(directory, outputPath);
        }
        catch
        {
            Directory.Delete(directory, recursive: true);
            throw;
        }
    }

    private static string CompileExplicitEnumFixture()
    {
        var outputPath = Path.Combine(
            AppContext.BaseDirectory,
            "Issue3519.ExplicitEnums." + Guid.NewGuid().ToString("N") + ".dll");
        var trustedPlatformAssemblies = Assert.IsType<string>(
            AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"));
        var references = trustedPlatformAssemblies
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue3519.ExplicitEnums",
            new[]
            {
                CSharpSyntaxTree.ParseText(
                    """
                    namespace Issue3519.ExplicitEnums;

                    public enum ByteCode : byte
                    {
                        Low = 1,
                        High = 200,
                        Combined = 201,
                    }

                    public enum SByteCode : sbyte
                    {
                        Negative = -7,
                        Adjusted = -5,
                    }
                    """),
            },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var output = File.Create(outputPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
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
