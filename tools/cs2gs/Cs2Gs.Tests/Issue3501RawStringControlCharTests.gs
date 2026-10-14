// <copyright file="Issue3501RawStringControlCharTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3501: a multiline C# string normally renders as a Go-style backtick
/// raw literal, but raw literals carry characters verbatim — an embedded NUL
/// (Core.Tests' LexerTests fixture for issue #1608) lexes as end-of-file and
/// the emitted file fails the round-trip parse (GS0003 unterminated string).
/// Values holding control characters other than newline/tab keep the escaped
/// one-line form, where NUL renders as `\\u0000`.
open class Issue3501RawStringControlCharTests {
    @Fact
    func MultilineStringWithEmbeddedNul_KeepsEscapedForm() {
        let g = Render(`namespace N
{
    public class C
    {
        public string Source() => "let a = 1\n\0let b = 2\nlet c = 3\n";
    }
}`)
        Assert.DoesNotContain("`", g, StringComparison.Ordinal)
        Assert.Contains("\\u0000", g, StringComparison.Ordinal)
    }

    @Fact
    func MultilineStringWithoutControlChars_KeepsRawForm() {
        let g = Render(`namespace N
{
    public class C
    {
        public string Source() => "let a = 1\nlet b = 2\nlet c = 3\n";
    }
}`)
        Assert.Contains("`let a = 1", g, StringComparison.Ordinal)
    }

    shared {
        private func Render(csharp string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, csharp string){("Source.cs", csharp)})
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
