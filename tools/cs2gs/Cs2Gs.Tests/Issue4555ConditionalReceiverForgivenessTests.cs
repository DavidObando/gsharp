// <copyright file="Issue4555ConditionalReceiverForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue4555ConditionalReceiverForgivenessTests
{
    [Fact]
    public void NilableComposedReceivers_AreAssertedExactlyOnce()
    {
        string printed = TranslateUnit("""
            using System;
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
            }
            """);

        Assert.Contains(")!!.ToString()", printed, StringComparison.Ordinal);
        Assert.Equal(3, CountOccurrences(printed, "!!.ToString()"));
        Assert.DoesNotContain("!!!!.ToString()", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void AlreadyAssertedAndNonNullReceivers_RemainUnchanged()
    {
        string printed = TranslateUnit("""
            #nullable enable
            using System;

            public static class C
            {
                public static string Asserted(object? value) => value!.ToString();

                public static string NonNull(bool condition) =>
                    (condition ? new object() : new object()).ToString();
            }
            """);

        Assert.Equal(1, CountOccurrences(printed, "value!!.ToString()"));
        Assert.DoesNotContain("value!!!!.ToString()", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "!!.ToString()"));
    }

    [Fact]
    public void AssertedComposedReceivers_AreNotDoubleAsserted_AndNullableValueTypesAreUntouched()
    {
        string printed = TranslateUnit("""
            #nullable enable
            using System;

            public static class C
            {
                public static string CondAsserted(bool c, object? a, object? b) =>
                    (c ? a : b)!.ToString();

                public static string CoalesceAsserted(object? a, object? b) =>
                    (a ?? b)!.ToString();

                public static string NullableValue(bool c) =>
                    (c ? (int?)1 : null).ToString();
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "!!.ToString()"));
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NilableComposedConcatOperand_UsesNullSafeConversion()
    {
        string printed = TranslateUnit("""
            using System;
            using System.Reflection;

            public static class C
            {
                public static string Describe(CustomAttributeTypedArgument argument) =>
                    "x:" + (argument.Value is Type type ? type.FullName : argument.Value);
            }
            """);

        Assert.Contains("?.ToString()", printed, StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static int CountOccurrences(string value, string substring) =>
        value.Split(substring, StringSplitOptions.None).Length - 1;
}
