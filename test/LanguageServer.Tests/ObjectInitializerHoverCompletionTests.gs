// <copyright file="ObjectInitializerHoverCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Linq
import Xunit

/// Issue #897: hover and completion inside C#-style object-initializer blocks
/// (`T(args) { Prop = v }`) — the property names resolve against the
/// constructed type for both imported CLR types and user-defined G# classes.
open class ObjectInitializerHoverCompletionTests {
    @Fact
    func ComputeHover_OnClrInitializerProperty_ResolvesAgainstConstructedType() {
        const source = "import System.Diagnostics\n" +
            "func main() {\n" +
            "    let psi = ProcessStartInfo(\"dotnet\") {\n" +
            "        RedirectStandardOutput = true,\n" +
            "        UseShellExecute = false\n" +
            "    }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "RedirectStandardOutput")
        )
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("System.Diagnostics.ProcessStartInfo.RedirectStandardOutput", value, StringComparison.Ordinal)
        Assert.Contains("bool", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeHover_OnSecondClrInitializerProperty_Resolves() {
        const source = "import System.Diagnostics\n" +
            "func main() {\n" +
            "    let psi = ProcessStartInfo(\"dotnet\") {\n" +
            "        RedirectStandardOutput = true,\n" +
            "        UseShellExecute = false\n" +
            "    }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "UseShellExecute")
        )
        Assert.NotNull(hover)
        Assert.Contains(
            "System.Diagnostics.ProcessStartInfo.UseShellExecute",
            hover!!.Contents.ToString(),
            StringComparison.Ordinal
        )
    }

