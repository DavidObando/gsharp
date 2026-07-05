// <copyright file="StaticMemberQualificationTranslationTests.cs" company="GSharp">
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
/// A C# extension method on a <c>static class</c> translates to a top-level
/// receiver-clause <c>func</c>, but a private <c>static</c> field of that class
/// stays in the class's <c>shared { }</c> block. A bare reference to that field
/// from the lifted <c>func</c> body has no implicit type scope at top level, so it
/// must be qualified through the owning type (<c>Ec3Extensions.FfAc3ChannelsTab</c>),
/// mirroring the bare static-call rule (ADR-0115 §B.18). Without qualification gsc
/// reports GS0125 (name not in scope).
/// </summary>
public class StaticMemberQualificationTranslationTests
{
    private const string ExtensionSource = @"
namespace Corpus.StaticMember
{
    public struct Sub
    {
        public byte Acmod { get; init; }
    }

    public static class Ec3Extensions
    {
        private static readonly byte[] FfAc3ChannelsTab = [2, 1, 2, 3];

        public static int ChannelCount(this Sub indSub)
            => FfAc3ChannelsTab[(byte)indSub.Acmod];
    }
}
";

    [Fact]
    public void StaticFieldReferenced_FromLiftedExtensionFunc_IsQualified()
    {
        string rendered = TranslateAndPrint(ExtensionSource);

        Assert.Contains("Ec3Extensions.FfAc3ChannelsTab", rendered, StringComparison.Ordinal);
    }

    private const string SiblingSource = @"
namespace Corpus.StaticMember
{
    public class Holder
    {
        private static readonly int Tab = 5;

        public static int Read()
        {
            return Tab;
        }
    }
}
";

    [Fact]
    public void StaticFieldReferenced_FromSiblingSharedMethod_IsQualified()
    {
        string rendered = TranslateAndPrint(SiblingSource);

        Assert.Contains("Holder.Tab", rendered, StringComparison.Ordinal);
    }

    private const string GenericSiblingSource = @"
namespace Corpus.StaticMember
{
    public static class Box
    {
        public static int Helper() => 0;
    }

    public class Box<T>
    {
        private static int Tab = 5;

        public static int Read()
        {
            return Tab;
        }

        public static string Mkr() => Read().ToString();
    }
}
";

    [Fact]
    public void StaticMemberReferenced_FromGenericSibling_IsQualifiedWithTypeArguments()
    {
        // A generic owner (`Box<T>`) that lives beside a non-generic type of the
        // same simple name (`static class Box`) must be qualified with its type
        // arguments (`Box[T].Tab` / `Box[T].Read()`), not the bare arity-0 name —
        // otherwise gsc binds the wrong (non-generic) type and reports GS0158.
        string rendered = TranslateAndPrint(GenericSiblingSource);

        Assert.Contains("Box[T].Tab", rendered, StringComparison.Ordinal);
        Assert.Contains("Box[T].Read()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Box.Tab", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void PrivateHelper_OfExtensionBearingStaticClass_IsWidenedForLiftedCallers()
    {
        // A `private` non-extension member of a `static class` that also declares
        // extension methods becomes unreachable once those extension methods are
        // lifted to top-level `func`s: the lifted func qualifies the sibling call
        // through the owning type (`Helpers.SendOrPost`), and G# accessibility then
        // rejects the class-private member (GS0472). The private modifier must be
        // dropped so the qualified reference still binds.
        const string source = @"
namespace Corpus.PrivateHelper
{
    public static class Helpers
    {
        private static void SendOrPost(System.Action work) => work();

        public static void Post(this System.Threading.SynchronizationContext ctx, System.Action work)
            => SendOrPost(work);
    }
}
";
        string rendered = TranslateAndPrint(source);

        Assert.Contains("Helpers.SendOrPost", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("private func SendOrPost", rendered, StringComparison.Ordinal);
    }

    private static string TranslateAndPrint(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
