// <copyright file="Issue4674TypeOpennessTranslationTests.cs" company="GSharp">
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

/// Issue #4674: the migrated `GSharp.Core` must keep the inheritance
/// shape of its public types. G# classes are CLR-sealed unless declared
/// `open`, so a public C# class that is not `sealed` must be emitted
/// `open` even when nothing in the repo derives from it (an analyzer
/// deriving from `SyntaxTree` stops loading otherwise), and a C#
/// `sealed` class must stay non-`open` even when it carries
/// `protected override` members or is a record (whose synthesized
/// `EqualityContract`/`PrintMembers` are `protected`). The type
/// names below mirror the real GSharp.Core types the migrated API diff named.
open class Issue4674TypeOpennessTranslationTests {
    @Theory
    @InlineData("Compilation", true)
    @InlineData("SyntaxToken", true)
    @InlineData("EmitResult", false)
    @InlineData("InternalHelper", false)
    @InlineData("Outer", false)
    @InlineData("PublicOuter", true)
    @InlineData("Lowerer", false)
    @InlineData("FunctionSymbol", false)
    @InlineData("Symbol", true)
    @InlineData("SealedWithNewProtected", true)
    @InlineData("DocInline", true)
    func TopLevelType_IsOpenExactlyWhenCSharpAllowsInheritanceAndItIsApi(name string, expectedOpen bool) {
        let declaration = Translate().Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == name)
        // A C# `abstract` class is inheritable too: it is emitted `open` here, and
        // `abstract` (which implies `open`) once the translator can say that
        // (ADR-0195), so the claim is "inheritable", whichever way it is spelled.
        Assert.Equal(expectedOpen, declaration.IsOpen || declaration.IsAbstract)
    }

    @Theory
    @InlineData("NestedPublic", true)
    @InlineData("NestedProtected", true)
    @InlineData("NestedPrivate", false)
    func NestedType_IsOpenOnlyWhenReachableFromAnotherAssembly(name string, expectedOpen bool) {
        let outer = Translate().Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "PublicOuter")
        let nested = outer.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == name)
        Assert.Equal(expectedOpen, nested.IsOpen)
    }

    @Fact
    func NestedPublicTypeOfInternalType_IsNotOpen() {
        let outer = Translate().Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Outer")
        let nested = outer.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Reachable")
        Assert.False(nested.IsOpen)
    }

    @Fact
    func SealedNestedRecord_IsNotOpen() {
        let docInline = Translate()
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == "DocInline")
        let text = docInline.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Text")
        Assert.Equal(TypeDeclarationKind.DataClass, text.Kind)
        Assert.False(text.IsOpen)
    }

    @Fact
    func Rendered_PublicNonSealedClassIsOpen_AndSealedProtectedOverrideKeepsSealedness() {
        let rendered = GSharpPrinter.Print(Translate())
        Assert.Contains("open class Compilation", rendered, StringComparison.Ordinal)
        Assert.Contains("open class SyntaxToken", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("open class EmitResult", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("open class Lowerer", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("open class FunctionSymbol", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("open data class Text", rendered, StringComparison.Ordinal)
        Assert.Contains("class Lowerer", rendered, StringComparison.Ordinal)
        Assert.Contains("protected override func Rewrite", rendered, StringComparison.Ordinal)
    }

    @Fact
    func MemberOpen_AgreesWithDeclaringTypeOpen() {
        let token = Translate().Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "SyntaxToken")
        Assert.True(token.IsOpen)
        Assert.Contains("open func Describe", GSharpPrinter.Print(Translate()), StringComparison.Ordinal)
    }

    shared {
        private const Source string = `
namespace Corpus.Openness
{
    // Compilation / SyntaxTree / Parser: public, not sealed, no virtual or
    // protected member, no subclass anywhere in the project.
    public class Compilation
    {
        public int Id { get; }
    }

    public class SyntaxToken
    {
        public virtual string Text => "t";
        public virtual string Describe() => Text;
        protected virtual void OnChanged() { }
    }

    public sealed class EmitResult
    {
        public int Id { get; }
    }

    // The same non-sealed shape, but internal: no API, so no openness.
    internal class InternalHelper
    {
        public int Id { get; }
    }

    // A public type nested in an internal one is not reachable either.
    internal class Outer
    {
        public class Reachable { }
    }

    public class PublicOuter
    {
        public class NestedPublic { }
        protected class NestedProtected { }
        private class NestedPrivate { }
    }

    public abstract class BoundTreeRewriter
    {
        protected virtual int Rewrite(int node) => node;
    }

    // Lowerer: sealed, overrides a protected virtual member of its base.
    public sealed class Lowerer : BoundTreeRewriter
    {
        protected override int Rewrite(int node) => node + 1;
    }

    // FunctionSymbol: sealed, overrides a private-protected member.
    public abstract class Symbol
    {
        private protected virtual string Container() => "x";
    }

    public sealed class FunctionSymbol : Symbol
    {
        private protected override string Container() => "y";
    }

    // A sealed class with a NEW protected member cannot be expressed as a
    // non-open G# class (GS0380), so it still maps to open.
    public sealed class SealedWithNewProtected
    {
        protected int Hidden;
    }

    // DocInline: an abstract record with sealed nested records.
    public abstract record DocInline
    {
        public sealed record Text(string Value) : DocInline;
    }

    public interface IShape { }
}
`

        private func Translate() CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Openness.cs", Source)})
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
