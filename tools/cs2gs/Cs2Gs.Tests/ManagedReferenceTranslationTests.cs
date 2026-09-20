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
}
