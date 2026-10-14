// <copyright file="Issue1182OptionalDefaultParameterTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1182 / #914: an optional parameter whose default is the zero value
/// (`= default`, `= default(T)`, or `= null`) was previously
/// silently dropped, turning the optional parameter into a required one and
/// producing GS0144 ("requires N arguments") at call sites. cs2gs now emits the
/// explicit zero default: `default(T)` for a non-nullable value type (bare
/// `default` is rejected by gsc with GS0265), and `nil` for a reference
/// or nullable value type. The default is preserved on ordinary `func`
/// parameters and on an explicit constructor parameter.
open class Issue1182OptionalDefaultParameterTranslationTests {
    @Fact
    func ValueTypeDefault_OnFunc_RendersAsTypedDefault() {
        let rendered = Render()
        // `TimeSpan span = default(TimeSpan)` survives as a typed default
        // (gsc rejects a bare `= default`).
        Assert.Contains("span TimeSpan = default(TimeSpan)", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ValueTypeDefault_OnExplicitConstructor_RendersAsTypedDefault() {
        let rendered = Render()
        // The explicit constructor stays explicit to preserve its parameter and
        // property ABI; its optional default still lets callers write `ChapterInfo()`.
        Assert.Contains("init(offsetFromBeginning TimeSpan = default(TimeSpan))", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ReferenceAndNullableDefaults_RenderAsNil() {
        let rendered = Render()
        // A reference-type `= null` default is null-tainted, so under a
        // nullable-oblivious compilation issue #2113 promotes it to `string?`; a
        // nullable value-type `= null` is `int32?`. Both render `= nil`.
        Assert.Contains("name string? = nil", rendered, StringComparison.Ordinal)
        Assert.Contains("count int32? = nil", rendered, StringComparison.Ordinal)
    }

    @Fact
    func LiteralDefault_StillRendersAsLiteral() {
        let rendered = Render()
        Assert.Contains("n int32 = 3", rendered, StringComparison.Ordinal)
    }

    @Fact
    func TranslatedOutput_ContainsNoBareDefault() {
        let rendered = Render()
        // A bare `= default` (GS0265) must never appear; it is always typed or `nil`.
        Assert.DoesNotContain("= default${Environment.NewLine}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("= default)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("= default ", rendered, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `
using System;

namespace Corpus.Issue1182
{
    public class ChapterInfo
    {
        public ChapterInfo(TimeSpan offsetFromBeginning = default)
        {
            this.Offset = offsetFromBeginning;
        }

        public TimeSpan Offset { get; }
    }

    public class Defaults
    {
        public void ValueTypeDefault(TimeSpan span = default(TimeSpan)) { }

        public void ReferenceDefault(string name = null) { }

        public void NullableValueDefault(int? count = null) { }

        public void IntLiteralDefault(int n = 3) { }
    }
}
`

        private func Render() string {
            let (unit, _) = Translate()
            return GSharpPrinter.Print(unit)
        }

        private func Translate()(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("ChapterInfo.cs", Source)})
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
            return (unit, context)
        }
    }
}
