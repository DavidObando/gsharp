// <copyright file="GsStubClassShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using static GSharp.GeneratorHost.Tests.StubTestSupport;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0195 / issue #4674: a generator reads the stub through Roslyn, so the CLR shape of
/// a G# <c>abstract class</c> and <c>shared class</c> has to be the C# one
/// (<c>INamedTypeSymbol.IsAbstract</c> / <c>IsStatic</c>), or it can produce different
/// output than for the real type.
/// </summary>
public class GsStubClassShapeTests
{
    [Theory]
    [InlineData("open partial class Target { open func Visit() int32; }", "", true, false, MethodAttributes.Public, false)]
    [InlineData("open class Base { open func Visit() int32; }\nopen partial class Target : Base {}", "", true, false, MethodAttributes.Public, false)]
    [InlineData("open class Base { open func Visit() int32; }\nopen partial class Target : Base { override func Visit() int32 { return 1 } }", "", false, false, MethodAttributes.Public, false)]
    [InlineData("abstract partial class Target { func Visit() int32 { return 1 } }", "", true, false, MethodAttributes.Family, false)]
    [InlineData("open partial class Target { func Visit() int32 { return 1 } }", "", false, false, MethodAttributes.Public, false)]
    [InlineData("shared partial class Target { func Visit() int32 { return 1 } }", "", true, true, MethodAttributes.Private, false)]
    [InlineData("partial class Target {}", "abstract partial class Target { func Visit() int32 { return 1 } }", true, false, MethodAttributes.Family, false)]
    [InlineData("open partial class Target {}", "open partial class Target { open func Visit() int32; }", true, false, MethodAttributes.Public, false)]
    [InlineData("open partial class Target {}", "", false, false, MethodAttributes.Public, true)]
    public void LoadedGenerator_ObservesSemanticAbstractness_AndGeneratedPartPreservesEmittedShape(
        string declaration,
        string secondPart,
        bool expectedAbstract,
        bool expectedStatic,
        MethodAttributes expectedConstructorAccess,
        bool generatedAbstract)
    {
        var sources = new[] { declaration, secondPart }
            .Where(source => source.Length > 0)
            .Select(source => "package App\n" + source)
            .ToArray();
        var trees = sources.Select(source => GsSyntaxTree.Parse(SourceText.From(source))).ToArray();
        var gs = new Compilation(trees) { IsLibrary = true };
        Assert.DoesNotContain(gs.GlobalScope.Diagnostics.Concat(gs.BoundProgram.Diagnostics), diagnostic => diagnostic.IsError);
        var target = Assert.Single(gs.GlobalScope.Structs, type => type.Name == "Target");
        Assert.Equal(expectedAbstract, target.IsAbstract);
        AssertEmittedShape(gs, expectedAbstract, expectedStatic, expectedConstructorAccess);

        var workspace = Directory.CreateTempSubdirectory("gsgen_abstract_shape_").FullName;
        try
        {
            // Compile the generator with Roslyn and explicitly load its DLL; never
            // depend on the test assembly still being C# after self-migration.
            var generatorPath = Path.Combine(workspace, "AbstractShapeGenerator.dll");
            CompileShapeGenerator(generatorPath, generatedAbstract);
            var result = GeneratorHostRunner.RunFromAnalyzerPaths(
                gs,
                CSharpProjectLoader.RuntimeReferences(),
                new[] { generatorPath });
            Assert.Empty(result.Failures);
            Assert.Empty(result.HostDiagnostics);
            Assert.Empty(result.StubFallbacks);
            var observation = Assert.Single(result.GeneratorDiagnostics);
            Assert.Equal("GSABS001", observation.Id);
            // Roslyn source symbols report static separately from abstract; the
            // emitted CLR static class still carries both Abstract and Sealed.
            var expectedRoslynAbstract = expectedAbstract && !expectedStatic;
            Assert.Equal($"App.Target|abstract={expectedRoslynAbstract}|static={expectedStatic}", observation.GetMessage());
            var generated = Assert.Single(result.GeneratedGsFiles);

            var combined = new Compilation(trees.Append(
                GsSyntaxTree.Parse(SourceText.From(generated.GSharpSource, generated.HintName + ".gs"))).ToArray())
            {
                IsLibrary = true,
            };
            Assert.DoesNotContain(combined.GlobalScope.Diagnostics.Concat(combined.BoundProgram.Diagnostics), diagnostic => diagnostic.IsError);
            AssertEmittedShape(
                combined,
                expectedAbstract || generatedAbstract,
                expectedStatic,
                generatedAbstract ? MethodAttributes.Family : expectedConstructorAccess,
                expectedRoslynAbstract);
        }
        finally
        {
            Directory.Delete(workspace, recursive: true);
        }
    }

