// <copyright file="NativeSliceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class NativeSliceTranslationTests
{
    [Fact]
    public void PrinterSeparatesNativePermissionsArrayIdentityAndNullability()
    {
        var element = new NamedTypeReference("string") { IsNullable = true };
        Assert.Equal("readonly slice[string?]?", GSharpPrinter.RenderTypeReference(new NativeSliceTypeReference(element, true) { IsNullable = true }));
        Assert.Equal("slice[string?]", GSharpPrinter.RenderTypeReference(new NativeSliceTypeReference(element)));
        Assert.Equal("[]?string?", GSharpPrinter.RenderTypeReference(new ArrayTypeReference(element) { IsNullable = true }));
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
}
