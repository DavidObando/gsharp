// <copyright file="Adr0195AbstractAndSharedClassTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import Xunit

/// ADR-0195 / issue #4674: a C# `abstract class` and a C# `static class`
/// keep their CLR shape through migration (`abstract class` and `shared class`). The shapes below are
/// the ones the
/// migrated `GSharp.Core` API diff named: `BoundTreeWalker` and
/// `DocInline` (abstract with no abstract member) and
/// `IteratorMoveNextBodyBuilder` (a static class). Before, abstractness
/// was dropped (an Info diagnostic) and every static class became an
/// ordinary instantiable `class` whose members sat in a `shared { }`
/// block; a static class is now a `shared class` with its members flat.
open class Adr0195AbstractAndSharedClassTranslationTests {
    @Fact
    func AbstractClassWithNoAbstractMember_KeepsAbstractAndStaysInheritable() {
        let walker = Adr0195AbstractAndSharedClassTranslationTests.Declaration("BoundTreeWalker")
        Assert.True(walker.IsAbstract)
        Assert.False(walker.IsOpen)
        Assert.False(walker.IsShared)
        Assert.Contains("abstract class BoundTreeWalker", GSharpPrinter.Print(Translate()), StringComparison.Ordinal)
        Assert.DoesNotContain("open abstract", GSharpPrinter.Print(Translate()), StringComparison.Ordinal)
    }

    @Fact
    func AbstractRecord_KeepsAbstractDataClass_AndItsSealedCaseStaysClosed() {
        let docInline = Adr0195AbstractAndSharedClassTranslationTests.Declaration("DocInline")
        let text = docInline.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Text")
        Assert.Equal(TypeDeclarationKind.DataClass, docInline.Kind)
        Assert.True(docInline.IsAbstract)
        Assert.False(text.IsAbstract)
        Assert.Contains("abstract data class DocInline", GSharpPrinter.Print(Translate()), StringComparison.Ordinal)
    }

    @Fact
    func AbstractClassWithAbstractMember_IsAlsoDeclaredAbstract() {
        Assert.True(Adr0195AbstractAndSharedClassTranslationTests.Declaration("AbstractWithAbstractMember").IsAbstract)
    }

    @Fact
    func ConcreteSubclass_IsNotAbstract() {
        let concrete = Adr0195AbstractAndSharedClassTranslationTests.Declaration("Concrete")
        Assert.False(concrete.IsAbstract)
        Assert.False(concrete.IsShared)
    }

    @Fact
    func StaticClass_IsASharedClass_WithItsMembersFlatInTheBody() {
        let builder = Adr0195AbstractAndSharedClassTranslationTests.Declaration("IteratorMoveNextBodyBuilder")
        let rendered = GSharpPrinter.Print(Translate())
        Assert.True(builder.IsShared)
        Assert.False(builder.IsOpen)
        Assert.False(builder.IsAbstract)
        Assert.Contains("shared class IteratorMoveNextBodyBuilder", rendered, StringComparison.Ordinal)
        // The class IS the shared member list: no `shared { }` block inside it, and its
        // const, field and method are direct members.
        Assert.DoesNotContain(builder.Members, (member GMember) -> member is SharedBlock)
        Assert.Contains(
            builder.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Build"
        )
        Assert.Contains(builder.Members.OfType[FieldDeclaration](), (field FieldDeclaration) -> field.Name == "calls")
    }

    @Fact
    func EmptyStaticClass_IsKept_AsAnEmptySharedClass() {
        // `Marker` is a declared type of the assembly's API; only a static class whose
        // members were all lifted away (extension holders) is elided.
        let marker = Adr0195AbstractAndSharedClassTranslationTests.Declaration("Marker")
        Assert.True(marker.IsShared)
        Assert.Empty(marker.Members)
        Assert.Contains("shared class Marker", GSharpPrinter.Print(Translate()), StringComparison.Ordinal)
    }

    @Fact
    func StaticClassWithOnlyALiftedNestedDelegate_IsKept() {
        // The nested delegate is lifted to a top-level declaration, so the body is empty, but the
        // class is a declared type of the API and not an extension holder.
        let holder = Adr0195AbstractAndSharedClassTranslationTests.Declaration("OnlyANestedDelegate")
        Assert.True(holder.IsShared)
        Assert.Contains(
            Translate().Members.OfType[NamedDelegateDeclaration](),
            (lifted NamedDelegateDeclaration) -> lifted.Name == "OnlyANestedDelegate_Callback"
        )
    }

