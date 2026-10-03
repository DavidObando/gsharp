// <copyright file="Issue4721ParenthesizedNullCastTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue4721ParenthesizedNullCastTranslationTests
{
    [Theory]
    [InlineData("string", "(null)")]
    [InlineData("string", "(((null)))")]
    [InlineData("object", "((null))")]
    [InlineData("string[]", "((null))")]
    [InlineData("System.Collections.Generic.List<string>", "((null))")]
    [InlineData("int?", "((null))")]
    [InlineData("System.Guid?", "((null))")]
    public void ParenthesizedNullCast_BindsAndPreservesUnparenthesizedOutputAndNull(
        string target,
        string operand)
    {
        string unparenthesized = Translate(NullCastSource(target, "null"));
        TranslationTestValidation.AssertBinds(unparenthesized);

        string parenthesized = Translate(NullCastSource(target, operand));
        TranslationTestValidation.AssertBinds(parenthesized);
        Assert.Equal(unparenthesized, parenthesized);
        Assert.DoesNotContain("!!", parenthesized, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            parenthesized + Environment.NewLine + "Obj.Missing()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Null(result.Value);
    }

    [Fact]
    public void ParenthesizedDelegateNullCast_BindsAndPreservesUnparenthesizedOutput()
    {
        string unparenthesized = Translate(NullCastSource("System.Action", "null"));
        string parenthesized = Translate(NullCastSource("System.Action", "((null))"));
        TranslationTestValidation.AssertBinds(unparenthesized);
        TranslationTestValidation.AssertBinds(parenthesized);
        Assert.Equal(unparenthesized, parenthesized);
    }

    [Fact]
    public void ParenthesizedNonNullCasts_KeepReferenceValueAndUserDefinedConversions()
    {
        string printed = Translate(@"
#nullable disable
public struct Value
{
    public static explicit operator int(Value value) => 7;
}

public static class Obj
{
    public static string Reference(object value) => (string)(((value)));
    public static int Numeric(double value) => (int)(((value)));
    public static int UserDefined(Value value) => (int)(((value)));
}");

        TranslationTestValidation.AssertBinds(printed);
        Assert.Contains("cast[string]((((value))))", printed, StringComparison.Ordinal);
        Assert.Contains("int32((((value))))", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("default(", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine
                + @"Obj.Reference(""ok"") == ""ok"" && Obj.Numeric(3.9) == 3 && Obj.UserDefined(Value{}) == 7");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(true, result.Value);
    }

    private static string NullCastSource(string target, string operand) => $@"
#nullable disable
public static class Obj {{
    public static {target} Missing() => ({target}){operand};
}}";

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        var unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
