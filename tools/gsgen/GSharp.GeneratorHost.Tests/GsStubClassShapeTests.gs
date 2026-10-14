// <copyright file="GsStubClassShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.GeneratorHost.Tests.StubTestSupport
import Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.GeneratorHost

/// ADR-0195 / issue #4674: a generator reads the stub through Roslyn, so the CLR shape of
/// a G# `abstract class` and `shared class` has to be the C# one
/// (`INamedTypeSymbol.IsAbstract` / `IsStatic`), or it can produce different
/// output than for the real type.
open class GsStubClassShapeTests {
    @Theory
    @InlineData("open partial class Target { open func Visit() int32; }", "", true, false, MethodAttributes(6), false)
    @InlineData(
        "open class Base { open func Visit() int32; }\nopen partial class Target : Base {}",
        "",
        true,
        false,
        MethodAttributes(6),
        false
    )
    @InlineData(`open class Base { open func Visit() int32; }
open partial class Target : Base { override func Visit() int32 { return 1 } }`, "", false, false, MethodAttributes(
            6
        ), false)
    @InlineData(
        "abstract partial class Target { func Visit() int32 { return 1 } }",
        "",
        true,
        false,
        MethodAttributes(4),
        false
    )
    @InlineData(
        "open partial class Target { func Visit() int32 { return 1 } }",
        "",
        false,
        false,
        MethodAttributes(6),
        false
    )
    @InlineData(
        "shared partial class Target { func Visit() int32 { return 1 } }",
        "",
        true,
        true,
        MethodAttributes(1),
        false
    )
    @InlineData(
        "partial class Target {}",
        "abstract partial class Target { func Visit() int32 { return 1 } }",
        true,
        false,
        MethodAttributes(4),
        false
    )
    @InlineData(
        "open partial class Target {}",
        "open partial class Target { open func Visit() int32; }",
        true,
        false,
        MethodAttributes(6),
        false
    )
    @InlineData("open partial class Target {}", "", false, false, MethodAttributes(6), true)
    @InlineData("open partial data class Target {}", "", false, false, MethodAttributes(6), true)
    @InlineData("open partial data class Target {}", "", false, false, MethodAttributes(6), false)
    @InlineData("abstract partial data class Target {}", "", true, false, MethodAttributes(4), false)
    @InlineData(
        "open partial data class Target { open func Visit() int32; }",
        "",
        true,
        false,
        MethodAttributes(6),
        false
    )
    @InlineData(
        "open class Base {}\nopen partial data class Target : Base {}",
        "",
        false,
        false,
        MethodAttributes(6),
        true
    )
    @InlineData(
        "open class Base {}\nopen partial data class Target : Base {}",
        "",
        false,
        false,
        MethodAttributes(6),
        false
    )
    func LoadedGenerator_ObservesSemanticAbstractness_AndGeneratedPartPreservesEmittedShape(
        declaration string,
        secondPart string,
        expectedAbstract bool,
        expectedStatic bool,
        expectedConstructorAccess MethodAttributes,
        generatedAbstract bool
    ) {
        let sources = []string{declaration, secondPart}
            .Where((source string) -> source.Length > 0)
            .Select((source string) -> ("package App\n" + source))
            .ToArray()
        let trees = sources.Select((source string) -> GsSyntaxTree.Parse(SourceText.From(source))).ToArray()
        let gs = Compilation(trees){IsLibrary = true}
        Assert.DoesNotContain(
            gs.GlobalScope.Diagnostics.Concat(gs.BoundProgram.Diagnostics),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        let target = Assert.Single(gs.GlobalScope.Structs, (type StructSymbol) -> type.Name == "Target")
        Assert.Equal(expectedAbstract, target.IsAbstract)
        AssertEmittedShape(gs, expectedAbstract, expectedStatic, expectedConstructorAccess, expectedData: target.IsData)
        let workspace = Directory.CreateTempSubdirectory("gsgen_abstract_shape_").FullName
        try {
            // Compile the generator with Roslyn and explicitly load its DLL; never
            // depend on the test assembly still being C# after self-migration.
            let generatorPath = Path.Combine(workspace, "AbstractShapeGenerator.dll")
            CompileShapeGenerator(generatorPath, generatedAbstract)
            let stub = GsToCSharpProjection.ProjectToCSharp(gs)
            let nativeRun = GeneratorRunner.RunFromAnalyzerPaths(
                stub,
                CSharpProjectLoader.RuntimeReferences(),
                []string{generatorPath}
            )
            Assert.Empty(nativeRun.Failures)
            let native = BindStub(stub).AddSyntaxTrees(
                nativeRun.Documents.Select(
                    (document GeneratedCsDocument) -> CSharpSyntaxTree.ParseText(document.SourceText)
                )
            )
            using let nativeImage = MemoryStream()
            let nativeEmit = native.Emit(nativeImage)
            Assert.True(nativeEmit.Success, string.Join("\n", nativeEmit.Diagnostics))
            let result = GeneratorHostRunner.RunFromAnalyzerPaths(
                gs,
                CSharpProjectLoader.RuntimeReferences(),
                []string{generatorPath}
            )
            Assert.Empty(result.Failures)
            Assert.Empty(result.HostDiagnostics)
            Assert.Empty(result.StubFallbacks)
            let observation = Assert.Single(
                result.GeneratorDiagnostics,
                (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GSABS001"
            )
            Assert.Equal("GSABS001", observation.Id)
            // Roslyn source symbols report static separately from abstract; the
            // emitted CLR static class still carries both Abstract and Sealed.
            let expectedRoslynAbstract = expectedAbstract && !expectedStatic
            Assert.Equal("App.Target|abstract=$expectedRoslynAbstract|static=$expectedStatic", observation.GetMessage())
            var expectedConstructors = if expectedStatic {
                string.Empty
            } else {
                ConstructorAccessName(expectedConstructorAccess) + "()"
            }
            if target.IsData && native.GetTypeByMetadataName("App.Target")!!.IsRecord {
                expectedConstructors = string.Join(
                    ";",
                    []string{expectedConstructors, "Protected(Target)"}.OrderBy(
                        (signature string) -> signature,
                        StringComparer.Ordinal
                    )
                )
            }
            let constructors = Assert.Single(
                result.GeneratorDiagnostics,
                (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GSCTOR001"
            )
            Assert.Equal("App.Target|constructors=$expectedConstructors", constructors.GetMessage())
            let generated = Assert.Single(result.GeneratedGsFiles)
            let combined = Compilation(
                trees.Append(GsSyntaxTree.Parse(SourceText.From(generated.GSharpSource, generated.HintName + ".gs")))
                    .ToArray()
            ){IsLibrary = true}
            Assert.DoesNotContain(
                combined.GlobalScope.Diagnostics.Concat(combined.BoundProgram.Diagnostics),
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
            )
            let combinedTarget = Assert.Single(
                combined.GlobalScope.Structs,
                (type StructSymbol) -> type.Name == "Target"
            )
            Assert.Equal(target.IsData, combinedTarget.IsData)
            AssertEmittedShape(
                combined,
                expectedAbstract || generatedAbstract,
                expectedStatic,
                if generatedAbstract {
                    MethodAttributes.Family
                } else {
                    expectedConstructorAccess
                },
                expectedRoslynAbstract,
                target.IsData
            )
            Assert.Equal(expectedAbstract || generatedAbstract, combinedTarget.IsAbstract)
        } finally {
            Directory.Delete(workspace, recursive: true)
        }
    }

    @Theory
    @InlineData("open partial class Target[T] { open func Visit(); }", "App.Target`1", true, "Public()")
    @InlineData(
        "open class Base[T] { open func Visit(); }\nopen partial class Target : Base[int32] {}",
        "App.Target",
        true,
        "Public()"
    )
    @InlineData(
        "open partial class Target(N int32) { open func Visit(); }",
        "App.Target",
        true,
        "Internal();Public(Int32)"
    )
    @InlineData("abstract partial class Target(N int32) {}", "App.Target", true, "Protected();Public(Int32)")
    @InlineData("abstract partial class Target() {}", "App.Target", true, "Public()")
    @InlineData(
        "open class Base(N int32) {}\nopen partial class Target(N int32) : Base(N) { open func Visit(); }",
        "App.Target",
        true,
        "Public(Int32)"
    )
    @InlineData(
        "open class Base(N int32) {}\nabstract partial class Target(N int32) : Base(N) {}",
        "App.Target",
        true,
        "Public(Int32)"
    )
    @InlineData(
        "open class Base(N int32) {}\nabstract partial class Target() : Base(1) {}",
        "App.Target",
        true,
        "Public()"
    )
    @InlineData(
        "open class Base(N int32) {}\nopen partial class Target : Base(1) { open func Visit(); }",
        "App.Target",
        true,
        "Public()"
    )
    @InlineData(
        "open class Base(N int32) {}\nabstract partial class Target : Base(1) {}",
        "App.Target",
        true,
        "Protected()"
    )
    @InlineData(
        "open partial class Target { private init(n int32) {} open func Visit(); }",
        "App.Target",
        true,
        "Private(Int32)"
    )
    @InlineData("open partial class Target { public init() {} open func Visit(); }", "App.Target", true, "Public()")
    @InlineData("abstract partial class Target { protected init(n int32) {} }", "App.Target", true, "Protected(Int32)")
    @InlineData(
        "open partial class Target { public init() {} internal init(n int32) {} open func Visit(); }",
        "App.Target",
        true,
        "Internal(Int32);Public()"
    )
    @InlineData(
        "open partial class Target[T](Value T) { open func Visit(); }",
        "App.Target`1",
        true,
        "Internal();Public(T)"
    )
    @InlineData("open partial class Target(N int32) {}", "App.Target", false, "Internal();Public(Int32)")
    @InlineData(
        "open partial class Target(N int32) { convenience init() { init(1) } open func Visit(); }",
        "App.Target",
        true,
        "Public();Public(Int32)"
    )
    @InlineData(`open class Base(N int32) {}
open partial class Target(N int32) : Base(N) { convenience init() { init(1) } open func Visit(); }`, "App.Target", true, "Public();Public(Int32)")
    func LoadedGenerator_ObservesExactlyTheEmittedConstructorSignaturesAndAccess(
        declaration string,
        metadataName string,
        expectedAbstract bool,
        expectedConstructors string
    ) {
        let tree = GsSyntaxTree.Parse(SourceText.From("package App\n" + declaration))
        let gs = Compilation(tree){IsLibrary = true}
        Assert.DoesNotContain(
            gs.GlobalScope.Diagnostics.Concat(gs.BoundProgram.Diagnostics),
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        AssertConstructorContract(gs, metadataName, expectedAbstract, expectedConstructors)
        Assert.DoesNotContain(
            BindStub(GsToCSharpProjection.ProjectToCSharp(gs)).GetDiagnostics(),
            (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Severity == Microsoft
                .CodeAnalysis
                .DiagnosticSeverity
                .Error
        )
        let workspace = Directory.CreateTempSubdirectory("gsgen_constructor_shape_").FullName
        try {
            let generatorPath = Path.Combine(workspace, "ConstructorShapeGenerator.dll")
            CompileShapeGenerator(generatorPath, generatedAbstract: false, metadataName)
            let result = GeneratorHostRunner.RunFromAnalyzerPaths(
                gs,
                CSharpProjectLoader.RuntimeReferences(),
                []string{generatorPath}
            )
            Assert.Empty(result.Failures)
            Assert.Empty(result.HostDiagnostics)
            Assert.Empty(result.StubFallbacks)
            let observation = Assert.Single(
                result.GeneratorDiagnostics,
                (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GSCTOR001"
            )
            Assert.Equal("$metadataName|constructors=$expectedConstructors", observation.GetMessage())
            let generated = Assert.Single(result.GeneratedGsFiles)
            let combined = Compilation(
                tree,
                GsSyntaxTree.Parse(SourceText.From(generated.GSharpSource, generated.HintName + ".gs"))
            ){IsLibrary = true}
            Assert.DoesNotContain(
                combined.GlobalScope.Diagnostics.Concat(combined.BoundProgram.Diagnostics),
                (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
            )
            AssertConstructorContract(
                combined,
                metadataName,
                expectedAbstract,
                expectedConstructors,
                checkObservation: true
            )
        } finally {
            Directory.Delete(workspace, recursive: true)
        }
    }

    @Fact
    func AbstractAndSharedClasses_ReachAGeneratorAsAbstractAndStaticTypes() {
        let stub = StubTestSupport.Project(`
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
`)
        AssertParses(stub)
        let compilation = BindStub(stub)
        Assert.True(compilation.GetTypeByMetadataName("App.Walker")!!.IsAbstract, stub)
        Assert.True(compilation.GetTypeByMetadataName("App.Shape")!!.IsAbstract, stub)
        Assert.False(compilation.GetTypeByMetadataName("App.Walker")!!.IsStatic)
        let helpers = compilation.GetTypeByMetadataName("App.Helpers")!!
        Assert.True(helpers.IsStatic, stub)
        Assert.True(compilation.GetTypeByMetadataName("App.Split")!!.IsStatic, stub)
        let plain = compilation.GetTypeByMetadataName("App.Plain")!!
        Assert.False(plain.IsAbstract)
        Assert.False(plain.IsStatic)
    }

    shared {
        private func AssertEmittedShape(
            compilation Compilation,
            expectedAbstract bool,
            expectedSealed bool,
            expectedConstructorAccess MethodAttributes,
            observedAbstract bool? = nil,
            expectedData bool = false
        ) {
            using let pe = MemoryStream()
            let emit = compilation.Emit(pe)
            Assert.True(emit.Success, string.Join("\n", emit.Diagnostics))
            pe.Position = 0
            let loadContext = AssemblyLoadContext("AbstractShape-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                let assembly = loadContext.LoadFromStream(pe)
                let type = Assert.Single(assembly.GetTypes(), (type Type) -> type.FullName == "App.Target")
                Assert.Equal(expectedAbstract, type.IsAbstract)
                Assert.Equal(expectedSealed, type.IsSealed)
                let constructors = type.GetConstructors(
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                )
                Assert.Equal(
                    if expectedData {
                        2
                    } else {
                        1
                    },
                    constructors.Length
                )
                let constructor = Assert.Single(
                    constructors,
                    (candidate ConstructorInfo) -> candidate.GetParameters().Length == 0
                )
                Assert.Equal(expectedConstructorAccess, constructor.Attributes & MethodAttributes.MemberAccessMask)
                if expectedData {
                    let copy = Assert.Single(
                        constructors,
                        (candidate ConstructorInfo) -> candidate.GetParameters().Length == 1
                    )
                    Assert.Equal(type, Assert.Single(copy.GetParameters()).ParameterType)
                    Assert.Equal(MethodAttributes.Family, copy.Attributes & MethodAttributes.MemberAccessMask)
                }
                if (observedAbstract != nil) {
                    let property PropertyInfo? = type.GetProperty(
                        "ObservedAbstract",
                        BindingFlags.Public | BindingFlags.Static
                    )
                    Assert.NotNull(property)
                    Assert.Equal(observedAbstract, property!!.GetValue(nil))
                }
            } finally {
                loadContext.Unload()
            }
        }

        private func ConstructorAccessName(attributes MethodAttributes) string -> switch (
            attributes & MethodAttributes.MemberAccessMask
        ) {
            case MethodAttributes.Public: "Public"
            case MethodAttributes.Family: "Protected"
            case MethodAttributes.Assembly: "Internal"
            case MethodAttributes.Private: "Private"
            default: throw InvalidOperationException("Unexpected constructor access: " + attributes.ToString())
        }

        private func AssertConstructorContract(
            compilation Compilation,
            metadataName string,
            expectedAbstract bool,
            expectedConstructors string,
            checkObservation bool = false
        ) {
            using let pe = MemoryStream()
            let emit = compilation.Emit(pe)
            Assert.True(emit.Success, string.Join("\n", emit.Diagnostics))
            pe.Position = 0
            let loadContext = AssemblyLoadContext(
                "ConstructorShape-" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
            try {
                let type Type? = loadContext.LoadFromStream(pe).GetType(metadataName)
                Assert.NotNull(type)
                Assert.Equal(expectedAbstract, type!!.IsAbstract)
                Assert.False(type!!.IsSealed)
                let actualConstructors = string.Join(
                    ";",
                    type!!
                        .GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                        .Select(
                        (constructor ConstructorInfo) -> ConstructorAccessName(constructor.Attributes) +
                            "(" +
                            string.Join(
                            ",",
                            constructor.GetParameters().Select(
                                (parameter ParameterInfo) -> parameter.ParameterType.Name
                            )
                        ) +
                            ")"
                    )
                        .OrderBy((signature string) -> signature, StringComparer.Ordinal)
                )
                Assert.Equal(expectedConstructors, actualConstructors)
                if checkObservation {
                    let runtimeType Type? = if type!!.IsGenericTypeDefinition {
                        type!!.MakeGenericType(
                            Enumerable.Repeat(typeof(int32), type!!.GetGenericArguments().Length).ToArray()
                        )
                    } else {
                        type
                    }
                    let property PropertyInfo? = runtimeType!!.GetProperty(
                        "ObservedConstructors",
                        BindingFlags.Public | BindingFlags.Static
                    )
                    Assert.NotNull(property)
                    Assert.Equal(expectedConstructors, property!!.GetValue(nil))
                }
            } finally {
                loadContext.Unload()
            }
        }

        private func CompileShapeGenerator(path string, generatedAbstract bool, metadataName string = "App.Target") {
            const source = `using System;
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
}`
            let references = CSharpProjectLoader
                .RuntimeReferences()
                .Concat(
                []PortableExecutableReference{
                    MetadataReference.CreateFromFile(typeof(IIncrementalGenerator).Assembly.Location),
                    MetadataReference.CreateFromFile(typeof(CSharpCompilation).Assembly.Location)
                }
            )
                .GroupBy((reference MetadataReference) -> reference.Display!!)
                .Select((group IGrouping[string, MetadataReference]) -> group.First())
            let compilation = CSharpCompilation.Create(
                "AbstractShapeGenerator_" + Guid.NewGuid().ToString("N"),
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        source.Replace(
                            "GENERATE_ABSTRACT",
                            if generatedAbstract {
                                "true"
                            } else {
                                "false"
                            },
                            StringComparison.Ordinal
                        )
                            .Replace("TARGET_METADATA_NAME", metadataName, StringComparison.Ordinal)
                    )
                },
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let image = MemoryStream()
            let emit = compilation.Emit(image)
            Assert.True(emit.Success, string.Join("\n", emit.Diagnostics))
            File.WriteAllBytes(path, image.ToArray())
        }
    }
}
