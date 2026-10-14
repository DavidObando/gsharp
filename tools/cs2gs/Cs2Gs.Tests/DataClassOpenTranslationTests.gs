// <copyright file="DataClassOpenTranslationTests.cs" company="GSharp">
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

/// A C# `record` (G# `data class`) that is subclassed must be declared
/// `open` in G#; otherwise gsc rejects the derived type with GS0181
/// ("Class '…' is not open"). Mirrors the plain-class openness logic for the
/// `DataClass` kind.
open class DataClassOpenTranslationTests {
    @Fact
    func SubclassedRecord_IsForcedOpen() {
        let unit = Translate()
        let message = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single(
            (t TypeDeclaration) -> t.Name == "Message" && (t.TypeParameters == nil || t.TypeParameters!!.Count == 0)
        )
        Assert.Equal(TypeDeclarationKind.DataClass, message.Kind)
        Assert.True(message.IsOpen)
    }

    @Fact
    func AbstractRecord_IsDeclaredAbstract_WhichImpliesOpen() {
        let unit = Translate()
        let shape = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Shape")
        // ADR-0195 / issue #4674: `abstract data class` is inheritable on its own.
        Assert.Equal(TypeDeclarationKind.DataClass, shape.Kind)
        Assert.True(shape.IsAbstract)
        Assert.False(shape.IsOpen)
    }

    @Fact
    func SubclassedRecord_RendersOpenDataClass() {
        let unit = Translate()
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("open data class Message", rendered, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `
namespace Corpus.DataOpen
{
    public record Message(int Type, string Text);

    public record Message<T>(int Type, string Text, T Custom) : Message(Type, Text);

    public abstract record Shape(int Sides);
}
`

        private func Translate() CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Message.cs", Source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return CSharpToGSharpTranslator().TranslateDocument(document, context)
        }
    }
}
