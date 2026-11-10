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
import System.Runtime.CompilerServices
import System.Runtime.Loader
import CompilerProgram = GSharp.Compiler.Program
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
            let library = loadContext.LoadFromStream(MemoryStream(File.ReadAllBytes(libraryPath)))
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
            let consumer = loadContext.LoadFromStream(MemoryStream(File.ReadAllBytes(consumerPath)))
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

func BoxedValue(value object = 1) {
}

func FloatToDecimal(value decimal = 1.5) {
}`
        using let resolver = ReferenceResolver.WithReferences(Array.Empty[string]())
        let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2745.Invalid")
        Assert.False(result.Success)
        Assert.Equal(
            3,
            result.Diagnostics.Count((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0265")
        )
    }

    @Fact
    func DecimalOptionalParameters_EmitDecimalConstantAttributesAndRoundTripAcrossDriversAndAssemblies() {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue5871DecimalOptionalParameters",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let sourcePath = Path.Combine(directory, "Issue5871.gs")
            let libraryPath = Path.Combine(directory, "Issue5871.dll")
            File.WriteAllText(sourcePath, `package Issue5871
import System

data class Order(amount decimal = 1.50m, discount decimal? = -0.25m)

class DecimalDefaults {
    var Summary string
    init(
        scaled decimal = 1.50m,
        negative decimal = -3.25m,
        negativeZero decimal = -0.00m,
        widened decimal = 42,
        nullableScaled decimal? = 2.75m,
        nullableMissing decimal? = nil,
        low decimal = decimal.MinValue,
        high decimal = decimal.MaxValue
    ) {
        Summary = "${scaled}|${decimal.GetBits(scaled)[3]}|${negative}|${decimal.GetBits(negativeZero)[3]}|${widened}|${nullableScaled}|${nullableMissing == nil}|${low == decimal.MinValue && high == decimal.MaxValue}"
    }

    shared {
        func Pick(value decimal = 1m) decimal -> value
        func PickNullable(value decimal? = 1.50m) decimal? -> value
        func Describe(
            scaled decimal = 1.50m,
            negative decimal = -3.25m,
            negativeZero decimal = -0.00m,
            widened decimal = 42,
            nullableScaled decimal? = 2.75m,
            nullableMissing decimal? = nil
        ) string -> "${scaled}|${decimal.GetBits(scaled)[3]}|${negative}|${decimal.GetBits(negativeZero)[3]}|${widened}|${nullableScaled}|${nullableMissing == nil}"
    }
}`)
            let driverExit = CompilerProgram.Main(
                []string{
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/out:" + libraryPath,
                    sourcePath
                }
            )
            Assert.Equal(0, driverExit)
            IlVerifier.Verify(libraryPath)
            AssertDecimalParameterMetadata(libraryPath)
            let csharpInteropPath = Path.Combine(directory, "Issue5871CSharp.dll")
            EmitCSharpDecimalInterop(libraryPath, csharpInteropPath)
            let callerSourcePath = Path.Combine(directory, "Issue5871Caller.gs")
            let callerPath = Path.Combine(directory, "Issue5871Caller.dll")
            File.WriteAllText(callerSourcePath, `package Issue5871Caller
import System
import Issue5871
import Issue5871CSharp