    @Fact
    func NonStaticClass_KeepsItsTrailingSharedBlock() {
        let concrete = Adr0195AbstractAndSharedClassTranslationTests.Declaration("WithStatics")
        Assert.False(concrete.IsShared)
        Assert.Single(concrete.Members.OfType[SharedBlock]())
        Assert.Contains("shared {", GSharpPrinter.Print(Translate()), StringComparison.Ordinal)
    }

    @Fact
    func StaticConstructor_BecomesAFlatStaticInitializerInTheSharedClass() {
        let config = Adr0195AbstractAndSharedClassTranslationTests.Declaration("Config")
        Assert.True(config.IsShared)
        Assert.Contains(config.Members.OfType[StaticInitializerBlock](), (_ StaticInitializerBlock) -> true)
        Assert.DoesNotContain(config.Members, (member GMember) -> member is SharedBlock)
        Assert.Contains("init {", GSharpPrinter.Print(Translate()), StringComparison.Ordinal)
    }

    @Fact
    func NestedStaticClass_IsASharedClassToo() {
        let outer = Adr0195AbstractAndSharedClassTranslationTests.Declaration("Outer")
        let inner = outer.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Inner")
        Assert.True(inner.IsShared)
        Assert.False(outer.IsShared)
    }

    @Theory
    @InlineData(
        "internal class Target { internal int Count; } internal static class Holder { internal static int Size(this Target value) => value.Count; }"
    )
    @InlineData(
        "internal class Target { internal int Count; } internal static class Holder { internal static int Size(this Target value) => value.Count; } internal class Use { System.Type Get() => typeof(Holder); }"
    )
    @InlineData("public static class Holder { public static int Size(this string value) => value.Length; }")
    @InlineData("internal static class Holder {}")
    @InlineData("internal static class Holder { internal static int One() => 1; }")
    func StaticClassMappingDiagnostic_DescribesEveryNativeStaticHolder(declaration string) {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Holder.cs", "namespace Corpus { " + declaration + " }")}
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        using let image = MemoryStream()
        let emit = project.Compilation.Emit(image)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(context.Diagnostics, (diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        let holders = unit
            .Members
            .OfType[TypeDeclaration]()
            .Where((type TypeDeclaration) -> type.Name == "Holder")
            .ToArray()
        let diagnostics = context
            .Diagnostics
            .Where(
            (diagnostic TranslationDiagnostic) -> diagnostic.ConstructKind == "ClassDeclaration" &&
                diagnostic.Message!!.Contains("static class Holder", StringComparison.Ordinal)
        )
            .ToArray()
        let holder = Assert.Single(holders)
        Assert.True(holder.IsShared)
        Assert.DoesNotContain(holder.Members, (member GMember) -> member is SharedBlock)
        if unit
            .Members
            .OfType[TypeDeclaration]()
            .SingleOrDefault((type TypeDeclaration) -> type.Name == "Target") is {} target {
            Assert.DoesNotContain(
                target.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == "Size"
            )
            let original = Assert.Single(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == "Size"
            )
            Assert.NotNull(original.Receiver)
            Assert.Contains("ExtensionOwner(typeof(Holder))", GSharpPrinter.Print(unit), StringComparison.Ordinal)
        }
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal(TranslationSeverity.Info, diagnostic.Severity)
        Assert.Contains("'shared class'", diagnostic.Message, StringComparison.Ordinal)
        Assert.NotNull(diagnostic.Location)
        Assert.Equal(document.FilePath, diagnostic.Location!!.SourceTree!!.FilePath)
    }

    @Fact
    func RenderedOutput_ParsesAndRoundTrips() {
        let printed = GSharpPrinter.Print(Translate())
        let result = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Inline fixture: only the declaration heads are under test, not a complete bindable program."
        )
        Assert.True(result.Success, printed)
    }

    shared {
        private const Source string = `
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

    public static class Marker
    {
    }

    public static class OnlyANestedDelegate
    {
        public delegate void Callback(int value);
    }

    public class WithStatics
    {
        public static int Count;

        public int Instance;
    }

    public static class Config
    {
        public static int Value;

        static Config()
        {
            for (int i = 0; i < 3; i++)
            {
                Value += i;
            }
        }
    }

    public class Outer
    {
        public static class Inner
        {
            public static int One() => 1;
        }
    }
}
`

        private func Declaration(name string) TypeDeclaration -> Translate()
            .Members
            .OfType[TypeDeclaration]()
            .Single((t TypeDeclaration) -> t.Name == name)

        private func Translate() CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Adr0195.cs", Source)})
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
