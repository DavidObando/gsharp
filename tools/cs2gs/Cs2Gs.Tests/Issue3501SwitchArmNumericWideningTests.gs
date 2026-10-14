// <copyright file="Issue3501SwitchArmNumericWideningTests.cs" company="GSharp">
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

/// Issue #3501 (Translator burn-down, GS0179 family): C# target-types every
/// switch-expression arm to the switch's converted type (`long candidate =
/// value switch { sbyte item => item, ... }` widens each numeric arm to `long`
/// implicitly), while gsc requires every arm to produce the same type as the
/// first arm. A numeric arm whose own type differs from its C# converted type
/// must therefore spell the conversion C# inserted (`int64(item)`).
open class Issue3501SwitchArmNumericWideningTests {
    @Fact
    func SwitchExpression_NumericArms_WidenToConvertedType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Probe
    {
        public static long Classify(object value)
        {
            long candidate = value switch
            {
                sbyte item => item,
                int item => item,
                long item => item,
                _ => -1,
            };

            return candidate;
        }
    }
}
`)
        // Each narrower numeric arm carries the explicit widening C# applied
        // implicitly; the already-long arm stays bare.
        Assert.Contains("int64(item)", printed, StringComparison.Ordinal)
        Assert.Contains("int64(-1)", printed, StringComparison.Ordinal)
    }

    @Fact
    func SwitchExpression_UniformArms_StayBare() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Probe
    {
        public static int Classify(int value)
        {
            int result = value switch
            {
                0 => 10,
                1 => 20,
                _ => 30,
            };

            return result;
        }
    }
}
`)
        Assert.DoesNotContain("int32(", printed, StringComparison.Ordinal)
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
