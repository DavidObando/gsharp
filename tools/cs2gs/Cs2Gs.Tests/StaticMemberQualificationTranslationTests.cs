// <copyright file="StaticMemberQualificationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.Tests;
using GSharp.Tests;
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
    public void StaticFieldReferenced_FromSiblingSharedMethod_EmitsBare()
    {
        // Issue #3471: gsc resolves a bare sibling `shared` member reference
        // from inside the declaring aggregate, so the qualifier is dropped.
        string rendered = TranslateAndPrint(SiblingSource);

        Assert.DoesNotContain("Holder.Tab", rendered, StringComparison.Ordinal);
        Assert.Contains("return Tab", rendered, StringComparison.Ordinal);
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
    public void StaticMemberReferenced_FromGenericSibling_EmitsBare()
    {
        // Issue #3471: even a generic owner beside a non-generic type of the
        // same simple name (`static class Box` / `class Box<T>`) references its
        // own shared members bare — no qualifier means the old wrong-arity
        // hazard (binding arity-0 `Box` and reporting GS0158) cannot arise.
        string rendered = TranslateAndPrint(GenericSiblingSource);

        Assert.DoesNotContain("Box[T].Tab", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Box.Tab", rendered, StringComparison.Ordinal);
        Assert.Contains("return Tab", rendered, StringComparison.Ordinal);
        Assert.Contains("Read().ToString()", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void PrivateHelper_OfExtensionBearingStaticClass_RetainsNativeVisibility()
    {
        // ExtensionOwner hosts the real body on Helpers, so its private sibling
        // stays accessible without changing the native visibility contract.
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
        Assert.Contains("private func SendOrPost", rendered, StringComparison.Ordinal);
        Assert.Contains("ExtensionOwner(typeof(Helpers))", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
        EmittedOracleResult result = EmittedOracle.Evaluate(rendered + """

            var calls = 0
            Corpus.PrivateHelper.Helpers.Post(System.Threading.SynchronizationContext(), func () { calls++ })
            calls
            """);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1, result.Value);
        using var native = new CSharpFixture(source);
        foreach (Assembly image in new[] { native.Load(), result.Assembly })
        {
            Type holder = image.GetType("Corpus.PrivateHelper.Helpers", throwOnError: true);
            Assert.True(holder.IsAbstract && holder.IsSealed);
            MethodInfo helper = holder.GetMethod("SendOrPost", BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(helper);
            Assert.True(helper.IsPrivate);
            Assert.Null(holder.GetMethod("SendOrPost", BindingFlags.Public | BindingFlags.Static));
            MethodInfo original = holder.GetMethod("Post", BindingFlags.Public | BindingFlags.Static);
            Assert.NotNull(original);
            Assert.Equal(typeof(System.Threading.SynchronizationContext), original.GetParameters()[0].ParameterType);
            Assert.Equal(typeof(Action), original.GetParameters()[1].ParameterType);
        }
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
