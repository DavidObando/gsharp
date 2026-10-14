// <copyright file="Issue4556AnalysisOnlyImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #4556: the managed-reference array analysis (#4545) maps a receiver's
/// array type only to inspect its element shape. That mapping used to record
/// the element type's namespace as a synthesized import, although no name from
/// it is printed. In self-migrated Core.Tests a `ParameterInfo[]` receiver
/// imported `System.Reflection`, which made the file's bare compiler
/// `Binder` ambiguous with `System.Reflection.Binder` (GS0547). An
/// analysis-only mapping now synthesizes no import; a printed reference still
/// does.
open class Issue4556AnalysisOnlyImportTests {
    @Fact
    func ArrayReceiverShapeAnalysis_DoesNotImportElementNamespace() {
        let printed = Translate(`
using System;

namespace Demo
{
    public class C
    {
        public void M(int value)
        {
        }

        public int Count()
        {
            return typeof(C).GetMethod("M").GetParameters().Length;
        }
    }
}`)
        Assert.Contains("GetParameters()", printed)
        Assert.DoesNotContain("import System.Reflection", printed)
    }

    @Fact
    func ArrayReceiverShapeAnalysis_OfHomonymElement_SynthesizesNoAlias() {
        // A source `ParameterInfo` makes the metadata one a homonym, which a
        // printing mapping disambiguates with a synthesized alias import. The
        // shape-only mapping must not register that alias either.
        let printed = Translate(`
using System;

namespace Demo
{
    public class ParameterInfo
    {
    }

    public class C
    {
        public void M(int value)
        {
        }

        public int Count()
        {
            return typeof(C).GetMethod("M").GetParameters().Length;
        }
    }
}`)
        Assert.Contains("GetParameters()", printed)
        Assert.DoesNotContain("System.Reflection", printed)
    }

    @Fact
    func PrintedElementReference_AfterShapeAnalysis_StillImportsItsNamespace() {
        // Negative control: the analysis-only mapping runs first; the printed
        // `ParameterInfo` reference that follows must still get its import.
        let printed = Translate(`
using System;

namespace Demo
{
    public class C
    {
        public void M(int value)
        {
        }

        public string First()
        {
            int count = typeof(C).GetMethod("M").GetParameters().Length;
            return typeof(System.Reflection.ParameterInfo).Name + count;
        }
    }
}`)
        Assert.Contains("import System.Reflection", printed)
        Assert.Contains("ParameterInfo", printed)
    }

    shared {
        private func Translate(source string) string {
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
