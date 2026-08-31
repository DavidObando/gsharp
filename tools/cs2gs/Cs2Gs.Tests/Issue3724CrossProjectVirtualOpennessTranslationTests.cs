// <copyright file="Issue3724CrossProjectVirtualOpennessTranslationTests.cs" company="GSharp">
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
/// Issue #3724: openness was inferred from <c>CollectSubclassedBaseTypes</c>,
/// which only walks the CURRENT project's assembly. A base class whose only
/// subclass lives in a referencing project — <c>src/LanguageServer</c>'s
/// <c>DocumentContentService</c>, derived by <c>test/LanguageServer.Tests</c>'s
/// <c>ThrowingDocumentContentService</c> — was therefore emitted as a plain
/// (CLR-sealed) <c>class</c> whose <c>virtual</c> members lost <c>open</c>, and
/// the derived project failed to compile with GS0157 on the base clause plus
/// GS0183 on the <c>override</c>.
///
/// A C# <c>virtual</c>/<c>abstract</c> member on a non-sealed type states the
/// inheritance intent outright, so the translator now carries it across the
/// assembly boundary instead of re-deriving it from in-project subclasses.
/// </summary>
public class Issue3724CrossProjectVirtualOpennessTranslationTests
{
    /// <summary>
    /// The shape of <c>DocumentContentService</c>: a public, non-sealed, concrete
    /// class with a <c>virtual</c> method and NO subclass anywhere in its own
    /// assembly.
    /// </summary>
    private const string VirtualWithoutLocalSubclass = @"
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
}
";

    [Fact]
    public void VirtualMemberWithoutLocalSubclass_ForcesOpenClass()
    {
        TypeDeclaration service = TranslateType(VirtualWithoutLocalSubclass, "ContentService");
        Assert.True(service.IsOpen);
    }

    [Fact]
    public void VirtualMemberWithoutLocalSubclass_KeepsOpenOnTheMember()
    {
        TypeDeclaration service = TranslateType(VirtualWithoutLocalSubclass, "ContentService");
        MethodDeclaration tryGet = service.Members.OfType<MethodDeclaration>().Single(m => m.Name == "TryGet");
        Assert.True(tryGet.IsOpen);
    }

    [Fact]
    public void VirtualMemberWithoutLocalSubclass_RendersOpenClass()
    {
        string rendered = GSharpPrinter.Print(Translate(VirtualWithoutLocalSubclass));
        Assert.Contains("open class ContentService", rendered, StringComparison.Ordinal);
        Assert.Contains("open func TryGet", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ClassWithoutVirtualMembers_StaysClosed()
    {
        // The rule keys off declared inheritance intent, not visibility: a class
        // with nothing overridable must not be widened.
        Assert.False(TranslateType(VirtualWithoutLocalSubclass, "PlainService").IsOpen);
        Assert.False(TranslateType(VirtualWithoutLocalSubclass, "SealedService").IsOpen);
    }

    private static TypeDeclaration TranslateType(string source, string name) =>
        Translate(source).Members.OfType<TypeDeclaration>().Single(t => t.Name == name);

    private static CompilationUnit Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ContentService.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }
}
