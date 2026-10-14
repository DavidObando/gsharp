// <copyright file="Issue3519PackageConstEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import CSharpCompilation = Microsoft.CodeAnalysis.CSharp.CSharpCompilation
import CSharpCompilationOptions = Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions
import CSharpSyntaxTree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import MetadataReference = Microsoft.CodeAnalysis.MetadataReference
import OutputKind = Microsoft.CodeAnalysis.OutputKind
import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis

/// Issue #3519: package constants remain constants across source files and emitted bodies.
class Issue3519PackageConstEmitTests {
    @Fact
    func PackageConst_FromAnotherSourceFile_EmitsLiteralAndProcessExitsZero() {
        using let program = Compile(("Main.gs", `package FindingPackageConstZero

import System

func Check() int32 { return Expected == 42 ? 0 : 1 }

Environment.Exit(Check())`), ("Value.gs", `package FindingPackageConstZero

const Expected int32 = 42`))
        let run = Run(program.OutputPath)
        Assert.True(run.ExitCode == 0, (`program exited ` + "${run.ExitCode}" + `
stdout:
` + "${run.StandardOutput}" + `
stderr:
` + "${run.StandardError}"))
        let assembly = program.Load()
        let container = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let expected FieldInfo? = container.GetField("Expected", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(expected)
        Assert.True(expected!!.IsLiteral)
        Assert.Equal(42, expected!!.GetRawConstantValue())
        let check MethodInfo? = container.GetMethod(
            "Check",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(check)
        let instructions = IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!)
        Assert.DoesNotContain(instructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld)
    }

    @Fact
    func PackageConstExpressions_FromAnotherSourceFile_InlineAcrossFunctionAndLambdaBodies() {
        using let program = Compile(("Reader.gs", `package FindingPackageConstExpressions

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
}`), ("Values.gs", `package FindingPackageConstExpressions

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
const Missing string? = nil`))
        let assembly = program.Load()
        let container = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let check MethodInfo? = container.GetMethod(
            "CheckExpressions",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(check)
        Assert.Equal(0, check!!.Invoke(nil, nil))
        let instructions = IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!)
        Assert.DoesNotContain(instructions, (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld)
        Assert.Equal(42L, GetLiteral(container, "Widened")!!.GetRawConstantValue())
        Assert.Equal(-1, GetLiteral(container, "Negative")!!.GetRawConstantValue())
        Assert.Equal(42, GetLiteral(container, "Sum")!!.GetRawConstantValue())
        Assert.Equal(43, GetLiteral(container, "Prior")!!.GetRawConstantValue())
        Assert.Equal(int8(7), GetLiteral(container, "Tiny")!!.GetRawConstantValue())
        Assert.Equal(9UL, GetLiteral(container, "Unsigned")!!.GetRawConstantValue())
        Assert.Equal(1.5F, GetLiteral(container, "Fraction")!!.GetRawConstantValue())
        Assert.Equal(true, GetLiteral(container, "Enabled")!!.GetRawConstantValue())
        Assert.Equal('Q', GetLiteral(container, "Letter")!!.GetRawConstantValue())
        Assert.Equal("ready", GetLiteral(container, "Greeting")!!.GetRawConstantValue())
        Assert.Null(GetLiteral(container, "Missing")!!.GetRawConstantValue())
    }

    @Fact
    func PackageConstOperators_FromAnotherSourceFile_FoldWithBoundTypes() {
        using let program = Compile(("Reader.gs", `package FindingPackageConstOperators

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
}`), ("Values.gs", `package FindingPackageConstOperators

const NotFalse = !false
const U64Sum = 5ul + 4ul
const Compared = 3 < 4 && 4 >= 4
const Equal = 7 == 7 && 8 != 9
const Logical = false || true
const Cleared = 15u &^ 6u
const Complement = ~15u
const BitMix = (12u & 10u) | (1u ^ 3u)
const Coalesced = nil ?? "fallback"
const Asserted = "ok"!!`))
        let assembly = program.Load()
        let container = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let check MethodInfo? = container.GetMethod("CheckOperators", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(check)
        Assert.Equal(0, check!!.Invoke(nil, nil))
        Assert.DoesNotContain(
            IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld
        )
        Assert.Equal(true, GetLiteral(container, "NotFalse")!!.GetRawConstantValue())
        Assert.Equal(9UL, GetLiteral(container, "U64Sum")!!.GetRawConstantValue())
        Assert.Equal(true, GetLiteral(container, "Compared")!!.GetRawConstantValue())
        Assert.Equal(true, GetLiteral(container, "Equal")!!.GetRawConstantValue())
        Assert.Equal(true, GetLiteral(container, "Logical")!!.GetRawConstantValue())
        Assert.Equal(9U, GetLiteral(container, "Cleared")!!.GetRawConstantValue())
        Assert.Equal(0xFFFFFFF0U, GetLiteral(container, "Complement")!!.GetRawConstantValue())
        Assert.Equal(10U, GetLiteral(container, "BitMix")!!.GetRawConstantValue())
        Assert.Equal("fallback", GetLiteral(container, "Coalesced")!!.GetRawConstantValue())
        Assert.Equal("ok", GetLiteral(container, "Asserted")!!.GetRawConstantValue())
    }

    @Fact
    func PackageConstConversions_FromAnotherSourceFile_PreserveClrSemantics() {
        using let program = Compile(("Reader.gs", `package FindingPackageConstConversions

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
}`), ("Values.gs", `package FindingPackageConstConversions

const Truncated int32 = int32(3.9)
const Rounded float64 = float64(float32(16777217) + 1.0f)
const Narrowed int8 = int8(257)
const WrappedThenWidened int64 = int32.MaxValue + 1
const UncheckedNegatedMin = -int32.MinValue
const ZeroExtended int64 = int64(uint32.MaxValue)
const UnsignedWrap uint64 = uint64(-1)
const CheckedFloat = checked(1.5f + 2.5f)`))
        let assembly = program.Load()
        let container = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let check MethodInfo? = container.GetMethod("CheckConversions", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(check)
        Assert.Equal(0, check!!.Invoke(nil, nil))
        Assert.DoesNotContain(
            IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld
        )
        Assert.Equal(3, GetLiteral(container, "Truncated")!!.GetRawConstantValue())
        Assert.Equal(16777216.0, GetLiteral(container, "Rounded")!!.GetRawConstantValue())
        Assert.Equal(int8(1), GetLiteral(container, "Narrowed")!!.GetRawConstantValue())
        Assert.Equal(-2147483648L, GetLiteral(container, "WrappedThenWidened")!!.GetRawConstantValue())
        Assert.Equal(int32.MinValue, GetLiteral(container, "UncheckedNegatedMin")!!.GetRawConstantValue())
        Assert.Equal(4294967295L, GetLiteral(container, "ZeroExtended")!!.GetRawConstantValue())
        Assert.Equal(uint64.MaxValue, GetLiteral(container, "UnsignedWrap")!!.GetRawConstantValue())
        Assert.Equal(4.0F, GetLiteral(container, "CheckedFloat")!!.GetRawConstantValue())
    }

    @Fact
    func ImportedEnumPackageConst_FromAnotherSourceFile_UsesUnderlyingMetadataPayload() {
        using let program = Compile(("Reader.gs", `package FindingImportedEnumPackageConst

func CheckImportedEnum() int32 {
    return D == System.DayOfWeek.Monday ? 0 : 1
}`), ("Values.gs", `package FindingImportedEnumPackageConst

const D System.DayOfWeek = System.DayOfWeek.Monday`))
        let assembly = program.Load()
        let container = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let check MethodInfo? = container.GetMethod("CheckImportedEnum", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(check)
        Assert.Equal(0, check!!.Invoke(nil, nil))
        Assert.DoesNotContain(
            IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld
        )
        let field FieldInfo? = GetLiteral(container, "D")
        Assert.Equal(typeof(DayOfWeek), field!!.FieldType)
        let raw object? = field!!.GetRawConstantValue()
        Assert.IsType[int32](raw)
        Assert.Equal(int32(DayOfWeek.Monday), raw)
    }

    @Fact
    func ExplicitReferenceEnumPackageConsts_UseExactUnderlyingMetadataPayloads() {
        let fixturePath = CompileExplicitEnumFixture()
        try {
            let fixture = AssemblyLoadContext.Default.LoadFromAssemblyPath(fixturePath)
            using let program = CompileWithReferences([]string{fixturePath}, ("Reader.gs", `package FindingExplicitReferenceEnumPackageConsts

import Issue3519.ExplicitEnums

func CheckExplicitEnums() int32 {
    return U == ByteCode.Combined && S == SByteCode.Adjusted ? 0 : 1
}`), ("Values.gs", `package FindingExplicitReferenceEnumPackageConsts

import Issue3519.ExplicitEnums

const U ByteCode = ByteCode.High | ByteCode.Low
const S SByteCode = SByteCode.Negative + int8(2)`))
            let assembly = program.Load()
            let container = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            let check MethodInfo? = container.GetMethod("CheckExplicitEnums", BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(check)
            Assert.Equal(0, check!!.Invoke(nil, nil))
            Assert.DoesNotContain(
                IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!),
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld
            )
            let byteEnum = fixture.GetType("Issue3519.ExplicitEnums.ByteCode")!!
            let sbyteEnum = fixture.GetType("Issue3519.ExplicitEnums.SByteCode")!!
            let unsigned FieldInfo? = GetLiteral(container, "U")
            let signed FieldInfo? = GetLiteral(container, "S")
            Assert.Equal(byteEnum, unsigned!!.FieldType)
            Assert.Equal(sbyteEnum, signed!!.FieldType)
            Assert.Equal(uint8(201), Assert.IsType[uint8](unsigned!!.GetRawConstantValue()))
            Assert.Equal(int8(-5), Assert.IsType[int8](signed!!.GetRawConstantValue()))
        } finally {
            File.Delete(fixturePath)
        }
    }

    @Fact
    func DecimalPackageConst_FromAnotherSourceFile_UsesInitializedReadOnlyStorage() {
        using let program = Compile(("Reader.gs", `package FindingPackageDecimalConst

func CheckDecimal() int32 { return Amount == -405.5m ? 0 : 1 }`), ("Values.gs", `package FindingPackageDecimalConst

const Amount decimal = -405.5m`))
        let assembly = program.Load()
        let container = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        Assert.NotNull(container.TypeInitializer)
        let check MethodInfo? = container.GetMethod(
            "CheckDecimal",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(check)
        Assert.Equal(0, check!!.Invoke(nil, nil))
        let amount FieldInfo? = container.GetField("Amount", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(amount)
        Assert.True(amount!!.IsInitOnly)
        Assert.False(amount!!.IsLiteral)
        Assert.False(amount!!.Attributes.HasFlag(FieldAttributes.HasDefault))
        Assert.Equal(-405.5M, amount!!.GetCustomAttribute[DecimalConstantAttribute]().Value)
        Assert.Equal(-405.5M, amount!!.GetValue(nil))
        Assert.DoesNotContain(
            IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld
        )
    }

    @Fact
    func DecimalTypeConstants_UseInitializedReadOnlyStorage() {
        using let program = Compile(("Main.gs", `package FindingDecimalTypeConstants

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
}`))
        let assembly = program.Load()
        let programType = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let check MethodInfo? = programType.GetMethod("CheckTypeConstants", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(check)
        Assert.Equal(0, check!!.Invoke(nil, nil))
        Assert.DoesNotContain(
            IlInstructionReader.Read(check!!.GetMethodBody()!!.GetILAsByteArray()!!),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldsfld
        )
        AssertDecimalReadOnlyField(assembly.GetType("FindingDecimalTypeConstants.Constants")!!, "ClassAmount", 12.5M)
        AssertDecimalReadOnlyField(
            assembly.GetType("FindingDecimalTypeConstants.IConstants")!!,
            "InterfaceAmount",
            2.5M
        )
    }

    @Theory
    @InlineData("nint")
    @InlineData("nuint")
    func NativeWidthPackageConst_ReportsTargetedDiagnostic(type string) {
        let result = EmitForDiagnostics((`package FindingPackageNativeConst

const Platform ` + "$type" + ` = 42`))
        Assert.False(result.Success)
        Assert.Equal(
            "GS0538",
            Assert.Single(
                result.Diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            )
                .Id
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS9998"
        )
    }

    @Fact
    func NestedNativeWidthConversionInPackageConst_ReportsGs0538() {
        let result = EmitForDiagnostics(`package FindingNestedNativeConst

const PlatformValue int64 = nint(4294967297L)`)
        Assert.False(result.Success)
        Assert.Equal(
            "GS0538",
            Assert.Single(
                result.Diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            )
                .Id
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS9998"
        )
    }

    @Theory
    @InlineData("const Bad = checked(int32.MaxValue + 1)")
    @InlineData("const Bad = checked(-int32.MinValue)")
    @InlineData("const Bad = checked(int8(257))")
    @InlineData("const Bad = 1 / 0")
    @InlineData("const Bad = 1m / 0m")
    @InlineData("const Bad = int64.MinValue / -1L")
    @InlineData("const Bad = 79228162514264337593543950335m + 1m")
    @InlineData("const Bad = System.DateTime.Now.Ticks")
    func InvalidPackageConstExpression_ReportsGs0376WithoutCompilerException(declaration string) {
        let result = EmitForDiagnostics((`package FindingInvalidPackageConst

` + "$declaration"))
        Assert.False(result.Success)
        Assert.Equal(
            "GS0376",
            Assert.Single(
                result.Diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            )
                .Id
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS9998"
        )
    }

    @Fact
    func NativeWidthTypeConstants_ReportTargetedDiagnostics() {
        let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(`package FindingNativeTypeConstants

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
}`, "Values.gs"))
        using let peStream = MemoryStream()
        let result = GsCompilation(tree).Emit(peStream)
        Assert.False(result.Success)
        let errors = result
            .Diagnostics
            .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
            .ToArray()
        Assert.Equal(4, errors.Length)
        Assert.All(errors, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> Assert.Equal("GS0538", diagnostic.Id))
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS9998"
        )
    }

    private data class ProcessResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
        Issue3519PackageConstEmitTests.ProcessResult
    ] { }

    private class CompiledProgram : IDisposable {
        init(directory string, outputPath string) {
            Directory = directory
            OutputPath = outputPath
        }

        prop Directory string {
            get;
        }

        prop OutputPath string {
            get;
        }

        func Load() Assembly -> EmittedFixture.Load(OutputPath)

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    shared {
        private func GetLiteral(container Type, name string) FieldInfo? {
            let field FieldInfo? = container.GetField(name, BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(field)
            Assert.True(field!!.IsLiteral)
            return field
        }

        private func AssertDecimalReadOnlyField(container Type?, name string, expected decimal) {
            let field FieldInfo? = container!!.GetField(name, BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(field)
            Assert.NotNull(container!!.TypeInitializer)
            Assert.True(field!!.IsInitOnly)
            Assert.False(field!!.IsLiteral)
            Assert.Equal(expected, field!!.GetCustomAttribute[DecimalConstantAttribute]().Value)
            Assert.Equal(expected, field!!.GetValue(nil))
        }

        private func EmitForDiagnostics(source string) GSharp.Core.CodeAnalysis.Compilation.EmitResult {
            let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source, "Values.gs"))
            using let peStream = MemoryStream()
            return GsCompilation(tree).Emit(peStream)
        }

        private func Compile(
            sources ...(FileName string, Source string)
        ) Issue3519PackageConstEmitTests.CompiledProgram -> CompileWithReferences(Array.Empty[string](), sources)

        private func CompileWithReferences(
            references IReadOnlyList[string],
            sources ...(FileName string, Source string)
        ) Issue3519PackageConstEmitTests
            .CompiledProgram {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue3519-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePaths = List[string](sources.Length)
                for source in sources {
                    let path = Path.Combine(directory, source.FileName)
                    File.WriteAllText(path, source.Source)
                    sourcePaths.Add(path)
                }
                let outputPath = Path.Combine(directory, "Issue3519.dll")
                let arguments = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
                for reference in references {
                    arguments.Add("/r:" + reference)
                }
                arguments.AddRange(sourcePaths)
                let exitCode = Program.Main(arguments.ToArray())
                Assert.Equal(0, exitCode)
                Assert.True(File.Exists(outputPath))
                IlVerifier.Verify(outputPath, additionalReferences: references)
                return Issue3519PackageConstEmitTests.CompiledProgram(directory, outputPath)
            } catch {
                Directory.Delete(directory, recursive: true)
                rethrow
            }
        }

        private func CompileExplicitEnumFixture() string {
            let outputPath = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3519.ExplicitEnums." + Guid.NewGuid().ToString("N") + ".dll"
            )
            let trustedPlatformAssemblies = Assert.IsType[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
            let references = trustedPlatformAssemblies.Split(Path.PathSeparator).Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            )
            let compilation = CSharpCompilation.Create(
                "Issue3519.ExplicitEnums",
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(`namespace Issue3519.ExplicitEnums;

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
}`)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func Run(outputPath string) Issue3519PackageConstEmitTests.ProcessResult {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(outputPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(outputPath)
            using let process = Process.Start(startInfo)!!
            let standardOutput = process.StandardOutput.ReadToEnd()
            let standardError = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out")
            return Issue3519PackageConstEmitTests.ProcessResult(process.ExitCode, standardOutput, standardError)
        }
    }
}
