// <copyright file="GenericStaticReceiverTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// #914: a static member accessed through a constructed generic type
/// (<c>Mp4Operation&lt;ChapterInfo?&gt;.FromCompleted(...)</c>) must keep its
/// type arguments. cs2gs previously rendered the receiver of such an access as a
/// bare identifier (dropping <c>&lt;T&gt;</c>), so the call bound to the
/// non-generic type's overload and failed GS0144. The receiver is now rendered as
/// the constructed generic type <c>T[args]</c>.
/// </summary>
public class GenericStaticReceiverTranslationTests
{
    private const string Source = @"
namespace Corpus.Issue1322
{
    public class Box
    {
        public static Box FromOne(int a) => new Box();
    }

    public class Box<T>
    {
        public static Box<T> FromTwo(int a, T value) => new Box<T>();
    }

    public class Use
    {
        public Box<int> A() => Box<int>.FromTwo(1, 7);

        public Box B() => Box.FromOne(1);
    }
}
";

    [Fact]
    public void StaticCallOnConstructedGenericType_KeepsTypeArguments()
    {
        string rendered = Render();

        // The receiver keeps its type argument: `Box[int32].FromTwo(1, 7)`.
        Assert.Contains("Box[int32].FromTwo(1, 7)", rendered, StringComparison.Ordinal);

        // It must NOT collapse to the non-generic `Box.FromTwo`.
        Assert.DoesNotContain("Box.FromTwo", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void StaticCallOnNonGenericType_Unchanged()
    {
        string rendered = Render();

        Assert.Contains("Box.FromOne(1)", rendered, StringComparison.Ordinal);
    }

    private static string Render()
    {
        (CompilationUnit unit, _) = Translate();
        return GSharpPrinter.Print(unit);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Box.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
