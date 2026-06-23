// <copyright file="Issue950ProtectedTranslationTests.cs" company="GSharp">
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
/// Issue #950 (ADR-0115 §B.10): the C#→G# translator maps C# <c>protected</c>
/// to the new G# <c>protected</c> visibility (previously there was no mapping).
/// Because <c>protected</c> members are only meaningful on inheritable types,
/// the translator also forces the containing class to be <c>open</c>.
/// </summary>
public class Issue950ProtectedTranslationTests
{
    private const string Source = @"
namespace Corpus.Issue950
{
    public class Animal
    {
        protected int Age;

        protected int GetAge()
        {
            return Age;
        }
    }
}
";

    [Fact]
    public void ProtectedMembers_MapToProtectedVisibility()
    {
        (CompilationUnit unit, _) = Translate();
        TypeDeclaration animal = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Animal");

        FieldDeclaration age = animal.Members.OfType<FieldDeclaration>().Single(f => f.Name == "Age");
        Assert.Equal(Visibility.Protected, age.Visibility);

        MethodDeclaration getAge = animal.Members.OfType<MethodDeclaration>().Single(m => m.Name == "GetAge");
        Assert.Equal(Visibility.Protected, getAge.Visibility);
    }

    [Fact]
    public void ClassWithProtectedMembers_IsForcedOpen()
    {
        (CompilationUnit unit, _) = Translate();
        TypeDeclaration animal = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Animal");
        Assert.True(animal.IsOpen);
    }

    [Fact]
    public void ProtectedMembers_RenderWithProtectedKeyword()
    {
        (CompilationUnit unit, _) = Translate();
        string rendered = GSharpPrinter.Print(unit);
        Assert.Contains("protected", rendered, StringComparison.Ordinal);
        Assert.Contains("open class Animal", rendered, StringComparison.Ordinal);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Animal.cs", Source) });

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
