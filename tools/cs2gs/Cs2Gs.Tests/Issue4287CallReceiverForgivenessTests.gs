// <copyright file="Issue4287CallReceiverForgivenessTests.cs" company="GSharp">
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

/// Issue #4287: gsc reports GS0159 for an imported instance-method call on a
/// receiver that is `T?` in G#, as it already reported a member read
/// through one. Every path in cs2gs that emits a call therefore has to give
/// the receiver the same forgiveness a member read gets. Each test binds its
/// output with gsc, so a missed receiver fails as GS0159 rather than passing
/// on text alone.
open class Issue4287CallReceiverForgivenessTests {
    @Fact
    func GenericMethodCall_OnAFlowNarrowedNullableField_AssertsTheReceiver() {
        // C#'s flow analysis tracks the field's null state after the test (no
        // warning here). G# narrows only STABLE receivers (locals and `let`
        // fields, ADR-0069), and this field is a mutable `var`, so the G#
        // receiver needs `!!`. The generic-name call path used to translate
        // its receiver bare, unlike the non-generic one.
        let printed = TranslateUnit(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        private List<string>? items = new List<string> { "a" };

        public int F()
        {
            if (items != null)
            {
                return items.ConvertAll<int>(s => s.Length).Count + items.IndexOf("a");
            }

            return -1;
        }
    }
}`)
        Assert.Contains("items!!.ConvertAll[int32]", printed, StringComparison.Ordinal)
        Assert.Contains("items!!.IndexOf(", printed, StringComparison.Ordinal)
    }

    @Fact
    func DroppedByRefSuppression_OnAnotherTypeParameter_IsNotAsserted() {
        // Review finding: the suppressed `ref name!` fixes T, but the call
        // returns U (int), so nothing about the result became nilable and a
        // `!!` there would be spurious (and invalid on a value type).
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        private string? name = "n";

        private static U Pick<T, U>(ref T value, U result) => result;

        public int F() => Pick(ref name!, 1).CompareTo(0);
    }
}`, bind: false)
        // Not bound: a source-declared `ref T` parameter call is a separate,
        // pre-existing translation gap; only the receiver decision is asserted.
        Assert.Contains("Pick(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(")!!.CompareTo", printed, StringComparison.Ordinal)
    }

    @Fact
    func GenericStaticCall_OnATypeReceiver_IsNotAsserted() {
        // The control: a type is not a value, so a generic static call through
        // it is never forgiven.
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public int F() => Array.Empty<string>().Length;
    }
}`)
        Assert.Contains("Array.Empty[string]()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Array!!", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateUnit(source string, bind bool = true) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            if !bind {
                return printed
            }
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }
    }
}
