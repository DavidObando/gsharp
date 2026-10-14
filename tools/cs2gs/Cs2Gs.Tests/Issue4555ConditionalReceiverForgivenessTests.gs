// <copyright file="Issue4555ConditionalReceiverForgivenessTests.cs" company="GSharp">
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

open class Issue4555ConditionalReceiverForgivenessTests {
    @Fact
    func NilableComposedReceivers_AreAssertedExactlyOnce() {
        let printed = TranslateUnit(`using System;
using System.Reflection;

public static class C
{
    public static string Conditional(CustomAttributeTypedArgument argument) =>
        (argument.Value is Type type ? type.FullName : argument.Value).ToString();

    public static string Switch(CustomAttributeTypedArgument argument) =>
        (argument.Value switch { Type type => type.FullName, _ => argument.Value }).ToString();

    public static string Coalesce(
        CustomAttributeTypedArgument left,
        CustomAttributeTypedArgument right) =>
        (left.Value ?? right.Value).ToString();
}`)
        Assert.Contains(")!!.ToString()", printed, StringComparison.Ordinal)
        Assert.Equal(3, CountOccurrences(printed, "!!.ToString()"))
        Assert.DoesNotContain("!!!!.ToString()", printed, StringComparison.Ordinal)
    }

    @Fact
    func AlreadyAssertedAndNonNullReceivers_RemainUnchanged() {
        let printed = TranslateUnit(`#nullable enable
using System;

public static class C
{
    public static string Asserted(object? value) => value!.ToString();

    public static string NonNull(bool condition) =>
        (condition ? new object() : new object()).ToString();
}`)
        Assert.Equal(1, CountOccurrences(printed, "value!!.ToString()"))
        Assert.DoesNotContain("value!!!!.ToString()", printed, StringComparison.Ordinal)
        Assert.Equal(1, CountOccurrences(printed, "!!.ToString()"))
    }

    @Fact
    func AssertedComposedReceivers_AreNotDoubleAsserted_AndNullableValueTypesAreUntouched() {
        let printed = TranslateUnit(`#nullable enable
using System;

public static class C
{
    public static string CondAsserted(bool c, object? a, object? b) =>
        (c ? a : b)!.ToString();

    public static string CoalesceAsserted(object? a, object? b) =>
        (a ?? b)!.ToString();

    public static string NullableValue(bool c) =>
        (c ? (int?)1 : null).ToString();
}`)
        Assert.Equal(2, CountOccurrences(printed, "!!.ToString()"))
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func NilableComposedConcatOperand_UsesNullSafeConversion() {
        let printed = TranslateUnit(`using System;
using System.Reflection;

public static class C
{
    public static string Describe(CustomAttributeTypedArgument argument) =>
        "x:" + (argument.Value is Type type ? type.FullName : argument.Value);
}`)
        Assert.Contains("?.ToString()", printed, StringComparison.Ordinal)
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
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }

        private func CountOccurrences(value string, substring string) int32 -> value.Split(
            substring,
            StringSplitOptions.None
        )
            .Length - 1
    }
}