class Caller {
    shared {
        func Run() string {
            let order = Order()
            let recordValue = ForeignRecord()
            return "${DecimalDefaults.Pick()}|${DecimalDefaults.PickNullable()}|${DecimalDefaults().Summary}|${DecimalDefaults.Describe(nullableScaled: -9.5m)}|${order.amount}:${order.discount}|${CSharpConsumer.RunGSharpDefaults()}|${CSharpConsumer.SignedAttr()}|${CSharpConsumer.SignedNullableAttr()}|${CSharpConsumer.BoxedSignedAttr()}|${recordValue.Amount}:${recordValue.Discount}"
        }
    }
}`)
            let callerExit = CompilerProgram.Main(
                []string{
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/reference:" + libraryPath,
                    "/reference:" + csharpInteropPath,
                    "/out:" + callerPath,
                    callerSourcePath
                }
            )
            Assert.Equal(0, callerExit)
            IlVerifier.Verify(callerPath, additionalReferences: []string{libraryPath, csharpInteropPath})
            let loadContext = AssemblyLoadContext("Issue5871", isCollectible: true)
            try {
                let library = loadContext.LoadFromStream(MemoryStream(File.ReadAllBytes(libraryPath)))
                let interop = loadContext.LoadFromStream(MemoryStream(File.ReadAllBytes(csharpInteropPath)))
                let caller = loadContext.LoadFromStream(MemoryStream(File.ReadAllBytes(callerPath)))
                let pickParam = library.GetType("Issue5871.DecimalDefaults", throwOnError: true)!!.GetMethod("Pick")!!
                    .GetParameters().Single()
                Assert.True(pickParam.IsOptional)
                Assert.True(pickParam.HasDefaultValue)
                Assert.Equal(1m, pickParam.DefaultValue)
                Assert.Equal(1m, pickParam.GetCustomAttribute[DecimalConstantAttribute]().Value)
                let output = cast[string](
                    caller.GetType("Issue5871Caller.Caller", throwOnError: true)!!.GetMethod("Run")!!.Invoke(nil, nil)!!
                )
                Assert.Equal(
                    "1|1.50|1.50|131072|-3.25|-2147352576|42|2.75|True|True|1.50|131072|-3.25|-2147352576|42|-9.5|True|1.50:-0.25|1/1.50/1.50|131072|-3.25|-2147352576|42|2.75|True|True/1.50:-0.25|-0.75|-0.75|Decimal:-0.75|4.25:-1.25",
                    output
                )
            } finally {
                loadContext.Unload()
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
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

        private func AssertDecimalParameterMetadata(libraryPath string) {
            using let stream = File.OpenRead(libraryPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let defaultsType = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((type TypeDefinition) -> reader.GetString(type.Name) == "DecimalDefaults")
            let describe = defaultsType
                .GetMethods()
                .Select(reader.GetMethodDefinition)
                .Single((method MethodDefinition) -> reader.GetString(method.Name) == "Describe")
            let parameters = describe.GetParameters().Select(reader.GetParameter).ToArray()
            Assert.Equal(6, parameters.Length)
            for var i = 0; i < 5; i++ {
                let parameter = parameters[i]
                Assert.True((parameter.Attributes & ParameterAttributes.Optional) != 0)
                Assert.True((parameter.Attributes & ParameterAttributes.HasDefault) == 0)
                Assert.True(parameter.GetDefaultValue().IsNil)
                Assert.NotEmpty(parameter.GetCustomAttributes())
            }
            let nullableMissing = parameters[5]
            Assert.True((nullableMissing.Attributes & ParameterAttributes.Optional) != 0)
            Assert.True((nullableMissing.Attributes & ParameterAttributes.HasDefault) != 0)
            Assert.False(nullableMissing.GetDefaultValue().IsNil)
        }

        private func EmitCSharpDecimalInterop(libraryPath string, outputPath string) {
            const source = `using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Issue5871;

namespace Issue5871CSharp
{
    public record ForeignRecord(decimal Amount = 4.25m, decimal? Discount = -1.25m);

    public static class CSharpConsumer
    {
        public static string RunGSharpDefaults()
        {
            var order = new Order();
            return $"{DecimalDefaults.Pick()}/{DecimalDefaults.PickNullable()}/{new DecimalDefaults().Summary}/{order.amount}:{order.discount}";
        }

        public static string SignedAttr([Optional, DecimalConstant(2, 128, 0, 0, 75)] decimal x) => $"{x}";
        public static string SignedNullableAttr([Optional, DecimalConstant(2, 128, 0, 0, 75)] decimal? x) => $"{x}";
        public static string BoxedSignedAttr([Optional, DecimalConstant(2, 128, 0, 0, 75)] object x) => $"{x.GetType().Name}:{x}";
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
                "Issue5871CSharp",
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
