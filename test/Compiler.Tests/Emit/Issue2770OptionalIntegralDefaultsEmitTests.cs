// <copyright file="Issue2770OptionalIntegralDefaultsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Regression coverage for issue #2770.</summary>
public sealed class Issue2770OptionalIntegralDefaultsEmitTests
{
    [Fact]
    public void IntegralDefaults_OnMethodsAndConstructors_EmitExactConstantsAndSupportCSharpOmission()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2770OptionalIntegralDefaultsEmitTests));
        Directory.CreateDirectory(directory);
        var libraryPath = Path.Combine(directory, "Issue2770.Library.dll");
        var consumerPath = Path.Combine(directory, "Issue2770.Consumer.dll");

        const string parameters = """
            b byte = 255,
            sb sbyte = -128,
            s int16 = -32768,
            us uint16 = 65535,
            i int32 = -2147483647,
            ui uint32 = 4294967295,
            l int64 = -9223372036854775807,
            ul uint64 = 18446744073709551615,
            c char = 65535,
            mode Mode = -1
            """;
        var source = $$"""
            package Issue2770

            enum Mode { Negative = -1 }

            class Defaults {
                init({{parameters}}) {
                }

                func All({{parameters}}) {
                }
            }
            """;

        EmitGSharpLibrary(source, libraryPath);
        AssertParameterMetadata(libraryPath);
        EmitCSharpConsumer(libraryPath, consumerPath);

        var loadContext = new AssemblyLoadContext("Issue2770", isCollectible: true);
        try
        {
            var library = loadContext.LoadFromAssemblyPath(libraryPath);
            var defaults = library.GetType("Issue2770.Defaults", throwOnError: true)!;
            AssertReflectionDefaults(defaults.GetConstructors().Single().GetParameters());
            AssertReflectionDefaults(defaults.GetMethod("All")!.GetParameters());

            var consumer = loadContext.LoadFromAssemblyPath(consumerPath);
            Assert.True((bool)consumer.GetType("Issue2770Consumer", throwOnError: true)!.GetMethod("Run")!.Invoke(null, null)!);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void OutOfRangeAndInvalidDefaults_ReportUsefulDiagnostics()
    {
        const string source = """
            package Issue2770

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
            func StringToInt(value int32 = "invalid") {}
            """;

        using var resolver = ReferenceResolver.WithReferences(Array.Empty<string>());
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };
        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2770.Invalid");
        var diagnostics = result.Diagnostics.Where(diagnostic => diagnostic.Id == "GS0265").ToArray();

        Assert.False(result.Success);
        Assert.Equal(10, diagnostics.Length);
        Assert.Equal(8, diagnostics.Count(diagnostic => diagnostic.Message.Contains("outside the range", StringComparison.Ordinal)));
        Assert.Equal(2, diagnostics.Count(diagnostic => diagnostic.Message.Contains("not implicitly convertible", StringComparison.Ordinal)));
    }

    private static void EmitGSharpLibrary(string source, string outputPath)
    {
        using var resolver = ReferenceResolver.WithReferences(Array.Empty<string>());
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };
        GSharp.Core.CodeAnalysis.Compilation.EmitResult result;
        using (var output = File.Create(outputPath))
        {
            result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2770.Library");
        }

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        IlVerifier.Verify(outputPath);
    }

    private static void AssertParameterMetadata(string libraryPath)
    {
        var expectedCodes = new[]
        {
            ConstantTypeCode.Byte,
            ConstantTypeCode.SByte,
            ConstantTypeCode.Int16,
            ConstantTypeCode.UInt16,
            ConstantTypeCode.Int32,
            ConstantTypeCode.UInt32,
            ConstantTypeCode.Int64,
            ConstantTypeCode.UInt64,
            ConstantTypeCode.Char,
            ConstantTypeCode.Int32,
        };

        using var stream = File.OpenRead(libraryPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var defaultsType = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(type => reader.GetString(type.Name) == "Defaults");
        var methods = defaultsType.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Where(method => reader.GetString(method.Name) is ".ctor" or "All")
            .ToArray();

        Assert.Equal(2, methods.Length);
        foreach (var method in methods)
        {
            var parameters = method.GetParameters().Select(reader.GetParameter).ToArray();
            Assert.Equal(expectedCodes.Length, parameters.Length);
            Assert.Equal(expectedCodes, parameters.Select(parameter => reader.GetConstant(parameter.GetDefaultValue()).TypeCode));
            Assert.All(parameters, parameter =>
            {
                Assert.True((parameter.Attributes & ParameterAttributes.Optional) != 0);
                Assert.True((parameter.Attributes & ParameterAttributes.HasDefault) != 0);
            });
        }
    }

    private static void AssertReflectionDefaults(ParameterInfo[] parameters)
    {
        var expected = new object[]
        {
            byte.MaxValue,
            sbyte.MinValue,
            short.MinValue,
            ushort.MaxValue,
            -2147483647,
            uint.MaxValue,
            -9223372036854775807L,
            ulong.MaxValue,
            char.MaxValue,
            -1,
        };

        Assert.Equal(expected.Length, parameters.Length);
        for (var i = 0; i < parameters.Length; i++)
        {
            Assert.True(parameters[i].IsOptional);
            Assert.True(parameters[i].HasDefaultValue);
            Assert.Equal(expected[i], parameters[i].RawDefaultValue);
        }
    }

    private static void EmitCSharpConsumer(string libraryPath, string outputPath)
    {
        const string source = """
            public static class Issue2770Consumer
            {
                public static bool Run()
                {
                    var value = new Issue2770.Defaults();
                    value.All();
                    return true;
                }
            }
            """;

        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(libraryPath));
        var compilation = CSharpCompilation.Create(
            "Issue2770.Consumer",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var output = File.Create(outputPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
