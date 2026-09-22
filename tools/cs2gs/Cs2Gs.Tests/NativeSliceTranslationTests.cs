// <copyright file="NativeSliceTranslationTests.cs" company="GSharp">
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

public sealed class NativeSliceTranslationTests
{
    [Theory]
    [InlineData("int slice = 5;", "native[0] + slice + array.Length", 14)]
    [InlineData("int slice(int value) => value + 5;", "slice(native[0]) + array.Length", 14)]
    public void ValueAndFunctionCollisionsQualifyNativeStaticReferences(string declaration, string resultExpression, int expected)
    {
        var source = $$"""
            using Gsharp.Values;
            namespace NativeValueCollisions;
            public class Probe {
                public static int Run() {
                    {{declaration}}
                    int[] array = { 7, 8 };
                    var native = Slice<int>.FromArray(array);
                    return {{resultExpression}};
                }
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Collision.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Gsharp.Values.Slice[int32].FromArray(array)", printed);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);
        var result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Probe.Run()",
            new[] { typeof(Gsharp.Values.Slice<>).Assembly.Location });
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void PrinterSeparatesNativePermissionsArrayIdentityAndNullability()
    {
        var element = new NamedTypeReference("string") { IsNullable = true };
        Assert.Equal("readonly slice[string?]?", GSharpPrinter.RenderTypeReference(new NativeSliceTypeReference(element, true) { IsNullable = true }));
        Assert.Equal("slice[string?]", GSharpPrinter.RenderTypeReference(new NativeSliceTypeReference(element)));
        Assert.Equal("[]?string?", GSharpPrinter.RenderTypeReference(new ArrayTypeReference(element) { IsNullable = true }));
    }

    [Fact]
    public void ShadowedNativeAliasesUseQualifiedRuntimeTypes()
    {
        const string source = """
            using Gsharp.Values;
            namespace ShadowTranslation;
            public class slice<T> { }
            public class Buffers {
                public Slice<int> Native;
                public ReadOnlySlice<int> View;
                public slice<int> Ordinary = new slice<int>();
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Shadow.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Empty(context.Diagnostics);
        Assert.Contains("Native Gsharp.Values.Slice[int32]", printed);
        Assert.Contains("View Gsharp.Values.ReadOnlySlice[int32]", printed);
        Assert.Contains("Ordinary slice[int32]", printed);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);
    }

    [Fact]
    public void MapperRecognizesRuntimeIdentityWithoutRewritingCSharpArrays()
    {
        const string source = """
            #nullable enable
            using Gsharp.Values;
            namespace NativeTranslation;
            public class Buffers {
                public Slice<int> Mutable;
                public ReadOnlySlice<string?>? ReadOnly;
                public int[]? Array;
                public int[] Tail(int[] value) => value[1..];
                public Slice<int> View(Slice<int> value) => value.Subslice(1, value.Length);
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Buffers.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        var text = GSharpPrinter.Print(unit);
        Assert.Contains("Mutable slice[int32]", text);
        Assert.Contains("ReadOnly readonly slice[string?]?", text);
        Assert.Contains("Array []?int32", text);
        Assert.Contains("value[1..]", text);
        Assert.Contains("value.Subslice(1, value.Length)", text);
        Assert.Empty(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(text).Diagnostics);
        Assert.True(TranslationTestValidation.AssertBinds(text).Success);
    }

    [Fact]
    public void NullableNativeSliceCastUsesUnambiguousConversion()
    {
        const string source = """
            using Gsharp.Values;
            namespace NativeTranslation;
            public class Probe {
                public static bool Run() {
                    Slice<string> empty = default;
                    return ((Slice<string>?)empty).HasValue;
                }
                public static Slice<string> RejectNullOwner() => Slice<string>.FromArray(null);
            }
            """;
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(typeof(Gsharp.Values.Slice<>).Assembly.Location),
        };
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) }, references);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Empty(context.Diagnostics);
        Assert.Contains("cast[slice[string]?](empty)", printed, StringComparison.Ordinal);
        Assert.Contains("slice[string].FromArray(default([]string))", printed, StringComparison.Ordinal);
        Assert.True(TranslationTestValidation.AssertBinds(printed).Success);
    }
}
