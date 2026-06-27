// <copyright file="Issue1212NullableArrayElementTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1212 — cs2gs must distinguish the two array nullability spellings:
/// a C# array of nullable ELEMENTS (<c>T?[]</c>) renders as <c>[]T?</c> (a
/// non-nullable slice whose element type is <c>T?</c>), while a C# nullable
/// ARRAY reference (<c>T[]?</c>) renders as <c>[]?T</c> (the whole slice may be
/// nil). Both must round-trip through gsc.
/// </summary>
public class Issue1212NullableArrayElementTranslationTests
{
    [Fact]
    public void NullableReferenceElementArray_RendersElementNullable()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(object?[] items) { }
    }
}");

        Assert.Contains("F(items []object?)", printed);
    }

    [Fact]
    public void NullableValueElementArray_RendersElementNullable()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(int?[] items) { }
    }
}");

        Assert.Contains("F(items []int32?)", printed);
    }

    [Fact]
    public void NullableReferenceArray_RendersArrayNullable()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(object[]? items) { }
    }
}");

        Assert.Contains("F(items []?object)", printed);
    }

    [Fact]
    public void NullableArrayOfNullableElements_RendersBothMarkers()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public void F(object?[]? items) { }
    }
}");

        Assert.Contains("F(items []?object?)", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
