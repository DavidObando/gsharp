// <copyright file="Issue2745OptionalParameterMetadataEmitTests.cs" company="GSharp">
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
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import System.Collections.Generic

/// Regression coverage for issue #2745.
class Issue2745OptionalParameterMetadataEmitTests {
    @Fact
    func MethodsAndConstructors_ExposeDefaultsToReflectionAndCSharpConsumers() {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2745OptionalParameterMetadataEmitTests")
        Directory.CreateDirectory(directory)
        let libraryPath = Path.Combine(directory, "Issue2745.Library.dll")
        let consumerPath = Path.Combine(directory, "Issue2745.Consumer.dll")
        const source = `package Issue2745
import System

class Defaults {
    init(count int64 = 5, title string = "ctor", day DayOfWeek = DayOfWeek.Monday) {
    }

    func Score(enabled bool = true, marker char = 'A', scale float64 = 2.5, note string? = nil) int32 {
        if enabled && marker == 'A' && scale == 2.5 && note == nil {
            return 42
        }
        return 0
    }
}

func RunGSharp() int32 -> Defaults().Score()`
        EmitGSharpLibrary(source, libraryPath)
        AssertParameterMetadata(libraryPath)
        EmitCSharpConsumer(libraryPath, consumerPath)
        let loadContext = AssemblyLoadContext("Issue2745", isCollectible: true)
        try {
            let library = loadContext.LoadFromAssemblyPath(libraryPath)
            let defaults = library.GetType("Issue2745.Defaults", throwOnError: true)!!
            AssertReflectionDefaults(defaults)
            let program = library.GetTypes().Single((type Type) -> type.Name == "<Program>")
            Assert.Equal(
                42,
                program.GetMethod(
                    "RunGSharp",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )!!.Invoke(nil, nil)
            )
            let consumer = loadContext.LoadFromAssemblyPath(consumerPath)
            Assert.Equal(
                42,
                consumer.GetType("Issue2745Consumer", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)
            )
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func UnsupportedOrMismatchedMetadataConstants_AreRejected() {
        const source = `package Issue2745

func WrongType(value string = 1) {
}

func DecimalValue(value decimal = 1.5m) {
}`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2745.Invalid")
        Assert.False(result.Success)
        Assert.Equal(
            2,
            result.Diagnostics.Count((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0265")
        )
    }

    shared {
        private func EmitGSharpLibrary(source string, outputPath string) {
            using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            var result GSharp.Core.CodeAnalysis.Compilation.EmitResult
            {
                using let output = File.Create(outputPath)
                result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2745.Library")
            }
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            IlVerifier.Verify(outputPath)
        }

        private func AssertParameterMetadata(libraryPath string) {
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
                .Where((method MethodDefinition) -> (reader.GetString(method.Name) is ".ctor" or "Score"))
                .ToArray()
            Assert.Equal(2, methods.Length)
            for parameter in methods.SelectMany(
                func (method MethodDefinition) IEnumerable[ParameterHandle] {
                    return method.GetParameters()
                }
            )
                .Select(reader.GetParameter) {
                Assert.True((parameter.Attributes & ParameterAttributes.Optional) != 0)
                Assert.True((parameter.Attributes & ParameterAttributes.HasDefault) != 0)
                Assert.False(parameter.GetDefaultValue().IsNil)
            }
        }

        private func AssertReflectionDefaults(defaults Type) {
            let constructor = defaults.GetConstructors().Single()
            let ctorParameters = constructor.GetParameters()
            Assert.Collection(
                ctorParameters,
                (parameter ParameterInfo) -> AssertDefault(parameter, 5L),
                (parameter ParameterInfo) -> AssertDefault(parameter, "ctor"),
                (parameter ParameterInfo) -> {
                    Assert.True(parameter.IsOptional)
                    Assert.True(parameter.HasDefaultValue)
                    Assert.Equal(1, Convert.ToInt32(parameter.DefaultValue))
                }
            )
            let methodParameters = defaults.GetMethod("Score")!!.GetParameters()
            Assert.Collection(
                methodParameters,
                (parameter ParameterInfo) -> AssertDefault(parameter, true),
                (parameter ParameterInfo) -> AssertDefault(parameter, 'A'),
                (parameter ParameterInfo) -> AssertDefault(parameter, 2.5),
                (parameter ParameterInfo) -> AssertDefault(parameter, nil)
            )
        }

        private func AssertDefault(parameter ParameterInfo, expected object?) {
            Assert.True(parameter.IsOptional)
            Assert.True(parameter.HasDefaultValue)
            Assert.Equal(expected, parameter.DefaultValue)
        }

        private func EmitCSharpConsumer(libraryPath string, outputPath string) {
            const source = `public static class Issue2745Consumer
{
    public static int Run()
    {
        var value = new Issue2745.Defaults();
        return value.Score();
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
                "Issue2745.Consumer",
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
