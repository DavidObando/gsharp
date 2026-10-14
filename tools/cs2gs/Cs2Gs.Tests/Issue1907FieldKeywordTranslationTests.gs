// <copyright file="Issue1907FieldKeywordTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1907: a property accessor using the C#14 `field` contextual
/// keyword (Roslyn's `FieldExpressionSyntax`, NOT an
/// `IdentifierNameSyntax`) refers to the compiler-synthesized backing
/// field of the enclosing property. G# has no synthesized-field surface —
/// ADR-0051 computed properties always name their own backing field
/// explicitly — so the property gets ONE real `var` field synthesized
/// and every `field` reference (across ALL its accessors, including a
/// bodyless/auto sibling accessor that implicitly shares the same
/// compiler-synthesized field) is rewritten to read/write it.
open class Issue1907FieldKeywordTranslationTests {
    @Fact
    func CustomSetWithField_AutoGet_ShareOneSynthesizedBackingField() {
        let rendered = Render(`
namespace Corpus.Issue1907
{
    public class ClampedGauge
    {
        public int Level
        {
            get;
            set => field = value < 0 ? 0 : value;
        }
    }
}
`)
        Assert.Contains("private var _level int32", rendered, StringComparison.Ordinal)
        Assert.Contains("return _level", rendered, StringComparison.Ordinal)
        Assert.Contains("_level = if value < 0 { 0 } else { value }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func GetWithFieldCoalesceAssign_AutoSet_LazilyInitializesSharedField() {
        let rendered = Render(`
namespace Corpus.Issue1907
{
    public class LazyLabel
    {
        public string Name { get => field ??= "default"; set; }
    }
}
`)
        Assert.Contains("private var _name string?", rendered, StringComparison.Ordinal)
        Assert.Contains("if _name == nil", rendered, StringComparison.Ordinal)
        Assert.Contains("(_name = \"default\")", rendered, StringComparison.Ordinal)
        Assert.Contains("_name = value", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func BothAccessorsCustom_ShareOneSynthesizedBackingField() {
        let rendered = Render(`
namespace Corpus.Issue1907
{
    public class LoggedCounter
    {
        private int changeCount;

        public int Count
        {
            get => field;
            set
            {
                field = value;
                changeCount = changeCount + 1;
            }
        }
    }
}
`)
        Assert.Contains("private var _count int32", rendered, StringComparison.Ordinal)
        Assert.Contains("get -> _count", rendered, StringComparison.Ordinal)
        Assert.Contains("_count = value", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SynthesizedBackingFieldName_AvoidsCollisionWithExistingMember() {
        // The type already declares a field named `_level` unrelated to the
        // property; the synthesized backing field must not collide with it.
        let rendered = Render(`
namespace Corpus.Issue1907
{
    public class ClampedGauge
    {
        private int _level;

        public int Level
        {
            get => field;
            set => field = value < 0 ? 0 : value;
        }

        public int RawLevel() => _level;
    }
}
`)
        Assert.Contains("private var _level int32", rendered, StringComparison.Ordinal)
        Assert.Contains("private var _level2 int32", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func FieldWithInitializer_CarriesInitializerToBackingField() {
        let rendered = Render(`
namespace Corpus.Issue1907
{
    public class ClampedGauge
    {
        public int Level { get; set => field = value < 0 ? 0 : value; } = 5;
    }
}
`)
        Assert.Contains("private var _level int32 = 5", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func AutoPropertyInitializer_CarriesInitializerToBackingField() {
        let rendered = Render(`
namespace Corpus.Issue1907
{
    public class Settings
    {
        public Value Current { get; set; } = new Value();
    }

    public class Value { }
}
`)
        Assert.Contains("private var _current Value = Value()", rendered, StringComparison.Ordinal)
        Assert.Contains("prop Current Value", rendered, StringComparison.Ordinal)
        Assert.Contains("return _current", rendered, StringComparison.Ordinal)
        Assert.Contains("_current = value", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func StaticFieldKeywordProperty_GetsStaticBackingField() {
        let rendered = Render(`
namespace Corpus.Issue1907
{
    public class Config
    {
        public static string Name { get => field ??= "x"; }
    }
}
`)
        Assert.Contains("shared", rendered, StringComparison.Ordinal)
        Assert.Contains("private var _name string?", rendered, StringComparison.Ordinal)
        Assert.Contains("if _name == nil", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
