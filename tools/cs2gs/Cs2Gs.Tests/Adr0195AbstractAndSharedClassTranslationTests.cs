// <copyright file="Adr0195AbstractAndSharedClassTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0195 / issue #4674: a C# <c>abstract class</c> and a C# <c>static class</c>
/// keep their CLR shape through migration (<c>abstract class</c> and <c>shared class</c>). The shapes below are the ones the
/// migrated <c>GSharp.Core</c> API diff named: <c>BoundTreeWalker</c> and
/// <c>DocInline</c> (abstract with no abstract member) and
/// <c>IteratorMoveNextBodyBuilder</c> (a static class). Before, abstractness
/// was dropped (an Info diagnostic) and every static class became an
/// ordinary instantiable <c>class</c> whose members sat in a <c>shared { }</c>
/// block; a static class is now a <c>shared class</c> with its members flat.
/// </summary>
public class Adr0195AbstractAndSharedClassTranslationTests
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
";

    [Fact]
    public void AbstractClassWithNoAbstractMember_KeepsAbstractAndStaysInheritable()
    {
        TypeDeclaration walker = Declaration("BoundTreeWalker");

        Assert.True(walker.IsAbstract);
        Assert.False(walker.IsOpen);
        Assert.False(walker.IsShared);
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
        Assert.False(concrete.IsShared);
    }

    [Fact]
    public void StaticClass_IsASharedClass_WithItsMembersFlatInTheBody()
    {
        TypeDeclaration builder = Declaration("IteratorMoveNextBodyBuilder");
        string rendered = GSharpPrinter.Print(Translate());

        Assert.True(builder.IsShared);
        Assert.False(builder.IsOpen);
        Assert.False(builder.IsAbstract);
        Assert.Contains("shared class IteratorMoveNextBodyBuilder", rendered, StringComparison.Ordinal);

        // The class IS the shared member list: no `shared { }` block inside it, and its
        // const, field and method are direct members.
        Assert.DoesNotContain(builder.Members, member => member is SharedBlock);
        Assert.Contains(builder.Members.OfType<MethodDeclaration>(), method => method.Name == "Build");
        Assert.Contains(builder.Members.OfType<FieldDeclaration>(), field => field.Name == "calls");
    }

    [Fact]
    public void EmptyStaticClass_IsKept_AsAnEmptySharedClass()
    {
        // `Marker` is a declared type of the assembly's API; only a static class whose
        // members were all lifted away (extension holders) is elided.
        TypeDeclaration marker = Declaration("Marker");

        Assert.True(marker.IsShared);
        Assert.Empty(marker.Members);
        Assert.Contains("shared class Marker", GSharpPrinter.Print(Translate()), StringComparison.Ordinal);
    }

    [Fact]
    public void StaticClassWithOnlyALiftedNestedDelegate_IsKept()
    {
        // The nested delegate is lifted to a top-level declaration, so the body is empty, but the
        // class is a declared type of the API and not an extension holder.
        TypeDeclaration holder = Declaration("OnlyANestedDelegate");

        Assert.True(holder.IsShared);
        Assert.Contains(
            Translate().Members.OfType<NamedDelegateDeclaration>(),
            lifted => lifted.Name == "OnlyANestedDelegate_Callback");
    }

    [Fact]
    public void NonStaticClass_KeepsItsTrailingSharedBlock()
    {
        TypeDeclaration concrete = Declaration("WithStatics");

        Assert.False(concrete.IsShared);
        Assert.Single(concrete.Members.OfType<SharedBlock>());
        Assert.Contains("shared {", GSharpPrinter.Print(Translate()), StringComparison.Ordinal);
    }

    [Fact]
    public void StaticConstructor_BecomesAFlatStaticInitializerInTheSharedClass()
    {
        TypeDeclaration config = Declaration("Config");

        Assert.True(config.IsShared);
        Assert.Contains(config.Members.OfType<StaticInitializerBlock>(), _ => true);
        Assert.DoesNotContain(config.Members, member => member is SharedBlock);
        Assert.Contains("init {", GSharpPrinter.Print(Translate()), StringComparison.Ordinal);
    }

    [Fact]
    public void NestedStaticClass_IsASharedClassToo()
    {
        TypeDeclaration outer = Declaration("Outer");
        TypeDeclaration inner = outer.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Inner");

        Assert.True(inner.IsShared);
        Assert.False(outer.IsShared);
    }

    [Theory]
    [InlineData("internal class Target { internal int Count; } internal static class Holder { internal static int Size(this Target value) => value.Count; }")]
    [InlineData("internal class Target { internal int Count; } internal static class Holder { internal static int Size(this Target value) => value.Count; } internal class Use { System.Type Get() => typeof(Holder); }")]
    [InlineData("public static class Holder { public static int Size(this string value) => value.Length; }")]
    [InlineData("internal static class Holder {}")]
    [InlineData("internal static class Holder { internal static int One() => 1; }")]
    public void StaticClassMappingDiagnostic_DescribesEveryNativeStaticHolder(string declaration)
    {
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Holder.cs", "namespace Corpus { " + declaration + " }") });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        using var image = new MemoryStream();
        var emit = project.Compilation.Emit(image);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        var unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.IsUnsupported);
        var holders = unit.Members.OfType<TypeDeclaration>().Where(type => type.Name == "Holder").ToArray();
        var diagnostics = context.Diagnostics.Where(diagnostic =>
            diagnostic.ConstructKind == "ClassDeclaration"
            && diagnostic.Message.Contains("static class Holder", StringComparison.Ordinal)).ToArray();

        var holder = Assert.Single(holders);
        Assert.True(holder.IsShared);
        Assert.DoesNotContain(holder.Members, member => member is SharedBlock);
        var diagnostic = Assert.Single(diagnostics);
        Assert.Equal(TranslationSeverity.Info, diagnostic.Severity);
        Assert.Contains("'shared class'", diagnostic.Message, StringComparison.Ordinal);
        Assert.NotNull(diagnostic.Location);
        Assert.Equal(document.FilePath, diagnostic.Location.SourceTree.FilePath);
        if (unit.Members.OfType<TypeDeclaration>().SingleOrDefault(type => type.Name == "Target") is { } target)
        {
            Assert.Single(target.Members.OfType<MethodDeclaration>(), method => method.Name == "Size");
            MethodDeclaration original = Assert.Single(unit.Members.OfType<MethodDeclaration>(),
                method => method.Name == "Size");
            Assert.NotNull(original.Receiver);
            Assert.Contains("ExtensionOwner(typeof(Holder))", GSharpPrinter.Print(unit), StringComparison.Ordinal);
            Assert.Contains("Holder.Size(value)", GSharpPrinter.Print(unit), StringComparison.Ordinal);
        }
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
