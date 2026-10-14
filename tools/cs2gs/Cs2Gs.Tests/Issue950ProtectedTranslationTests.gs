// <copyright file="Issue950ProtectedTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #950 (ADR-0115 §B.10): the C#→G# translator maps C# `protected`
/// to the new G# `protected` visibility (previously there was no mapping).
/// Because `protected` members are only meaningful on inheritable types,
/// the translator also forces the containing class to be `open`.
open class Issue950ProtectedTranslationTests {
    @Fact
    func ProtectedMembers_MapToProtectedVisibility() {
        let (unit, _) = Translate()
        let animal = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Animal")
        let age = animal.Members.OfType[FieldDeclaration]().Single((f FieldDeclaration) -> f.Name == "Age")
        Assert.Equal(Visibility.Protected, age.Visibility)
        let getAge = animal.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "GetAge")
        Assert.Equal(Visibility.Protected, getAge.Visibility)
    }

    @Fact
    func ClassWithProtectedMembers_IsForcedOpen() {
        let (unit, _) = Translate()
        let animal = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Animal")
        Assert.True(animal.IsOpen)
    }

    @Fact
    func ProtectedMembers_RenderWithProtectedKeyword() {
        let (unit, _) = Translate()
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("protected", rendered, StringComparison.Ordinal)
        Assert.Contains("open class Animal", rendered, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `
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
`

        private func Translate()(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Animal.cs", Source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }
    }
}
