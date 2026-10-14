// <copyright file="Issue2260NamedArgumentSkipExtensionReceiverTests.cs" company="GSharp">
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

/// Issue #2260/#3090: reduced extension calls preserve their named arguments;
/// gsc maps them after the implicit receiver and supplies skipped defaults.
/// @remarks Native named-argument binding eliminates translator-side ordinal filling,
/// including the former reduced-extension receiver offset special case.
open class Issue2260NamedArgumentSkipExtensionReceiverTests {
    @Fact
    func NamedArgument_SkipsExtensionOptionalParameterWithEnumMemberDefault_PreservesName() {
        let printed = TranslateUnit(`
namespace Demo
{
    public enum Align { Left, Right }

    public class Table { }

    public static class TableExtensions
    {
        public static Table AddBoldColumn(this Table table, string header, Align align = Align.Left, bool noWrap = false)
        {
            return table;
        }
    }

    public class C
    {
        public void Caller(Table table)
        {
            table.AddBoldColumn("Length", noWrap: true);
        }
    }
}`)
        Assert.Contains(
            "TableExtensions.AddBoldColumn(table, \"Length\", noWrap: true)",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func NamedArgument_SkipsExtensionOptionalParameterWithDefaultKeywordDefault_PreservesName() {
        let printed = TranslateUnit(`
namespace Demo
{
    public struct Options { public int X; }

    public class Table { }

    public static class TableExtensions
    {
        public static Table AddOptions(this Table table, string header, Options options = default, bool noWrap = false)
        {
            return table;
        }
    }

    public class C
    {
        public void Caller(Table table)
        {
            table.AddOptions("Length", noWrap: true);
        }
    }
}`)
        Assert.Contains(
            "TableExtensions.AddOptions(table, \"Length\", noWrap: true)",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func NamedArgument_OnExtensionCallWithNoSkippedParameter_StillWorks() {
        // Baseline: an extension-method call whose named argument does NOT skip
        // any optional parameter must be unaffected by the ordinal-offset fix.
        let printed = TranslateUnit(`
namespace Demo
{
    public class Table { }

    public static class TableExtensions
    {
        public static Table AddColumn(this Table table, string header, bool noWrap = false)
        {
            return table;
        }
    }

    public class C
    {
        public void Caller(Table table)
        {
            table.AddColumn(header: "Length", noWrap: true);
        }
    }
}`)
        Assert.Contains(
            "TableExtensions.AddColumn(table, header: \"Length\", noWrap: true)",
            printed,
            StringComparison.Ordinal
        )
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
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
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
