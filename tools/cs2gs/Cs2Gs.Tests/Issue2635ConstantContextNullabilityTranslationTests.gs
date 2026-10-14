// <copyright file="Issue2635ConstantContextNullabilityTranslationTests.cs" company="GSharp">
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

open class Issue2635ConstantContextNullabilityTranslationTests {
    @Fact
    func ConstantStringConcatenations_RemainConstantForFieldsAndLocals() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private const string Extension = ".json";
        public const string Settings = "appsettings" + Extension;

        public string UserAgent()
        {
            const string value = "Mozilla/5.0 " + "AppleWebKit/537.36";
            return value;
        }
    }
}`)
        Assert.Contains("const Settings string = \"appsettings\" + Extension", printed)
        Assert.Contains("const value = \"Mozilla/5.0 \" + \"AppleWebKit/537.36\"", printed)
        Assert.DoesNotContain("!!", printed)
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
