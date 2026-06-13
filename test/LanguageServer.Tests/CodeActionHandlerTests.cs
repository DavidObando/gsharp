// <copyright file="CodeActionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;
using Xunit;
using Range = GSharp.LanguageServer.Protocol.Range;

namespace GSharp.LanguageServer.Tests;

public class CodeActionHandlerTests
{
    [Fact]
    public void ComputeCodeActions_OffersSortImports()
    {
        const string source = "import Zeta\nimport Alpha\nfunc F() {}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///actions.gs");

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, new Range(new Position(0, 0), new Position(0, 0))).ToList();

        var sort = Assert.Single(actions, a => a.CodeAction.Title == "Sort imports");
        Assert.Equal(CodeActionKind.RefactorRewrite, sort.CodeAction.Kind);
        Assert.Contains("import Alpha", sort.CodeAction.Edit.Changes[uri].Single().NewText, System.StringComparison.Ordinal);
    }

    [Fact]
    public void NullConditionalQuickFix_OfferedOnNullableMemberAccess()
    {
        // ADR-0099 / issue #730: GS0158 ("Cannot find member") on a `.` access whose receiver
        // is a `T?` should offer a `.` → `?.` rewrite. The rewrite must be valid (the
        // resulting program no longer reports the diagnostic).
        const string source = @"func main() {
    let x string? = ""hi""
    let n = x.Length
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///deref.gs");
        var memberStart = LanguageServerTestHelpers.PositionOf(source, "Length");
        var range = new Range(memberStart, memberStart);

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, range).ToList();

        var quickFix = Assert.Single(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullConditionalAccessTitle);
        Assert.Equal(CodeActionKind.QuickFix, quickFix.CodeAction.Kind);

        var edit = quickFix.CodeAction.Edit.Changes[uri].Single();
        Assert.Equal("?.", edit.NewText);

        // Apply the edit and verify the resulting program no longer reports GS0158.
        var rewritten = ApplyEdit(source, edit);
        var rebound = new Compilation(SyntaxTree.Parse(rewritten));
        Assert.DoesNotContain(rebound.BoundProgram.Diagnostics, d => d.Id == "GS0158");
    }

    [Fact]
    public void NullConditionalQuickFix_NotOfferedForRegularMissingMember()
    {
        // Non-nullable receiver with a typo should NOT trigger the nullable-deref quick fix.
        const string source = @"func main() {
    let x string = ""hi""
    let n = x.Lenghh
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///typo.gs");
        var memberStart = LanguageServerTestHelpers.PositionOf(source, "Lenghh");
        var range = new Range(memberStart, memberStart);

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, range).ToList();

        Assert.DoesNotContain(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullConditionalAccessTitle);
    }

    [Fact]
    public void ElvisAndAssertion_OfferedOnNullableConversion()
    {
        // GS0155/GS0156: assigning string? to string.
        const string source = @"func main() {
    let x string? = ""hi""
    let y string = x
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///conv.gs");
        var pos = LanguageServerTestHelpers.PositionOf(source, "x", occurrence: 1);
        var range = new Range(pos, pos);

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, range).ToList();

        var elvis = Assert.Single(actions, a => a.CodeAction.Title.StartsWith("Provide default with '?:", System.StringComparison.Ordinal));
        var bang = Assert.Single(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle);

        Assert.Equal(CodeActionKind.QuickFix, elvis.CodeAction.Kind);
        Assert.Equal(CodeActionKind.QuickFix, bang.CodeAction.Kind);

        var elvisEdit = elvis.CodeAction.Edit.Changes[uri].Single();
        Assert.Equal("(x ?: \"\")", elvisEdit.NewText);

        var bangEdit = bang.CodeAction.Edit.Changes[uri].Single();
        Assert.Equal("(x!!)", bangEdit.NewText);

        // Applying either edit clears the GS0155/GS0156 diagnostic.
        foreach (var fix in new[] { elvisEdit, bangEdit })
        {
            var rewritten = ApplyEdit(source, fix);
            var rebound = new Compilation(SyntaxTree.Parse(rewritten));
            Assert.DoesNotContain(rebound.BoundProgram.Diagnostics, d => d.Id == "GS0155" || d.Id == "GS0156");
        }
    }

    [Fact]
    public void ElvisAndAssertion_OfferedOnNullableArgument()
    {
        // GS0154: passing string? to parameter of type string.
        const string source = @"func f(s string) {}
func main() {
    let x string? = ""hi""
    f(x)
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///arg.gs");
        var pos = LanguageServerTestHelpers.PositionOf(source, "f(x)");
        // place the request on the argument
        var argPos = new Position(pos.Line, pos.Character + 2);
        var range = new Range(argPos, argPos);

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, range).ToList();

        var elvis = Assert.Single(actions, a => a.CodeAction.Title.StartsWith("Provide default with '?:", System.StringComparison.Ordinal));
        var bang = Assert.Single(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle);

        var elvisEdit = elvis.CodeAction.Edit.Changes[uri].Single();
        Assert.Equal("(x ?: \"\")", elvisEdit.NewText);

        var bangEdit = bang.CodeAction.Edit.Changes[uri].Single();
        Assert.Equal("(x!!)", bangEdit.NewText);

        // The applied null-assertion fix must remove GS0154.
        var rewritten = ApplyEdit(source, bangEdit);
        var rebound = new Compilation(SyntaxTree.Parse(rewritten));
        Assert.DoesNotContain(rebound.BoundProgram.Diagnostics, d => d.Id == "GS0154");
    }

    [Fact]
    public void NullableValueFixes_NotOfferedForLiteralNil()
    {
        // GS0274 fires on a literal `nil` flowing into a non-nullable parameter. Wrapping `nil`
        // in `?:` or `!!` is degenerate — the user has to make the parameter nullable instead
        // (see the diagnostic's own suggestion).
        const string source = @"func f(s string) {}
func main() {
    f(nil)
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///nil.gs");
        var pos = LanguageServerTestHelpers.PositionOf(source, "nil");
        var range = new Range(pos, pos);

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, range).ToList();

        Assert.DoesNotContain(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle);
        Assert.DoesNotContain(actions, a => a.CodeAction.Title.StartsWith("Provide default with '?:", System.StringComparison.Ordinal));
    }

    [Fact]
    public void NullableQuickFixes_NotOfferedForUnrelatedDiagnostics()
    {
        // A pure syntax error elsewhere in the file should not produce any nullability fixes.
        const string source = @"func main() {
    let y int = ""abc""
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///unrelated.gs");
        var pos = LanguageServerTestHelpers.PositionOf(source, "\"abc\"");
        var range = new Range(pos, pos);

        var actions = CodeActionComputer.ComputeCodeActions(uri, content, range).ToList();

        Assert.DoesNotContain(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle);
        Assert.DoesNotContain(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullConditionalAccessTitle);
        Assert.DoesNotContain(actions, a => a.CodeAction.Title.StartsWith("Provide default with '?:", System.StringComparison.Ordinal));
    }

    [Fact]
    public void NullableQuickFixes_RangeOutsideDiagnosticReturnsNothing()
    {
        const string source = @"func main() {
    let x string? = ""hi""
    let y string = x
}
";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///out-of-range.gs");

        // Caret on the first line ("func main()") — the diagnostic is on line 2.
        var range = new Range(new Position(0, 0), new Position(0, 0));
        var actions = CodeActionComputer.ComputeCodeActions(uri, content, range).ToList();

        Assert.DoesNotContain(actions, a => a.CodeAction.Title == NullabilityQuickFixes.NullAssertionTitle);
        Assert.DoesNotContain(actions, a => a.CodeAction.Title.StartsWith("Provide default with '?:", System.StringComparison.Ordinal));
    }

    private static string ApplyEdit(string source, TextEdit edit)
    {
        // Convert the LSP-range back to an offset pair and splice in the replacement text.
        var startLine = edit.Range.Start.Line;
        var startChar = edit.Range.Start.Character;
        var endLine = edit.Range.End.Line;
        var endChar = edit.Range.End.Character;

        int startOffset = LineCharToOffset(source, startLine, startChar);
        int endOffset = LineCharToOffset(source, endLine, endChar);
        return source.Substring(0, startOffset) + edit.NewText + source.Substring(endOffset);
    }

    private static int LineCharToOffset(string source, int line, int character)
    {
        var offset = 0;
        for (var i = 0; i < line; i++)
        {
            var nl = source.IndexOf('\n', offset);
            if (nl < 0)
            {
                return source.Length;
            }

            offset = nl + 1;
        }

        return System.Math.Min(offset + character, source.Length);
    }
}

