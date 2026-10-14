// <copyright file="Issue4833NullableTupleValueTranslationTests.cs" company="GSharp">
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

class Issue4833NullableTupleValueTranslationTests {
    @Fact
    func NullableReturnStoredInDictionaryTupleValue_PromotesMatchingElement() {
        const source = `using System.Collections.Generic;

public static class Probe
{
    private static string AttributeConstant(bool present)
    {
        if (present)
        {
            return "value";
        }

        return null;
    }

    public static void Run()
    {
        var values = new Dictionary<int, (string Name, string Default)>();
        string fallback = AttributeConstant(false);
        values[0] = ("arg", fallback);

        if (!values.TryGetValue(1, out (string Name, string Default) value))
        {
            value = ("missing", null);
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Issue4833.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("Dictionary[int32, (Name string, Default string?)]", printed, StringComparison.Ordinal)
        Assert.Contains("func AttributeConstant(present bool) string?", printed, StringComparison.Ordinal)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
    }
}
