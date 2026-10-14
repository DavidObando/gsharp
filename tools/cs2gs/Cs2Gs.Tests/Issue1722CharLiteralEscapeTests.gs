// <copyright file="Issue1722CharLiteralEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Syntax
import System
import Xunit

/// Translation tests for issue #1722: cs2gs printed char literals with zero
/// escaping. C# `'\''`, `'\\'`, `'\n'`, and other control
/// characters were emitted verbatim, producing malformed G# (empty-literal
/// diagnostics, unterminated literals, or raw control bytes in the output
/// file). (cref:Cs2Gs.CodeModel.Printing.GSharpPrinter) now escapes
/// char literals the same way it escapes string literals (minus dollar-sign
/// doubling, which only applies to interpolation), matching exactly the
/// escapes G#'s own lexer accepts (`Lexer.ReadCharLiteral`): `\\`,
/// `\'`, `\n`, `\r`, `\t`, and `\uXXXX` for other
/// control/non-printable chars.
open class Issue1722CharLiteralEscapeTests {
    @Theory
    @InlineData('\'', "SingleQuote")
    @InlineData('\\', "Backslash")
    @InlineData('\n', "Newline")
    @InlineData('\t', "Tab")
    @InlineData('\r', "CarriageReturn")
    @InlineData('\u0000', "Nul")
    @InlineData('A', "PrintableAscii")
    @InlineData('é', "LatinSupplement")
    @InlineData('あ', "Hiragana")
    func CharLiteral_RoundTripsToSameValue(value char, label string) {
        let source = (`
namespace Demo
{
    public class C
    {
        public char F() => '` + "${EscapeForCSharpSource(value)}" + `';
    }
}`)
        let printed = TranslateUnit(source)
        // The printed char literal must lex back to the exact same char value.
        let reparsed = LexSingleCharLiteral(printed)
        Assert.Equal(value, reparsed)
    }

    shared {
        /// Escapes a char for embedding in the *C#* source snippet under test
        /// (independent of the G# printer under test).
        private func EscapeForCSharpSource(value char) string -> switch value {
            case '\'': "\\'"
            case '\\': "\\\\"
            case '\n': "\\n"
            case '\t': "\\t"
            case '\r': "\\r"
            case '\u0000': "\\0"
            default: value.ToString()
        }

        /// Finds the (single) char-literal token in the printed G# source and
        /// returns the value the real G# lexer produces for it.
        private func LexSingleCharLiteral(gsharpSource string) char {
            let tree = SyntaxTree.Parse(gsharpSource)
            return FindCharToken(tree)
        }

        private func FindCharToken(tree SyntaxTree) char {
            for token in EnumerateTokens(tree) {
                if token.Kind == SyntaxKind.CharacterToken {
                    return char(token.Value)
                }
            }
            throw InvalidOperationException(
                "No char-literal token found in printed G# source:\n" + tree.Text.ToString()
            )
        }

        private func EnumerateTokens(tree SyntaxTree) sequence[SyntaxToken] {
            let lexer = Lexer(tree)
            while true {
                let token = lexer.Lex()
                yield token
                if token.Kind == SyntaxKind.EndOfFileToken {
                    yield break
                }
            }
        }

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
