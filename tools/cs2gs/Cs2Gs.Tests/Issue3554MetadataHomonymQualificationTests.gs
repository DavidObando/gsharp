// <copyright file="Issue3554MetadataHomonymQualificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Text.RegularExpressions
import Xunit

/// Issue #3554: a fully-qualified METADATA reference used to shorten to its
/// bare simple name even when a DISTINCT same-named type sits in another of
/// the file's imported namespaces — gsc then silently bound the bare name to
/// the wrong package (the `GSharp.Core…Syntax.SyntaxFacts` vs Roslyn
/// `SyntaxFacts` family, GS0159 "Cannot find function IsReservedIdentifier").
/// The imported-namespace homonym scan now runs for metadata types in
/// ordinary positions too; it only fires on genuine collisions, so common
/// framework types still print bare.
open class Issue3554MetadataHomonymQualificationTests {
    @Fact
    func FullyQualifiedMetadataHomonym_StaysDisambiguated() {
        let printed = TranslateUnit(`
using System.Timers;

namespace Demo
{
    public class Probe
    {
        public ElapsedEventHandler Handler { get; set; }

        public object MakeThreadingTimer()
        {
            return new System.Threading.Timer(_ => { }, null, 0, 1000);
        }
    }
}`)
        // The System.Threading.Timer reference must not shorten to a bare
        // `Timer` that gsc would bind to System.Timers.Timer.
        Assert.DoesNotContain("return Timer(", printed)
        Assert.True(
            printed.Contains("System.Threading.Timer(", StringComparison.Ordinal) || Regex.IsMatch(
                printed,
                "import \\w+ = System\\.Threading\\.Timer"
            ),
            "The threading Timer must stay qualified or aliased. Printed:\n" + printed
        )
    }

    @Fact
    func UncollidedMetadataType_StaysBare() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Probe
    {
        public System.Text.StringBuilder Make()
        {
            return new System.Text.StringBuilder();
        }
    }
}`)
        Assert.Contains("StringBuilder()", printed)
        Assert.DoesNotContain("System.Text.StringBuilder()", printed)
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
