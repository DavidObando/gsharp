// <copyright file="Adr0195AbstractAndStaticClassTranslationTests.cs" company="GSharp">
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
/// ADR-0195 / issue #4674: a C# <c>abstract class</c> and a C# <c>static class</c>
/// keep their CLR shape through migration. The shapes below are the ones the
/// migrated <c>GSharp.Core</c> API diff named: <c>BoundTreeWalker</c> and
/// <c>DocInline</c> (abstract with no abstract member) and
/// <c>IteratorMoveNextBodyBuilder</c> (a static class). Before, abstractness
/// was dropped (an Info diagnostic) and every static class became an
/// ordinary instantiable <c>class</c>.
/// </summary>
public class Adr0195AbstractAndStaticClassTranslationTests
{
    private const string Source = @"
namespace Corpus.Adr0195
{
    public abstract class BoundTreeWalker
    {
        protected virtual void VisitNode(int node) { }

        public void Walk(int node) => VisitNode(node);
    }

    public abstract record DocInline
    {
        public sealed record Text(string Value) : DocInline;
    }

    public abstract class AbstractWithAbstractMember
    {
        public abstract int Size { get; }
    }

    public static class IteratorMoveNextBodyBuilder
    {
        public const int Factor = 3;

        private static int calls;

        public static int Build(int x)
        {
            calls++;
            return x * Factor;
        }
    }

    public class Concrete : BoundTreeWalker
    {
    }
}
";

    [Fact]
    public void AbstractClassWithNoAbstractMember_KeepsAbstractAndStaysInheritable()
    {
        TypeDeclaration walker = Declaration("BoundTreeWalker");

        Assert.True(walker.IsAbstract);
        Assert.False(walker.IsOpen);
        Assert.False(walker.IsStatic);
        Assert.Contains("abstract class BoundTreeWalker", GSharpPrinter.Print(Translate()), StringComparison.Ordinal);
        Assert.DoesNotContain("open abstract", GSharpPrinter.Print(Translate()), StringComparison.Ordinal);
    }

    [Fact]
    public void AbstractRecord_KeepsAbstractDataClass_AndItsSealedCaseStaysClosed()
    {
        TypeDeclaration docInline = Declaration("DocInline");
        TypeDeclaration text = docInline.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Text");

        Assert.Equal(TypeDeclarationKind.DataClass, docInline.Kind);
        Assert.True(docInline.IsAbstract);
        Assert.False(text.IsAbstract);
        Assert.Contains("abstract data class DocInline", GSharpPrinter.Print(Translate()), StringComparison.Ordinal);
    }

    [Fact]
    public void AbstractClassWithAbstractMember_IsAlsoDeclaredAbstract()
    {
        Assert.True(Declaration("AbstractWithAbstractMember").IsAbstract);
    }

    [Fact]
    public void ConcreteSubclass_IsNotAbstract()
    {
        TypeDeclaration concrete = Declaration("Concrete");

        Assert.False(concrete.IsAbstract);
        Assert.False(concrete.IsStatic);
    }

    [Fact]
    public void StaticClass_IsDeclaredStatic_WithItsMembersInASharedBlock()
    {
        TypeDeclaration builder = Declaration("IteratorMoveNextBodyBuilder");
        string rendered = GSharpPrinter.Print(Translate());

        Assert.True(builder.IsStatic);
        Assert.False(builder.IsOpen);
        Assert.False(builder.IsAbstract);
        Assert.Contains("static class IteratorMoveNextBodyBuilder", rendered, StringComparison.Ordinal);
        Assert.Contains("shared {", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void RenderedOutput_ParsesAndRoundTrips()
    {
        string printed = GSharpPrinter.Print(Translate());

        var result = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Inline fixture: only the declaration heads are under test, not a complete bindable program.");

        Assert.True(result.Success, printed);
    }

    private static TypeDeclaration Declaration(string name) =>
        Translate().Members.OfType<TypeDeclaration>().Single(t => t.Name == name);

    private static CompilationUnit Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Adr0195.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }
}
