// <copyright file="Issue2770OptionalIntegralDefaultsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import MetadataParameter = System.Reflection.Metadata.Parameter
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation

/// Regression coverage for issue #2770.
class Issue2770OptionalIntegralDefaultsEmitTests {
    @Fact
    func IntegralDefaults_OnMethodsAndConstructors_EmitExactConstantsAndSupportCSharpOmission() {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2770OptionalIntegralDefaultsEmitTests")
        Directory.CreateDirectory(directory)
        let libraryPath = Path.Combine(directory, "Issue2770.Library.dll")
        let consumerPath = Path.Combine(directory, "Issue2770.Consumer.dll")
        const parameters = `b byte = 255,
sb sbyte = -128,
s int16 = -32768,
us uint16 = 65535,
i int32 = -2147483647,
ui uint32 = 4294967295,
l int64 = -9223372036854775807,
ul uint64 = 18446744073709551615,
c char = 65535,
mode Mode = -1`
        let source = (`package Issue2770

enum Mode { Negative = -1 }

class Defaults {
    init(` + "$parameters" + `) {
    }

    func All(` + "$parameters" + `) {
    }
}`)
        EmitGSharpLibrary(source, libraryPath)
        AssertParameterMetadata(libraryPath)
        EmitCSharpConsumer(libraryPath, consumerPath)
        let loadContext = AssemblyLoadContext("Issue2770", isCollectible: true)
        try {
            let library = loadContext.LoadFromAssemblyPath(libraryPath)
            let defaults = library.GetType("Issue2770.Defaults", throwOnError: true)!!
            AssertReflectionDefaults(defaults.GetConstructors().Single().GetParameters())
            AssertReflectionDefaults(defaults.GetMethod("All")!!.GetParameters())
            let consumer = loadContext.LoadFromAssemblyPath(consumerPath)
            Assert.True(
                bool(consumer.GetType("Issue2770Consumer", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)!!)
            )
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func OutOfRangeAndInvalidDefaults_ReportUsefulDiagnostics() {
        const source = `package Issue2770

enum Mode { Zero }

class InvalidConstructor {
    init(value byte = 256) {
    }
}

func NegativeByte(value byte = -1) {}
func LowSByte(value sbyte = -129) {}
func HighUInt16(value uint16 = 65536) {}
func NegativeUInt32(value uint32 = -1) {}
func NegativeUInt64(value uint64 = -1) {}
func HighChar(value char = 65536) {}
func HighEnum(value Mode = 2147483648) {}
func FloatToByte(value byte = 1.5) {}
func StringToInt(value int32 = "invalid") {}`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2770.Invalid")
        let diagnostics = result
            .Diagnostics
            .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0265")
            .ToArray()
        Assert.False(result.Success)
        Assert.Equal(10, diagnostics.Length)
        Assert.Equal(
            8,
            diagnostics.Count(
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Message.Contains(
                    "outside the range",
                    StringComparison.Ordinal
                )
            )
        )
        Assert.Equal(
            2,
            diagnostics.Count(
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Message.Contains(
                    "not implicitly convertible",
                    StringComparison.Ordinal
                )
            )
        )
    }

    shared {
        private func EmitGSharpLibrary(source string, outputPath string) {
            using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            var result GSharp.Core.CodeAnalysis.Compilation.EmitResult
            {
                using let output = File.Create(outputPath)
                result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2770.Library")
            }
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            IlVerifier.Verify(outputPath)
        }

        private func AssertParameterMetadata(libraryPath string) {
            let expectedCodes = []ConstantTypeCode{
                ConstantTypeCode.Byte,
                ConstantTypeCode.SByte,
                ConstantTypeCode.Int16,
                ConstantTypeCode.UInt16,
                ConstantTypeCode.Int32,
                ConstantTypeCode.UInt32,
                ConstantTypeCode.Int64,
                ConstantTypeCode.UInt64,
                ConstantTypeCode.Char,
                ConstantTypeCode.Int32
            }
            using let stream = File.OpenRead(libraryPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let defaultsType = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((type TypeDefinition) -> reader.GetString(type.Name) == "Defaults")
            let methods = defaultsType
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Where((method MethodDefinition) -> (reader.GetString(method.Name) is ".ctor" or "All"))
                .ToArray()
            Assert.Equal(2, methods.Length)
            for method in methods {
                let parameters = method.GetParameters().Select(reader.GetParameter).ToArray()
                Assert.Equal(expectedCodes.Length, parameters.Length)
                Assert.Equal(
                    expectedCodes,
                    parameters.Select(
                        (parameter MetadataParameter) -> reader.GetConstant(parameter.GetDefaultValue()).TypeCode
                    )
                )
                Assert.All(
                    parameters,
                    (parameter MetadataParameter) -> {
                        Assert.True((parameter.Attributes & ParameterAttributes.Optional) != 0)
                        Assert.True((parameter.Attributes & ParameterAttributes.HasDefault) != 0)
                    }
                )
            }
        }

        private func AssertReflectionDefaults(parameters[]ParameterInfo) {
            let expected = []object{
                uint8.MaxValue,
                int8.MinValue,
                int16.MinValue,
                uint16.MaxValue,
                -2147483647,
                uint32.MaxValue,
                -9223372036854775807L,
                uint64.MaxValue,
                char.MaxValue,
                -1
            }
            Assert.Equal(expected.Length, parameters.Length)
            for var i = 0; i < parameters.Length; i++ {
                Assert.True(parameters[i].IsOptional)
                Assert.True(parameters[i].HasDefaultValue)
                Assert.Equal(expected[i], parameters[i].RawDefaultValue)
            }
        }

        private func EmitCSharpConsumer(libraryPath string, outputPath string) {
            const source = `public static class Issue2770Consumer
{
    public static bool Run()
    {
        var value = new Issue2770.Defaults();
        value.All();
        return true;
    }
}`
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
                .Append(MetadataReference.CreateFromFile(libraryPath))
            let compilation = CSharpCompilation.Create(
                "Issue2770.Consumer",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
