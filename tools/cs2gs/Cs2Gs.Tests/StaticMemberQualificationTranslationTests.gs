// <copyright file="StaticMemberQualificationTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Reflection
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.Tests
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis
import System.Threading

/// A C# extension method on a `static class` translates to a top-level
/// receiver-clause `func`, but a private `static` field of that class
/// stays in the class's `shared { }` block. A bare reference to that field
/// from the lifted `func` body has no implicit type scope at top level, so it
/// must be qualified through the owning type (`Ec3Extensions.FfAc3ChannelsTab`),
/// mirroring the bare static-call rule (ADR-0115 §B.18). Without qualification gsc
/// reports GS0125 (name not in scope).
open class StaticMemberQualificationTranslationTests {
    @Fact
    func StaticFieldReferenced_FromLiftedExtensionFunc_IsQualified() {
        let rendered = TranslateAndPrint(ExtensionSource)
        Assert.Contains("Ec3Extensions.FfAc3ChannelsTab", rendered, StringComparison.Ordinal)
    }

    @Fact
    func StaticFieldReferenced_FromSiblingSharedMethod_EmitsBare() {
        // Issue #3471: gsc resolves a bare sibling `shared` member reference
        // from inside the declaring aggregate, so the qualifier is dropped.
        let rendered = TranslateAndPrint(SiblingSource)
        Assert.DoesNotContain("Holder.Tab", rendered, StringComparison.Ordinal)
        Assert.Contains("return Tab", rendered, StringComparison.Ordinal)
    }

    @Fact
    func StaticMemberReferenced_FromGenericSibling_EmitsBare() {
        // Issue #3471: even a generic owner beside a non-generic type of the
        // same simple name (`static class Box` / `class Box<T>`) references its
        // own shared members bare — no qualifier means the old wrong-arity
        // hazard (binding arity-0 `Box` and reporting GS0158) cannot arise.
        let rendered = TranslateAndPrint(GenericSiblingSource)
        Assert.DoesNotContain("Box[T].Tab", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Box.Tab", rendered, StringComparison.Ordinal)
        Assert.Contains("return Tab", rendered, StringComparison.Ordinal)
        Assert.Contains("Read().ToString()", rendered, StringComparison.Ordinal)
    }

    @Fact
    func PrivateHelper_OfExtensionBearingStaticClass_RetainsNativeVisibility() {
        // ExtensionOwner hosts the real body on Helpers, so its private sibling
        // stays accessible without changing the native visibility contract.
        const source = `
namespace Corpus.PrivateHelper
{
    public static class Helpers
    {
        private static void SendOrPost(System.Action work) => work();

        public static void Post(this System.Threading.SynchronizationContext ctx, System.Action work)
            => SendOrPost(work);
    }
}
`
        let rendered = TranslateAndPrint(source)
        Assert.Contains("Helpers.SendOrPost", rendered, StringComparison.Ordinal)
        Assert.Contains("private func SendOrPost", rendered, StringComparison.Ordinal)
        Assert.Contains("ExtensionOwner(typeof(Helpers))", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + `
var calls = 0
Corpus.PrivateHelper.Helpers.Post(System.Threading.SynchronizationContext(), func () { calls++ })
calls`)
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(1, result.Value)
        using let native = CSharpFixture(source)
        for image in[]Assembly{native.Load(), result.Assembly!!} {
            let holder Type? = image.GetType("Corpus.PrivateHelper.Helpers", throwOnError: true)
            Assert.True(holder!!.IsAbstract && holder!!.IsSealed)
            let helper MethodInfo? = holder!!.GetMethod("SendOrPost", BindingFlags.NonPublic | BindingFlags.Static)
            Assert.NotNull(helper)
            Assert.True(helper!!.IsPrivate)
            Assert.Null(holder!!.GetMethod("SendOrPost", BindingFlags.Public | BindingFlags.Static))
            let original MethodInfo? = holder!!.GetMethod("Post", BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(original)
            Assert.Equal(typeof(SynchronizationContext), original!!.GetParameters()[0].ParameterType)
            Assert.Equal(typeof(() -> void), original!!.GetParameters()[1].ParameterType)
        }
    }

    shared {
        private const ExtensionSource string = `
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
`

        private const SiblingSource string = `
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
`

        private const GenericSiblingSource string = `
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
`

        private func TranslateAndPrint(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
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
            return GSharpPrinter.Print(unit)
        }
    }
}
