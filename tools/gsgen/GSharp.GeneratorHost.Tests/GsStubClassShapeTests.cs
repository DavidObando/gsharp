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
    [InlineData("open partial data class Target {}", "", false, false, MethodAttributes.Public, true)]
    [InlineData("open partial data class Target {}", "", false, false, MethodAttributes.Public, false)]
    [InlineData("abstract partial data class Target {}", "", true, false, MethodAttributes.Family, false)]
    [InlineData("open partial data class Target { open func Visit() int32; }", "", true, false, MethodAttributes.Public, false)]
    [InlineData("open class Base {}\nopen partial data class Target : Base {}", "", false, false, MethodAttributes.Public, true)]
    [InlineData("open class Base {}\nopen partial data class Target : Base {}", "", false, false, MethodAttributes.Public, false)]
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
        AssertEmittedShape(gs, expectedAbstract, expectedStatic, expectedConstructorAccess, expectedData: target.IsData);

        var workspace = Directory.CreateTempSubdirectory("gsgen_abstract_shape_").FullName;
        try
        {
            // Compile the generator with Roslyn and explicitly load its DLL; never
            // depend on the test assembly still being C# after self-migration.
            var generatorPath = Path.Combine(workspace, "AbstractShapeGenerator.dll");
            CompileShapeGenerator(generatorPath, generatedAbstract);
            string stub = GsToCSharpProjection.ProjectToCSharp(gs);
            var nativeRun = GeneratorRunner.RunFromAnalyzerPaths(
                stub,
                CSharpProjectLoader.RuntimeReferences(),
                new[] { generatorPath });
            Assert.Empty(nativeRun.Failures);
            var native = BindStub(stub).AddSyntaxTrees(nativeRun.Documents
                .Select(document => CSharpSyntaxTree.ParseText(document.SourceText)));
            using var nativeImage = new MemoryStream();
            var nativeEmit = native.Emit(nativeImage);
            Assert.True(nativeEmit.Success, string.Join("\n", nativeEmit.Diagnostics));
            var result = GeneratorHostRunner.RunFromAnalyzerPaths(
                gs,
                CSharpProjectLoader.RuntimeReferences(),
                new[] { generatorPath });
            Assert.Empty(result.Failures);
            Assert.Empty(result.HostDiagnostics);
            Assert.Empty(result.StubFallbacks);
            var observation = Assert.Single(result.GeneratorDiagnostics, diagnostic => diagnostic.Id == "GSABS001");
            Assert.Equal("GSABS001", observation.Id);
            // Roslyn source symbols report static separately from abstract; the
            // emitted CLR static class still carries both Abstract and Sealed.
            var expectedRoslynAbstract = expectedAbstract && !expectedStatic;
            Assert.Equal($"App.Target|abstract={expectedRoslynAbstract}|static={expectedStatic}", observation.GetMessage());
            var expectedConstructors = expectedStatic ? string.Empty : ConstructorAccessName(expectedConstructorAccess) + "()";
            if (target.IsData && native.GetTypeByMetadataName("App.Target").IsRecord)
            {
                expectedConstructors = string.Join(";", new[] { expectedConstructors, "Protected(Target)" }
                    .OrderBy(signature => signature, StringComparer.Ordinal));
            }
            var constructors = Assert.Single(result.GeneratorDiagnostics, diagnostic => diagnostic.Id == "GSCTOR001");
            Assert.Equal($"App.Target|constructors={expectedConstructors}", constructors.GetMessage());
            var generated = Assert.Single(result.GeneratedGsFiles);

            var combined = new Compilation(trees.Append(
                GsSyntaxTree.Parse(SourceText.From(generated.GSharpSource, generated.HintName + ".gs"))).ToArray())
            {
                IsLibrary = true,
            };
            Assert.DoesNotContain(combined.GlobalScope.Diagnostics.Concat(combined.BoundProgram.Diagnostics), diagnostic => diagnostic.IsError);
            var combinedTarget = Assert.Single(combined.GlobalScope.Structs, type => type.Name == "Target");
            Assert.Equal(target.IsData, combinedTarget.IsData);
            AssertEmittedShape(
                combined,
                expectedAbstract || generatedAbstract,
                expectedStatic,
                generatedAbstract ? MethodAttributes.Family : expectedConstructorAccess,
                expectedRoslynAbstract,
                target.IsData);
            Assert.Equal(expectedAbstract || generatedAbstract, combinedTarget.IsAbstract);
        }
        finally
        {
            Directory.Delete(workspace, recursive: true);
        }
    }

    [Theory]
    [InlineData("open partial class Target[T] { open func Visit(); }", "App.Target`1", true, "Public()")]
    [InlineData("open class Base[T] { open func Visit(); }\nopen partial class Target : Base[int32] {}", "App.Target", true, "Public()")]
    [InlineData("open partial class Target(N int32) { open func Visit(); }", "App.Target", true, "Internal();Public(Int32)")]
    [InlineData("abstract partial class Target(N int32) {}", "App.Target", true, "Protected();Public(Int32)")]
    [InlineData("abstract partial class Target() {}", "App.Target", true, "Public()")]
    [InlineData("open class Base(N int32) {}\nopen partial class Target(N int32) : Base(N) { open func Visit(); }", "App.Target", true, "Public(Int32)")]
    [InlineData("open class Base(N int32) {}\nabstract partial class Target(N int32) : Base(N) {}", "App.Target", true, "Public(Int32)")]
    [InlineData("open class Base(N int32) {}\nabstract partial class Target() : Base(1) {}", "App.Target", true, "Public()")]
    [InlineData("open class Base(N int32) {}\nopen partial class Target : Base(1) { open func Visit(); }", "App.Target", true, "Public()")]
    [InlineData("open class Base(N int32) {}\nabstract partial class Target : Base(1) {}", "App.Target", true, "Protected()")]
    [InlineData("open partial class Target { private init(n int32) {} open func Visit(); }", "App.Target", true, "Private(Int32)")]
    [InlineData("open partial class Target { public init() {} open func Visit(); }", "App.Target", true, "Public()")]
    [InlineData("abstract partial class Target { protected init(n int32) {} }", "App.Target", true, "Protected(Int32)")]
    [InlineData("open partial class Target { public init() {} internal init(n int32) {} open func Visit(); }", "App.Target", true, "Internal(Int32);Public()")]
    [InlineData("open partial class Target[T](Value T) { open func Visit(); }", "App.Target`1", true, "Internal();Public(T)")]
    [InlineData("open partial class Target(N int32) {}", "App.Target", false, "Internal();Public(Int32)")]
    [InlineData("open partial class Target(N int32) { convenience init() { init(1) } open func Visit(); }", "App.Target", true, "Public();Public(Int32)")]
    [InlineData("open class Base(N int32) {}\nopen partial class Target(N int32) : Base(N) { convenience init() { init(1) } open func Visit(); }", "App.Target", true, "Public();Public(Int32)")]
    public void LoadedGenerator_ObservesExactlyTheEmittedConstructorSignaturesAndAccess(
        string declaration,
        string metadataName,
        bool expectedAbstract,
        string expectedConstructors)
    {
        var tree = GsSyntaxTree.Parse(SourceText.From("package App\n" + declaration));
        var gs = new Compilation(tree) { IsLibrary = true };
        Assert.DoesNotContain(gs.GlobalScope.Diagnostics.Concat(gs.BoundProgram.Diagnostics), diagnostic => diagnostic.IsError);
        AssertConstructorContract(gs, metadataName, expectedAbstract, expectedConstructors);
        Assert.DoesNotContain(BindStub(GsToCSharpProjection.ProjectToCSharp(gs)).GetDiagnostics(), diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        var workspace = Directory.CreateTempSubdirectory("gsgen_constructor_shape_").FullName;
        try
        {
            var generatorPath = Path.Combine(workspace, "ConstructorShapeGenerator.dll");
            CompileShapeGenerator(generatorPath, generatedAbstract: false, metadataName);
            var result = GeneratorHostRunner.RunFromAnalyzerPaths(
                gs,
                CSharpProjectLoader.RuntimeReferences(),
                new[] { generatorPath });
            Assert.Empty(result.Failures);
            Assert.Empty(result.HostDiagnostics);
            Assert.Empty(result.StubFallbacks);
            var observation = Assert.Single(result.GeneratorDiagnostics, diagnostic => diagnostic.Id == "GSCTOR001");
            Assert.Equal($"{metadataName}|constructors={expectedConstructors}", observation.GetMessage());
            var generated = Assert.Single(result.GeneratedGsFiles);
            var combined = new Compilation(
                tree,
                GsSyntaxTree.Parse(SourceText.From(generated.GSharpSource, generated.HintName + ".gs")))
            {
                IsLibrary = true,
            };
            Assert.DoesNotContain(combined.GlobalScope.Diagnostics.Concat(combined.BoundProgram.Diagnostics), diagnostic => diagnostic.IsError);
            AssertConstructorContract(combined, metadataName, expectedAbstract, expectedConstructors, checkObservation: true);
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
        bool? observedAbstract = null,
        bool expectedData = false)
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
            var constructors = type.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.Equal(expectedData ? 2 : 1, constructors.Length);
            var constructor = Assert.Single(constructors, candidate => candidate.GetParameters().Length == 0);
            Assert.Equal(expectedConstructorAccess, constructor.Attributes & MethodAttributes.MemberAccessMask);
            if (expectedData)
            {
                var copy = Assert.Single(constructors, candidate => candidate.GetParameters().Length == 1);
                Assert.Equal(type, Assert.Single(copy.GetParameters()).ParameterType);
                Assert.Equal(MethodAttributes.Family, copy.Attributes & MethodAttributes.MemberAccessMask);
            }
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

    private static string ConstructorAccessName(MethodAttributes attributes) => (attributes & MethodAttributes.MemberAccessMask) switch
    {
        MethodAttributes.Public => "Public",
        MethodAttributes.Family => "Protected",
        MethodAttributes.Assembly => "Internal",
        MethodAttributes.Private => "Private",
        _ => throw new InvalidOperationException("Unexpected constructor access: " + attributes),
    };

    private static void AssertConstructorContract(
        Compilation compilation,
        string metadataName,
        bool expectedAbstract,
        string expectedConstructors,
        bool checkObservation = false)
    {
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));
        pe.Position = 0;
        var loadContext = new AssemblyLoadContext("ConstructorShape-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        try
        {
            var type = loadContext.LoadFromStream(pe).GetType(metadataName);
            Assert.NotNull(type);
            Assert.Equal(expectedAbstract, type.IsAbstract);
            Assert.False(type.IsSealed);
            var actualConstructors = string.Join(";", type
                .GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Select(constructor => ConstructorAccessName(constructor.Attributes)
                    + "(" + string.Join(",", constructor.GetParameters().Select(parameter => parameter.ParameterType.Name)) + ")")
                .OrderBy(signature => signature, StringComparer.Ordinal));
            Assert.Equal(expectedConstructors, actualConstructors);
            if (checkObservation)
            {
                var runtimeType = type.IsGenericTypeDefinition
                    ? type.MakeGenericType(Enumerable.Repeat(typeof(int), type.GetGenericArguments().Length).ToArray())
                    : type;
                var property = runtimeType.GetProperty("ObservedConstructors", BindingFlags.Public | BindingFlags.Static);
                Assert.NotNull(property);
                Assert.Equal(expectedConstructors, property.GetValue(null));
            }
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static void CompileShapeGenerator(string path, bool generatedAbstract, string metadataName = "App.Target")
    {
        const string source = """
            using System;
            using System.Linq;
            using Microsoft.CodeAnalysis;

            [Generator]
            public sealed class AbstractShapeGenerator : IIncrementalGenerator
            {
                public void Initialize(IncrementalGeneratorInitializationContext context)
                {
                    context.RegisterSourceOutput(context.CompilationProvider, static (output, compilation) =>
                    {
                        var symbol = compilation.GetTypeByMetadataName("TARGET_METADATA_NAME");
                        if (symbol == null)
                        {
                            throw new System.InvalidOperationException("App.Target was not projected");
                        }

                        var descriptor = new DiagnosticDescriptor(
                            "GSABS001", "Observed type", "{0}|abstract={1}|static={2}",
                            "Test", DiagnosticSeverity.Info, isEnabledByDefault: true);
                        output.ReportDiagnostic(Diagnostic.Create(
                            descriptor, Location.None, symbol.ToDisplayString(), symbol.IsAbstract, symbol.IsStatic));
                        var constructors = string.Join(";", symbol.InstanceConstructors
                            .Select(constructor => constructor.DeclaredAccessibility
                                + "(" + string.Join(",", constructor.Parameters.Select(parameter => parameter.Type.Name)) + ")")
                            .OrderBy(signature => signature, StringComparer.Ordinal));
                        var constructorDescriptor = new DiagnosticDescriptor(
                            "GSCTOR001", "Observed constructors", "{0}|constructors={1}",
                            "Test", DiagnosticSeverity.Info, isEnabledByDefault: true);
                        output.ReportDiagnostic(Diagnostic.Create(
                            constructorDescriptor, Location.None,
                            symbol.ContainingNamespace.ToDisplayString() + "." + symbol.MetadataName, constructors));
                        var modifier = symbol.IsStatic ? "static " : GENERATE_ABSTRACT ? "abstract " : "";
                        var name = symbol.Name + (symbol.TypeParameters.Length == 0
                            ? "" : "<" + string.Join(", ", symbol.TypeParameters.Select(parameter => parameter.Name)) + ">");
                        output.AddSource("Target.g.cs",
                            "namespace App { public " + modifier + "partial " + (symbol.IsRecord ? "record " : "class ") + name + " { " +
                            "public static bool ObservedAbstract => " +
                            (symbol.IsAbstract ? "true" : "false") + "; " +
                            "public static string ObservedConstructors => \"" + constructors + "\"; } }");
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
            new[]
            {
                CSharpSyntaxTree.ParseText(source
                    .Replace("GENERATE_ABSTRACT", generatedAbstract ? "true" : "false", StringComparison.Ordinal)
                    .Replace("TARGET_METADATA_NAME", metadataName, StringComparison.Ordinal)),
            },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var image = new MemoryStream();
        var emit = compilation.Emit(image);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));
        File.WriteAllBytes(path, image.ToArray());
    }
}
