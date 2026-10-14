// <copyright file="Issue3724CrossProjectVirtualOpennessTranslationTests.cs" company="GSharp">
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

/// Issue #3724: openness was inferred from `CollectSubclassedBaseTypes`,
/// which only walks the CURRENT project's assembly. A base class whose only
/// subclass lives in a referencing project — `src/LanguageServer`'s
/// `DocumentContentService`, derived by `test/LanguageServer.Tests`'s
/// `ThrowingDocumentContentService` — was therefore emitted as a plain
/// (CLR-sealed) `class` whose `virtual` members lost `open`, and
/// the derived project failed to compile with GS0157 on the base clause plus
/// GS0183 on the `override`.
///
/// A C# `virtual`/`abstract` member on a non-sealed type states the
/// inheritance intent outright, so the translator now carries it across the
/// assembly boundary instead of re-deriving it from in-project subclasses.
open class Issue3724CrossProjectVirtualOpennessTranslationTests {
    @Fact
    func VirtualMemberWithoutLocalSubclass_ForcesOpenClass() {
        let service = TranslateType(VirtualWithoutLocalSubclass, "ContentService")
        Assert.True(service.IsOpen)
    }

    @Fact
    func VirtualMemberWithoutLocalSubclass_KeepsOpenOnTheMember() {
        let service = TranslateType(VirtualWithoutLocalSubclass, "ContentService")
        let tryGet = service.Members.OfType[MethodDeclaration]().Single((m MethodDeclaration) -> m.Name == "TryGet")
        Assert.True(tryGet.IsOpen)
    }

    @Fact
    func VirtualMemberWithoutLocalSubclass_RendersOpenClass() {
        let rendered = GSharpPrinter.Print(Translate(VirtualWithoutLocalSubclass))
        Assert.Contains("open class ContentService", rendered, StringComparison.Ordinal)
        Assert.Contains("open func TryGet", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ClassWithoutVirtualMembers_IsOpenOnlyWhenItIsApi() {
        // Issue #4674: openness follows C#'s own inheritability for any type another
        // assembly can reach, so a public non-sealed class with nothing overridable is
        // open (it was widened by `virtual` alone before). A `sealed` class and a
        // non-sealed class that is NOT reachable from another assembly are not.
        Assert.True(TranslateType(VirtualWithoutLocalSubclass, "PlainService").IsOpen)
        Assert.False(TranslateType(VirtualWithoutLocalSubclass, "SealedService").IsOpen)
        Assert.False(TranslateType(VirtualWithoutLocalSubclass, "InternalPlainService").IsOpen)
    }

    shared {
        /// The shape of `DocumentContentService`: a public, non-sealed, concrete
        /// class with a `virtual` method and NO subclass anywhere in its own
        /// assembly.
        private const VirtualWithoutLocalSubclass string = `
namespace Corpus.Issue3724
{
    public class ContentService
    {
        public virtual bool TryGet(string key, out string? content)
        {
            content = key;
            return true;
        }
    }

    public sealed class SealedService
    {
        public bool TryGet(string key) => key.Length > 0;
    }

    public class PlainService
    {
        public bool TryGet(string key) => key.Length > 0;
    }

    internal class InternalPlainService
    {
        public bool TryGet(string key) => key.Length > 0;
    }
}
`

        private func TranslateType(source string, name string) TypeDeclaration -> Translate(source)
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == name)

        private func Translate(source string) CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("ContentService.cs", source)})
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
