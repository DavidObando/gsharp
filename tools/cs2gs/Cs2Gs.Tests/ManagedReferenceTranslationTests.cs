// <copyright file="ManagedReferenceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class ManagedReferenceTranslationTests
{
    [Fact]
    public void DefaultInitializedManagedReferenceArraysUseNullableElements()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayTranslation;
            public class Probe {
                public static int Run() {
                    int[] values = { 3, 4 };
                    var retained = new ManagedRef<int>[2];
                    retained[0] = ManagedRef<int>.FromArray(values, 0);
                    var retainedAlias = retained;
                    var readOnly = new ReadOnlyManagedRef<int>[2];
                    readOnly[1] = ReadOnlyManagedRef<int>.FromArray(values, 1);
                    return retainedAlias[0].Borrow() + readOnly[1].Borrow();
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrays.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("let retained = [2]managed[int32]?", text);
        Assert.Contains("let readOnly = [2]readonly managed[int32]?", text);
        Assert.Contains("retainedAlias[0]!!.Borrow()", text);
        Assert.Contains("readOnly[1]!!.Borrow()", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ManagedReferenceArraysUseNullableElementsAcrossStorageShapes()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayShapes;
            public class Probe {
                private static ManagedRef<int>[] field = new ManagedRef<int>[1];

                public static ManagedRef<int>[] Create() => new ManagedRef<int>[1];
                private static int Read(ManagedRef<int>[] items) => items[0].Borrow();
                private static int ReadRectangular(ReadOnlyManagedRef<int>[,] items) => items[0, 0].Borrow();

                public static int Run() {
                    int[] values = { 3, 4 };
                    field[0] = ManagedRef<int>.FromArray(values, 0);

                    ManagedRef<int>[] assigned;
                    assigned = new ManagedRef<int>[1];
                    assigned[0] = ManagedRef<int>.FromArray(values, 1);

                    var returned = Create();
                    returned[0] = ManagedRef<int>.FromArray(values, 0);

                    var rectangular = new ReadOnlyManagedRef<int>[1, 1];
                    rectangular[0, 0] = ReadOnlyManagedRef<int>.FromArray(values, 1);

                    return Read(field)
                        + Read(assigned)
                        + Read(returned)
                        + ReadRectangular(rectangular);
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayShapes.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("[1]managed[int32]?", text);
        Assert.Contains("func Create() []managed[int32]?", text);
        Assert.Contains("[1, 1]readonly managed[int32]?", text);
        Assert.Contains("items[0]!!.Borrow()", text);
        Assert.Contains("items[0, 0]!!.Borrow()", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayInitializersPreserveNilElements()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayInitializers;
            public class Probe {
                public static int Run() {
                    var source = new ManagedRef<int>[1];
                    var vector = new ManagedRef<int>[] { source[0] };
                    var implicitVector = new[] { source[0] };
                    var rectangular = new ManagedRef<int>[1, 1] { { source[0] } };
                    ManagedRef<int>[] collection = [source[0]];
                    return vector[0] == null
                        && implicitVector[0] == null
                        && rectangular[0, 0] == null
                        && collection[0] == null ? 42 : 0;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayInitializers.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.True(!text.Contains("source[0]!!", StringComparison.Ordinal), text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ManagedReferenceArrayForEachBindingsRemainNullable()
    {
        const string source = """
            using Gsharp.Values;
            namespace ManagedArrayForEach;
            public class Probe {
                public static int Run() {
                    int[] values = { 3, 4 };
                    var source = new ManagedRef<int>[2];
                    source[0] = ManagedRef<int>.FromArray(values, 0);
                    source[1] = ManagedRef<int>.FromArray(values, 1);
                    int total = 0;
                    foreach (var inferred in source) {
                        total += inferred.Borrow();
                    }
                    foreach (ManagedRef<int> explicitItem in source) {
                        total += explicitItem.Borrow();
                    }
                    return total;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedArrayForEach.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.True(text.Contains("inferred!!.Borrow()", StringComparison.Ordinal), text);
        Assert.True(text.Contains("explicitItem!!.Borrow()", StringComparison.Ordinal), text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(14, result.Value);
    }

    [Theory]
    [InlineData("int managed = 1;", "managed", 4)]
    [InlineData("int managed() => 2;", "managed()", 5)]
    public void AllSymbolCollisionsQualifyRuntimeSpelling(string declaration, string value, int expected)
    {
        var source = $$"""
            using Gsharp.Values;
            namespace ManagedTranslation;
            public class Probe {
                public static int Run() {
                    {{declaration}}
                    int[] values = { 3 };
                    var p = ManagedRef<int>.FromArray(values, 0);
                    return p.Borrow() + {{value}};
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Managed.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Gsharp.Values.ManagedRef[int32].FromArray", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Theory]
    [InlineData("", "0", "readonly managed[int32].FromArray", 3)]
    [InlineData("int managed = 1;", "managed", "Gsharp.Values.ReadOnlyManagedRef[int32].FromArray", 4)]
    [InlineData("int @readonly = 2;", "@readonly", "Gsharp.Values.ReadOnlyManagedRef[int32].FromArray", 5)]
    [InlineData("int readonlyManaged(int value) => value + 1;", "readonlyManaged(3)", "readonly managed[int32].FromArray", 7)]
    public void ReadonlyStaticReceiverMappingPreservesContextualCollisions(string declaration, string value, string spelling, int expected)
    {
        var source = $$"""
            #nullable enable
            using Gsharp.Values;
            namespace ReadonlyTranslation;
            public class Probe {
                public static ReadOnlyManagedRef<T> Identity<T>(ReadOnlyManagedRef<T> value) => value;
                public static ReadOnlyManagedRef<string?>? Empty() => null;
                public static int Run() {
                    {{declaration}}
                    int[] values = { 3 };
                    var p = Identity(ReadOnlyManagedRef<int>.FromArray(values, 0));
                    return p.Borrow() + {{value}};
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Readonly.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(spelling, text);
        Assert.Contains("readonly managed[T]", text);
        Assert.Contains("readonly managed[string?]?", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Theory]
    [InlineData("managed", "Gsharp.Values.ReadOnlyManagedRef[int32]")]
    [InlineData("readonly", "Gsharp.Values.ReadOnlyManagedRef[int32]")]
    [InlineData("readonlyManaged", "readonly managed[int32]")]
    public void OrdinaryContextualTypeNamesKeepTheirTranslatedIdentity(string name, string handleType)
    {
        var source = $$"""
            using Gsharp.Values;
            namespace OrdinaryTypeTranslation;
            public class @{{name}}<T> { public T Value; }
            public class Probe {
                public static int Run() {
                    var ordinary = new @{{name}}<int> { Value = 4 };
                    var p = ReadOnlyManagedRef<int>.FromArray(new[] { 3 }, 0);
                    return p.Borrow() + ordinary.Value;
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Names.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains(handleType + ".FromArray", text);
        var result = EmittedOracle.Evaluate(text + "\nProbe.Run()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void StructuredCodeModelRetainsLocationAndPermission(bool readOnly)
    {
        var element = new NamedTypeReference("string") { IsNullable = true };
        var type = new ManagedReferenceTypeReference(element, readOnly) { IsNullable = true };
        Assert.Equal((readOnly ? "readonly " : string.Empty) + "managed[string?]?", GSharpPrinter.RenderTypeReference(type));
        var unit = new CompilationUnit(
            "ManagedModel",
            members: new GNode[]
            {
                new MethodDeclaration(
                    "Run",
                    returnType: new NamedTypeReference("int32"),
                    body: new BlockStatement(new GStatement[]
                    {
                        new LocalDeclarationStatement(BindingKind.Var, "value", initializer: LiteralExpression.Int("3")),
                        new LocalDeclarationStatement(
                            BindingKind.Let, "p", new ManagedReferenceTypeReference(new NamedTypeReference("int32"), readOnly),
                            new ManagedReferenceExpression(new IdentifierExpression("value"), readOnly)),
                        new ExpressionStatement(new AssignmentExpression(new IdentifierExpression("value"), LiteralExpression.Int("7"))),
                        new ReturnStatement(new UnaryExpression("*", new IdentifierExpression("p"))),
                    })),
            });
        var text = GSharpPrinter.Print(unit);
        Assert.Contains((readOnly ? "readonly " : string.Empty) + "managed(value)", text);
        var result = EmittedOracle.Evaluate(text + "\nRun()", new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NullableManagedReferenceCastUsesIntrinsicSyntax()
    {
        const string source = """
            #nullable enable
            using Gsharp.Values;
            namespace ManagedCastTranslation;
            public class Probe {
                public static ManagedRef<int>? Lift(ManagedRef<int> value) =>
                    (ManagedRef<int>?)value;
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.ManagedRef<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("ManagedCast.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("cast[managed[int32]?](value)", text);
        var result = EmittedOracle.Evaluate(text, new[] { typeof(Gsharp.Values.ManagedRef<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
    }
}