    [Fact]
    public void AbstractAndSharedClasses_ReachAGeneratorAsAbstractAndStaticTypes()
    {
        var stub = Project(@"
package App

abstract class Walker {
    func Visit() int32 { return 1 }
}

abstract data class Shape(Sides int32)

shared class Helpers {
    func One() int32 { return 1 }
}

shared partial class Split {
    func A() int32 { return 1 }
}

class Plain {
    func Two() int32 { return 2 }
}
");

        AssertParses(stub);
        var compilation = BindStub(stub);

        Assert.True(compilation.GetTypeByMetadataName("App.Walker")!.IsAbstract, stub);
        Assert.True(compilation.GetTypeByMetadataName("App.Shape")!.IsAbstract, stub);
        Assert.False(compilation.GetTypeByMetadataName("App.Walker")!.IsStatic);

        var helpers = compilation.GetTypeByMetadataName("App.Helpers")!;
        Assert.True(helpers.IsStatic, stub);
        Assert.True(compilation.GetTypeByMetadataName("App.Split")!.IsStatic, stub);

        var plain = compilation.GetTypeByMetadataName("App.Plain")!;
        Assert.False(plain.IsAbstract);
        Assert.False(plain.IsStatic);
    }

    private static void AssertEmittedShape(
        Compilation compilation,
        bool expectedAbstract,
        bool expectedSealed,
        MethodAttributes expectedConstructorAccess,
        bool? observedAbstract = null)
    {
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));
        pe.Position = 0;
        var loadContext = new AssemblyLoadContext("AbstractShape-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        try
        {
            var assembly = loadContext.LoadFromStream(pe);
            var type = Assert.Single(assembly.GetTypes(), type => type.FullName == "App.Target");
            Assert.Equal(expectedAbstract, type.IsAbstract);
            Assert.Equal(expectedSealed, type.IsSealed);
            var constructor = Assert.Single(type.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance));
            Assert.Equal(expectedConstructorAccess, constructor.Attributes & MethodAttributes.MemberAccessMask);
            if (observedAbstract.HasValue)
            {
                var property = type.GetProperty("ObservedAbstract", BindingFlags.Public | BindingFlags.Static);
                Assert.NotNull(property);
                Assert.Equal(observedAbstract.Value, property.GetValue(null));
            }
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static void CompileShapeGenerator(string path, bool generatedAbstract)
    {
        const string source = """
            using Microsoft.CodeAnalysis;

            [Generator]
            public sealed class AbstractShapeGenerator : IIncrementalGenerator
            {
                public void Initialize(IncrementalGeneratorInitializationContext context)
                {
                    context.RegisterSourceOutput(context.CompilationProvider, static (output, compilation) =>
                    {
                        var symbol = compilation.GetTypeByMetadataName("App.Target");
                        if (symbol == null)
                        {
                            throw new System.InvalidOperationException("App.Target was not projected");
                        }

                        var descriptor = new DiagnosticDescriptor(
                            "GSABS001", "Observed type", "{0}|abstract={1}|static={2}",
                            "Test", DiagnosticSeverity.Info, isEnabledByDefault: true);
                        output.ReportDiagnostic(Diagnostic.Create(
                            descriptor, Location.None, symbol.ToDisplayString(), symbol.IsAbstract, symbol.IsStatic));
                        var modifier = symbol.IsStatic ? "static " : GENERATE_ABSTRACT ? "abstract " : "";
                        output.AddSource("Target.g.cs",
                            "namespace App { public " + modifier + "partial class Target { " +
                            "public static bool ObservedAbstract => " +
                            (symbol.IsAbstract ? "true" : "false") + "; } }");
                    });
                }
            }
            """;
        var references = CSharpProjectLoader.RuntimeReferences()
            .Concat(new[]
            {
                MetadataReference.CreateFromFile(typeof(IIncrementalGenerator).Assembly.Location),
                MetadataReference.CreateFromFile(typeof(CSharpCompilation).Assembly.Location),
            })
            .GroupBy(reference => reference.Display)
            .Select(group => group.First());
        var compilation = CSharpCompilation.Create(
            "AbstractShapeGenerator_" + Guid.NewGuid().ToString("N"),
            new[] { CSharpSyntaxTree.ParseText(source.Replace("GENERATE_ABSTRACT", generatedAbstract ? "true" : "false", StringComparison.Ordinal)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var image = new MemoryStream();
        var emit = compilation.Emit(image);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));
        File.WriteAllBytes(path, image.ToArray());
    }
}
