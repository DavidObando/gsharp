// <copyright file="GenericStaticReceiverTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// #914: a static member accessed through a constructed generic type
/// (`Mp4Operation<ChapterInfo?>.FromCompleted(...)`) must keep its
/// type arguments. cs2gs previously rendered the receiver of such an access as a
/// bare identifier (dropping `<T>`), so the call bound to the
/// non-generic type's overload and failed GS0144. The receiver is now rendered as
/// the constructed generic type `T[args]`.
open class GenericStaticReceiverTranslationTests {
    @Fact
    func StaticCallOnConstructedGenericType_KeepsTypeArguments() {
        let rendered = Render()
        // The receiver keeps its type argument: `Box[int32].FromTwo(1, 7)`.
        Assert.Contains("Box[int32].FromTwo(1, 7)", rendered, StringComparison.Ordinal)
        // It must NOT collapse to the non-generic `Box.FromTwo`.
        Assert.DoesNotContain("Box.FromTwo", rendered, StringComparison.Ordinal)
    }

    @Fact
    func StaticCallOnNonGenericType_Unchanged() {
        let rendered = Render()
        Assert.Contains("Box.FromOne(1)", rendered, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `
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
`

        private func Render() string {
            let (unit, _) = Translate()
            return GSharpPrinter.Print(unit)
        }

        private func Translate()(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Box.cs", Source)})
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
