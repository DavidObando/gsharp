// <copyright file="Issue3501YieldSeamBridgingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #3501 (GS0155 yield family): a `yield` is a value seam against the
/// iterator's element type, exactly like an argument against its parameter — a
/// promoted-nullable value flowing into a non-null element needs the same `!!`
/// bridge the argument path inserts, both for scalar yields
/// (`yield Canonical(called)` where the callee returns `T?`) and per-element
/// for tuple literals (`yield (tryOutVar, true)` against `(Base, bool)`).
open class Issue3501YieldSeamBridgingTests {
    @Fact
    func Oblivious_TupleYieldWithPromotedElement_BridgesPerElement() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return "x";
        }

        public IEnumerable<(string Name, bool Flag)> Rows()
        {
            var candidate = Find(true);
            yield return (candidate, true);
        }
    }
}`)
        Assert.Contains("Find(b bool) string?", printed)
        Assert.Contains("yield (candidate!!, true)", printed)
    }

    @Fact
    func Oblivious_ScalarYieldOfPromotedCall_Bridges() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return "x";
        }

        public IEnumerable<int> Lengths()
        {
            yield return Find(true).Length;
        }
    }
}`)
        Assert.Contains("Find(true)!!.Length", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
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
