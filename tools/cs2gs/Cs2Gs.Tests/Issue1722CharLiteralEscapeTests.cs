// <copyright file="Issue1722CharLiteralEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translation tests for issue #1722: cs2gs printed char literals with zero
/// escaping. C# <c>'\''</c>, <c>'\\'</c>, <c>'\n'</c>, and other control
/// characters were emitted verbatim, producing malformed G# (empty-literal
/// diagnostics, unterminated literals, or raw control bytes in the output
/// file). <see cref="Cs2Gs.CodeModel.Printing.GSharpPrinter"/> now escapes
/// char literals the same way it escapes string literals (minus dollar-sign
/// doubling, which only applies to interpolation), matching exactly the
/// escapes G#'s own lexer accepts (<c>Lexer.ReadCharLiteral</c>): <c>\\</c>,
/// <c>\'</c>, <c>\n</c>, <c>\r</c>, <c>\t</c>, and <c>\uXXXX</c> for other
/// control/non-printable chars.
/// </summary>
public class Issue1722CharLiteralEscapeTests
{
    [Theory]
    [InlineData('\'', "SingleQuote")]
    [InlineData('\\', "Backslash")]
    [InlineData('\n', "Newline")]
    [InlineData('\t', "Tab")]
    [InlineData('\r', "CarriageReturn")]
    [InlineData('\0', "Nul")]
    [InlineData('A', "PrintableAscii")]
    [InlineData('\u00e9', "LatinSupplement")]
    [InlineData('\u3042', "Hiragana")]
    public void CharLiteral_RoundTripsToSameValue(char value, string label)
    {
        _ = label;

        string source = $@"
namespace Demo
{{
    public class C
    {{
        public char F() => '{EscapeForCSharpSource(value)}';
    }}
}}";

        string printed = TranslateUnit(source);

        // The printed char literal must lex back to the exact same char value.
        char reparsed = LexSingleCharLiteral(printed);
        Assert.Equal(value, reparsed);
    }

    /// <summary>
    /// Escapes a char for embedding in the *C#* source snippet under test
    /// (independent of the G# printer under test).
    /// </summary>
    private static string EscapeForCSharpSource(char value) => value switch
    {
        '\'' => "\\'",
        '\\' => "\\\\",
        '\n' => "\\n",
        '\t' => "\\t",
        '\r' => "\\r",
        '\0' => "\\0",
        _ => value.ToString(),
    };

    /// <summary>
    /// Finds the (single) char-literal token in the printed G# source and
    /// returns the value the real G# lexer produces for it.
    /// </summary>
    private static char LexSingleCharLiteral(string gsharpSource)
    {
        SyntaxTree tree = SyntaxTree.Parse(gsharpSource);
        return FindCharToken(tree);
    }

    private static char FindCharToken(SyntaxTree tree)
    {
        foreach (var token in EnumerateTokens(tree))
        {
            if (token.Kind == SyntaxKind.CharacterToken)
            {
                return (char)token.Value;
            }
        }

        throw new InvalidOperationException(
            "No char-literal token found in printed G# source:\n" + tree.Text.ToString());
    }

    private static System.Collections.Generic.IEnumerable<SyntaxToken> EnumerateTokens(SyntaxTree tree)
    {
        var lexer = new Lexer(tree);
        while (true)
        {
            SyntaxToken token = lexer.Lex();
            yield return token;
            if (token.Kind == SyntaxKind.EndOfFileToken)
            {
                yield break;
            }
        }
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
