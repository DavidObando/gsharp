// <copyright file="Issue1914TupleAliasDirectiveTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Regression tests for issue #1914: a C# 12 alias-any-type `using`
/// directive whose right-hand side is a tuple type (`using NamePair =
/// (int Number, string Word);`) used to hit "using directive without a
/// resolvable name" because the import-directive step only handled the
/// `NameSyntax`-typed RHS a pre-C#12 alias always had. The directive's
/// generalized `NamespaceOrType` property covers both forms; a
/// non-name RHS has no dotted-path G# `import` line to emit, but every
/// USE of the alias still resolves through the semantic model straight to
/// its underlying type, so it needs none: the tuple alias expands to G#'s
/// positional tuple type at each reference, same as a written-out tuple
/// type would.
open class Issue1914TupleAliasDirectiveTests {
    @Fact
    func TupleAlias_UsedInVariableDeclaration_TranslatesToPositionalTuple() {
        let printed = TranslateUnit(`
using NamePair = (int Number, string Word);

namespace Demo
{
    public class C
    {
        public void M()
        {
            NamePair pair = (1, "a");
        }
    }
}`)
        // ADR-0172: the alias's element names are preserved name-first.
        Assert.Contains("let pair (Number int32, Word string) = (1, \"a\")", printed)
    }

    @Fact
    func TupleAlias_UsedInMethodSignature_TranslatesToPositionalTuple() {
        let printed = TranslateUnit(`
using NamePair = (int Number, string Word);

namespace Demo
{
    public class C
    {
        public NamePair Make(NamePair seed)
        {
            return seed;
        }
    }
}`)
        // ADR-0172: the alias's element names are preserved name-first.
        Assert.Contains("func Make(seed (Number int32, Word string)) (Number int32, Word string)", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
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
