// <copyright file="Issue2224AnonymousClassHoverCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import Xunit

/// Issue #2224: hover and completion for the new `object { let ... }`
/// anonymous-class-literal expression. gsc synthesizes a real
/// `StructSymbol` per distinct member shape, so hovering a variable bound
/// to a literal, or a member access off it, and completing members after a
/// dot all reuse the existing struct hover/completion machinery
/// ((cref:HoverComputer), (cref:CompletionComputer))
/// unmodified — this is what these tests verify.
open class Issue2224AnonymousClassHoverCompletionTests {
    @Fact
    func ComputeHover_OnAnonymousClassVariable_ShowsSynthesizedShape() {
        const source = "func main() {\n" +
            "    var x = object { let Name string = \"Foo\"; let Age int32 = 42 }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "x"))
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Name", value, StringComparison.Ordinal)
        Assert.Contains("string", value, StringComparison.Ordinal)
        Assert.Contains("Age", value, StringComparison.Ordinal)
        Assert.Contains("int32", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_OnAnonymousClassMemberAccess_ResolvesMemberType() {
        const source = "func main() {\n" +
            "    var x = object { let Name string = \"Foo\"; let Age int32 = 42 }\n" +
            "    var n = x.Name\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Name", occurrence: 1)
        )
        Assert.NotNull(hover)
        Assert.Contains("string", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func ComputeCompletions_AfterDotOnAnonymousClassValue_OffersMembers() {
        const source = "func main() {\n" +
            "    var x = object { let Name string = \"Foo\"; let Age int32 = 42 }\n" +
            "    x.\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let caret = After(source, "    x.")
        let items = CompletionComputer.ComputeCompletions(content, caret)
        // Rubber-duck follow-up to issue #2224: anonymous-class-literal
        // members are get-only auto-properties (PropertyInfo), not plain
        // fields — see AnonymousTypeCache — so completions report Property.
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Name" && i.Kind == CompletionItemKind.Property)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Age" && i.Kind == CompletionItemKind.Property)
    }

    @Fact
    func ComputeCompletions_AfterDotOnAnonymousClassValue_DoesNotOfferGlobalKeywords() {
        const source = "func main() {\n" +
            "    var x = object { let Name string = \"Foo\"; let Age int32 = 42 }\n" +
            "    x.\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let caret = After(source, "    x.")
        let items = CompletionComputer.ComputeCompletions(content, caret)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    shared {
        private func After(source string, marker string) Position {
            let start = LanguageServerTestHelpers.PositionOf(source, marker)
            return Position(start.Line, start.Character + marker.Length)
        }
    }
}
