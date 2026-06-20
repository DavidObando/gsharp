// <copyright file="ObjectInitializerHoverCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Issue #897: hover and completion inside C#-style object-initializer blocks
/// (<c>T(args) { Prop = v }</c>) — the property names resolve against the
/// constructed type for both imported CLR types and user-defined G# classes.
/// </summary>
public class ObjectInitializerHoverCompletionTests
{
    [Fact]
    public void ComputeHover_OnClrInitializerProperty_ResolvesAgainstConstructedType()
    {
        const string source = "import System.Diagnostics\n"
            + "func main() {\n"
            + "    let psi = ProcessStartInfo(\"dotnet\") {\n"
            + "        RedirectStandardOutput = true,\n"
            + "        UseShellExecute = false\n"
            + "    }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "RedirectStandardOutput"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("System.Diagnostics.ProcessStartInfo.RedirectStandardOutput", value, System.StringComparison.Ordinal);
        Assert.Contains("bool", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_OnSecondClrInitializerProperty_Resolves()
    {
        const string source = "import System.Diagnostics\n"
            + "func main() {\n"
            + "    let psi = ProcessStartInfo(\"dotnet\") {\n"
            + "        RedirectStandardOutput = true,\n"
            + "        UseShellExecute = false\n"
            + "    }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "UseShellExecute"));

        Assert.NotNull(hover);
        Assert.Contains("System.Diagnostics.ProcessStartInfo.UseShellExecute", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_OnGSharpClassInitializerProperty_ResolvesToPropertySymbol()
    {
        const string source = "class Box {\n"
            + "    prop Width int32\n"
            + "    prop Height int32\n"
            + "    init() { }\n"
            + "}\n"
            + "func main() {\n"
            + "    let b = Box() { Width = 5, Height = 6 }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Width", occurrence: 1));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Width", value, System.StringComparison.Ordinal);
        Assert.Contains("int32", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeCompletions_InsideClrInitializerBlock_OffersWritableMembers()
    {
        const string source = "import System.Diagnostics\n"
            + "func main() {\n"
            + "    let psi = ProcessStartInfo(\"dotnet\") {\n"
            + "        RedirectStandardOutput = true,\n"
            + "        \n"
            + "    }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Caret on the blank line inside the initializer block (a name position).
        var position = LanguageServerTestHelpers.PositionOf(source, "        \n    }", occurrence: 0);
        var caret = new Position(position.Line, 8);

        var items = CompletionComputer.ComputeCompletions(content, caret);

        Assert.Contains(items, i => i.Label == "UseShellExecute" && i.Kind == CompletionItemKind.Property);
        Assert.Contains(items, i => i.Label == "RedirectStandardError" && i.Kind == CompletionItemKind.Property);

        // The global keyword list must be suppressed inside the initializer block.
        Assert.DoesNotContain(items, i => i.Label == "let" && i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_InsideEmptyClrInitializerBlock_OffersWritableMembers()
    {
        const string source = "import System.Diagnostics\n"
            + "func main() {\n"
            + "    let psi = ProcessStartInfo(\"dotnet\") {  }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Caret between the two braces.
        var bracePos = LanguageServerTestHelpers.PositionOf(source, "{  }");
        var caret = new Position(bracePos.Line, bracePos.Character + 2);

        var items = CompletionComputer.ComputeCompletions(content, caret);

        Assert.Contains(items, i => i.Label == "UseShellExecute" && i.Kind == CompletionItemKind.Property);
    }

    [Fact]
    public void ComputeCompletions_WhileTypingFirstClrInitializerProperty_OffersWritableMembers()
    {
        // Mid-typing the very first property name without a trailing `=` parses the
        // brace block as a standalone block (no ObjectCreationExpression). The orphan
        // recovery still offers the constructed type's writable members.
        const string source = "import System.Diagnostics\n"
            + "func main() {\n"
            + "    let psi = ProcessStartInfo(\"dotnet\") {\n"
            + "        Redirect\n"
            + "    }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var namePos = LanguageServerTestHelpers.PositionOf(source, "Redirect");
        var caret = new Position(namePos.Line, namePos.Character + "Redirect".Length);

        var items = CompletionComputer.ComputeCompletions(content, caret);

        Assert.Contains(items, i => i.Label == "RedirectStandardOutput" && i.Kind == CompletionItemKind.Property);
        Assert.DoesNotContain(items, i => i.Label == "let" && i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void ComputeCompletions_InsideGSharpClassInitializerBlock_OffersProperties()
    {
        const string source = "class Box {\n"
            + "    prop Width int32\n"
            + "    prop Height int32\n"
            + "    init() { }\n"
            + "}\n"
            + "func main() {\n"
            + "    let b = Box() {  }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var bracePos = LanguageServerTestHelpers.PositionOf(source, "{  }");
        var caret = new Position(bracePos.Line, bracePos.Character + 2);

        var items = CompletionComputer.ComputeCompletions(content, caret);

        Assert.Contains(items, i => i.Label == "Width" && i.Kind == CompletionItemKind.Property);
        Assert.Contains(items, i => i.Label == "Height" && i.Kind == CompletionItemKind.Property);
    }

    [Fact]
    public void ComputeCompletions_InValuePositionOfInitializer_FallsBackToGlobalList()
    {
        const string source = "import System.Diagnostics\n"
            + "func main() {\n"
            + "    let psi = ProcessStartInfo(\"dotnet\") {\n"
            + "        RedirectStandardOutput = \n"
            + "    }\n"
            + "}\n";
        var content = LanguageServerTestHelpers.Content(source);

        // Caret right after `RedirectStandardOutput = ` (value position).
        var eqPos = LanguageServerTestHelpers.PositionOf(source, "RedirectStandardOutput = ");
        var caret = new Position(eqPos.Line, eqPos.Character + "RedirectStandardOutput = ".Length);

        var items = CompletionComputer.ComputeCompletions(content, caret);

        // Value position offers the regular global list (keywords/symbols), not the
        // initializer's writable members.
        Assert.Contains(items, i => i.Label == "true" && i.Kind == CompletionItemKind.Keyword);
        Assert.DoesNotContain(items, i => i.Label == "UseShellExecute");
    }
}
