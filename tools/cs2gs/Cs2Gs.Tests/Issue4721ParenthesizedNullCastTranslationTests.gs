// <copyright file="Issue4721ParenthesizedNullCastTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

open class Issue4721ParenthesizedNullCastTranslationTests {
    @Theory
    @InlineData("string", "(null)")
    @InlineData("string", "(((null)))")
    @InlineData("object", "((null))")
    @InlineData("string[]", "((null))")
    @InlineData("System.Collections.Generic.List<string>", "((null))")
    @InlineData("int?", "((null))")
    @InlineData("System.Guid?", "((null))")
    func ParenthesizedNullCast_BindsAndPreservesUnparenthesizedOutputAndNull(target string, operand string) {
        let unparenthesized = Translate(NullCastSource(target, "null"))
        TranslationTestValidation.AssertBinds(unparenthesized)
        let parenthesized = Translate(NullCastSource(target, operand))
        TranslationTestValidation.AssertBinds(parenthesized)
        Assert.Equal(unparenthesized, parenthesized)
        Assert.DoesNotContain("!!", parenthesized, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(parenthesized + Environment.NewLine + "Obj.Missing()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Null(result.Value)
    }

    @Fact
    func ParenthesizedDelegateNullCast_BindsAndPreservesUnparenthesizedOutput() {
        let unparenthesized = Translate(NullCastSource("System.Action", "null"))
        let parenthesized = Translate(NullCastSource("System.Action", "((null))"))
        TranslationTestValidation.AssertBinds(unparenthesized)
        TranslationTestValidation.AssertBinds(parenthesized)
        Assert.Equal(unparenthesized, parenthesized)
    }

    @Fact
    func ParenthesizedNonNullCasts_KeepReferenceValueAndUserDefinedConversions() {
        let printed = Translate(`
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
}`)
        TranslationTestValidation.AssertBinds(printed)
        Assert.Contains("cast[string]((((value))))", printed, StringComparison.Ordinal)
        Assert.Contains("int32((((value))))", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("default(", printed, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(
            printed +
                Environment.NewLine +
                "Obj.Reference(\"ok\") == \"ok\" && Obj.Numeric(3.9) == 3 && Obj.UserDefined(Value{}) == 7"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(true, result.Value)
    }

    shared {
        private func NullCastSource(target string, operand string) string -> (`
#nullable disable
public static class Obj {
    public static ` + "$target" + ` Missing() => (` + "$target" + `)` + "$operand" + `;
}`)

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
