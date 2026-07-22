// <copyright file="Issue2745OptionalParameterMetadataEmitTests.cs" company="GSharp">
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

/// <summary>Regression coverage for issue #2745.</summary>
public sealed class Issue2745OptionalParameterMetadataEmitTests
{
    [Fact]
    public void MethodsAndConstructors_ExposeDefaultsToReflectionAndCSharpConsumers()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2745OptionalParameterMetadataEmitTests));
        Directory.CreateDirectory(directory);
        var libraryPath = Path.Combine(directory, "Issue2745.Library.dll");
        var consumerPath = Path.Combine(directory, "Issue2745.Consumer.dll");

        const string source = """
            package Issue2745
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

            func RunGSharp() int32 -> Defaults().Score()
            """;

        EmitGSharpLibrary(source, libraryPath);
        AssertParameterMetadata(libraryPath);
        EmitCSharpConsumer(libraryPath, consumerPath);

        var loadContext = new AssemblyLoadContext("Issue2745", isCollectible: true);
        try
        {
            var library = loadContext.LoadFromAssemblyPath(libraryPath);
            var defaults = library.GetType("Issue2745.Defaults", throwOnError: true)!;
            AssertReflectionDefaults(defaults);

            var program = library.GetTypes().Single(type => type.Name == "<Program>");
            Assert.Equal(42, program.GetMethod("RunGSharp", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, null));

            var consumer = loadContext.LoadFromAssemblyPath(consumerPath);
            Assert.Equal(42, consumer.GetType("Issue2745Consumer", throwOnError: true)!.GetMethod("Run")!.Invoke(null, null));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void UnsupportedOrMismatchedMetadataConstants_AreRejected()
    {
        const string source = """
            package Issue2745

            func WrongType(value string = 1) {
            }

            func DecimalValue(value decimal = 1.5m) {
            }
            """;

        using var resolver = ReferenceResolver.WithReferences(Array.Empty<string>());
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };
        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2745.Invalid");

        Assert.False(result.Success);
        Assert.Equal(2, result.Diagnostics.Count(diagnostic => diagnostic.Id == "GS0265"));
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
            result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2745.Library");
        }

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        IlVerifier.Verify(outputPath);
    }

    private static void AssertParameterMetadata(string libraryPath)
    {
        using var stream = File.OpenRead(libraryPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var defaultsType = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(type => reader.GetString(type.Name) == "Defaults");

        var methods = defaultsType.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Where(method => reader.GetString(method.Name) is ".ctor" or "Score")
            .ToArray();
        Assert.Equal(2, methods.Length);

        foreach (var parameter in methods.SelectMany(method => method.GetParameters()).Select(reader.GetParameter))
        {
            Assert.True((parameter.Attributes & ParameterAttributes.Optional) != 0);
            Assert.True((parameter.Attributes & ParameterAttributes.HasDefault) != 0);
            Assert.False(parameter.GetDefaultValue().IsNil);
        }
    }

    private static void AssertReflectionDefaults(Type defaults)
    {
        var constructor = defaults.GetConstructors().Single();
        var ctorParameters = constructor.GetParameters();
        Assert.Collection(
            ctorParameters,
            parameter => AssertDefault(parameter, 5L),
            parameter => AssertDefault(parameter, "ctor"),
            parameter =>
            {
                Assert.True(parameter.IsOptional);
                Assert.True(parameter.HasDefaultValue);
                Assert.Equal(1, Convert.ToInt32(parameter.DefaultValue));
            });

        var methodParameters = defaults.GetMethod("Score")!.GetParameters();
        Assert.Collection(
            methodParameters,
            parameter => AssertDefault(parameter, true),
            parameter => AssertDefault(parameter, 'A'),
            parameter => AssertDefault(parameter, 2.5),
            parameter => AssertDefault(parameter, null));
    }

    private static void AssertDefault(ParameterInfo parameter, object expected)
    {
        Assert.True(parameter.IsOptional);
        Assert.True(parameter.HasDefaultValue);
        Assert.Equal(expected, parameter.DefaultValue);
    }

    private static void EmitCSharpConsumer(string libraryPath, string outputPath)
    {
        const string source = """
            public static class Issue2745Consumer
            {
                public static int Run()
                {
                    var value = new Issue2745.Defaults();
                    return value.Score();
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
            "Issue2745.Consumer",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var output = File.Create(outputPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
