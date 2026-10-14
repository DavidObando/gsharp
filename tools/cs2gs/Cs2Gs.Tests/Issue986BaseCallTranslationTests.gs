// <copyright file="Issue986BaseCallTranslationTests.cs" company="GSharp">
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

/// Issue #986: C# `base.M(...)` inside an override now maps to the
/// canonical G# base-class call form `base.M(...)` (which emits a
/// non-virtual `call` into the base implementation), replacing the
/// previous `nil` placeholder.
open class Issue986BaseCallTranslationTests {
    @Fact
    func BaseMethodCall_InOverride_EmitsBaseDotForm() {
        let source = `namespace Probe;

public class Shape
{
    public virtual string Describe() => "shape";
}

public class Circle : Shape
{
    public override string Describe() => base.Describe() + " circle";
}`
        let printed = TranslateUnit(source)
        Assert.Contains("base.Describe()", printed)
        Assert.DoesNotContain("nil.Describe", printed)
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