    @Fact
    func ComputeHover_OnGSharpClassInitializerProperty_ResolvesToPropertySymbol() {
        const source = "class Box {\n" +
            "    prop Width int32\n" +
            "    prop Height int32\n" +
            "    init() { }\n" +
            "}\n" +
            "func main() {\n" +
            "    let b = Box() { Width = 5, Height = 6 }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Width", occurrence: 1)
        )
        Assert.NotNull(hover)
        let value = hover!!.Contents.ToString()
        Assert.Contains("Width", value, StringComparison.Ordinal)
        Assert.Contains("int32", value, StringComparison.Ordinal)
    }

    @Fact
    func ComputeCompletions_InsideClrInitializerBlock_OffersWritableMembers() {
        const source = "import System.Diagnostics\n" +
            "func main() {\n" +
            "    let psi = ProcessStartInfo(\"dotnet\") {\n" +
            "        RedirectStandardOutput = true,\n" +
            "        \n" +
            "    }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        // Caret on the blank line inside the initializer block (a name position).
        let position = LanguageServerTestHelpers.PositionOf(source, "        \n    }", occurrence: 0)
        let caret = Position(position.Line, 8)
        let items = CompletionComputer.ComputeCompletions(content, caret)
        Assert.Contains(
            items,
            (i CompletionItem) -> i.Label == "UseShellExecute" && i.Kind == CompletionItemKind.Property
        )
        Assert.Contains(
            items,
            (i CompletionItem) -> i.Label == "RedirectStandardError" && i.Kind == CompletionItemKind.Property
        )
        // The global keyword list must be suppressed inside the initializer block.
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "let" && i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_InsideEmptyClrInitializerBlock_OffersWritableMembers() {
        const source = "import System.Diagnostics\n" +
            "func main() {\n" +
            "    let psi = ProcessStartInfo(\"dotnet\") {  }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        // Caret between the two braces.
        let bracePos = LanguageServerTestHelpers.PositionOf(source, "{  }")
        let caret = Position(bracePos.Line, bracePos.Character + 2)
        let items = CompletionComputer.ComputeCompletions(content, caret)
        Assert.Contains(
            items,
            (i CompletionItem) -> i.Label == "UseShellExecute" && i.Kind == CompletionItemKind.Property
        )
    }

    @Fact
    func ComputeCompletions_WhileTypingFirstClrInitializerProperty_OffersWritableMembers() {
        // Mid-typing the very first property name without a trailing `=` parses the
        // brace block as a standalone block (no ObjectCreationExpression). The orphan
        // recovery still offers the constructed type's writable members.
        const source = "import System.Diagnostics\n" +
            "func main() {\n" +
            "    let psi = ProcessStartInfo(\"dotnet\") {\n" +
            "        Redirect\n" +
            "    }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let namePos = LanguageServerTestHelpers.PositionOf(source, "Redirect")
        let caret = Position(namePos.Line, namePos.Character + "Redirect".Length)
        let items = CompletionComputer.ComputeCompletions(content, caret)
        Assert.Contains(
            items,
            (i CompletionItem) -> i.Label == "RedirectStandardOutput" && i.Kind == CompletionItemKind.Property
        )
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "let" && i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_InsideGSharpClassInitializerBlock_OffersProperties() {
        const source = "class Box {\n" +
            "    prop Width int32\n" +
            "    prop Height int32\n" +
            "    init() { }\n" +
            "}\n" +
            "func main() {\n" +
            "    let b = Box() {  }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let bracePos = LanguageServerTestHelpers.PositionOf(source, "{  }")
        let caret = Position(bracePos.Line, bracePos.Character + 2)
        let items = CompletionComputer.ComputeCompletions(content, caret)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Width" && i.Kind == CompletionItemKind.Property)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Height" && i.Kind == CompletionItemKind.Property)
    }

    @Fact
    func ComputeCompletions_InsideGSharpClassInitializerBlock_OffersInheritedAndOwnFieldsAndProperties() {
        // ADR-0112 A1 parity: object-initializer completion routes through the
        // canonical TypeMemberModel. The offered set must include this-type and
        // inherited instance fields and properties (settable members object
        // initializers accept), walking the base chain.
        const source = "open class Base {\n" +
            "    prop BaseProp int32\n" +
            "    var baseField int32\n" +
            "}\n" +
            "class Derived : Base {\n" +
            "    prop Width int32\n" +
            "    var height int32\n" +
            "    init() { }\n" +
            "}\n" +
            "func main() {\n" +
            "    let d = Derived() {  }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let bracePos = LanguageServerTestHelpers.PositionOf(source, "{  }")
        let caret = Position(bracePos.Line, bracePos.Character + 2)
        let items = CompletionComputer.ComputeCompletions(content, caret)
        // Own members.
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Width" && i.Kind == CompletionItemKind.Property)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "height" && i.Kind == CompletionItemKind.Field)
        // Inherited members from the base class.
        Assert.Contains(items, (i CompletionItem) -> i.Label == "BaseProp" && i.Kind == CompletionItemKind.Property)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "baseField" && i.Kind == CompletionItemKind.Field)
    }

    @Fact
    func ComputeCompletions_OnChainedReceiverRootedInAnEnclosingLocal_BindsTheLocal() {
        // ADR-0212 S5: the speculative bind of the incomplete chain `d.Next.` needs the local `d`
        // of the enclosing body; ignoring the in-scope locals leaves the receiver unbound.
        const source = "class Derived {\n" +
            "    prop Next Derived?\n" +
            "    prop Width int32\n" +
            "}\n" +
            "func main() {\n" +
            "    let d = Derived()\n" +
            "    d.Next!!.\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        let dot = LanguageServerTestHelpers.PositionOf(source, "Next!!.")
        let caret = Position(dot.Line, dot.Character + 7)
        let items = CompletionComputer.ComputeCompletions(content, caret)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Width" && i.Kind == CompletionItemKind.Property)
    }

    @Fact
    func ComputeCompletions_InValuePositionOfInitializer_FallsBackToGlobalList() {
        const source = "import System.Diagnostics\n" +
            "func main() {\n" +
            "    let psi = ProcessStartInfo(\"dotnet\") {\n" +
            "        RedirectStandardOutput = \n" +
            "    }\n" +
            "}\n"
        let content = LanguageServerTestHelpers.Content(source)
        // Caret right after `RedirectStandardOutput = ` (value position).
        let eqPos = LanguageServerTestHelpers.PositionOf(source, "RedirectStandardOutput = ")
        let caret = Position(eqPos.Line, eqPos.Character + "RedirectStandardOutput = ".Length)
        let items = CompletionComputer.ComputeCompletions(content, caret)
        // Value position offers the regular global list (keywords/symbols), not the
        // initializer's writable members.
        Assert.Contains(items, (i CompletionItem) -> i.Label == "true" && i.Kind == CompletionItemKind.Keyword)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "UseShellExecute")
    }
}
