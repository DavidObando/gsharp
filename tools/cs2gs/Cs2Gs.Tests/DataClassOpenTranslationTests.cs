// <copyright file="DataClassOpenTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// A C# <c>record</c> (G# <c>data class</c>) that is subclassed must be declared
/// <c>open</c> in G#; otherwise gsc rejects the derived type with GS0181
/// ("Class '…' is not open"). Mirrors the plain-class openness logic for the
/// <c>DataClass</c> kind.
/// </summary>
public class DataClassOpenTranslationTests
{
    private const string Source = @"
namespace Corpus.DataOpen
{
    public record Message(int Type, string Text);

    public record Message<T>(int Type, string Text, T Custom) : Message(Type, Text);

    public abstract record Shape(int Sides);
}
";

    [Fact]
    public void SubclassedRecord_IsForcedOpen()
    {
        CompilationUnit unit = Translate();
        TypeDeclaration message = unit.Members
            .OfType<TypeDeclaration>()
            .Single(t => t.Name == "Message" && (t.TypeParameters == null || t.TypeParameters.Count == 0));

        Assert.Equal(TypeDeclarationKind.DataClass, message.Kind);
        Assert.True(message.IsOpen);
    }

    [Fact]
    public void AbstractRecord_IsForcedOpen()
    {
        CompilationUnit unit = Translate();
        TypeDeclaration shape = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Shape");

        Assert.Equal(TypeDeclarationKind.DataClass, shape.Kind);
        Assert.True(shape.IsOpen);
    }

    [Fact]
    public void SubclassedRecord_RendersOpenDataClass()
    {
        CompilationUnit unit = Translate();
        string rendered = GSharpPrinter.Print(unit);
        Assert.Contains("open data class Message", rendered, StringComparison.Ordinal);
    }

    private static CompilationUnit Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Message.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }
}
