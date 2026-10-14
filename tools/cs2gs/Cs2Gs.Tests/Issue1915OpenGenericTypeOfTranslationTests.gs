// <copyright file="Issue1915OpenGenericTypeOfTranslationTests.cs" company="GSharp">
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

/// Issue #1915 (sub-bug b): `typeof(List<>)` (an unbound generic
/// operand, `GenericNameSyntax.IsUnboundGenericName == true`) originally
/// translated to the bare generic-definition name `typeof(List)` — that
/// half was correct at the time (G# had no bracket syntax for an open
/// generic, so the bare name was the only spelling available), but gsc's OWN
/// binder could not resolve a bare imported-CLR-generic name at all (it only
/// tried the exact, non-generic reflection name), so the printed G# failed
/// to compile with GS0113 "Type 'List' doesn't exist." Fixed on the gsc side:
/// a bare simple name inside `typeof(...)` now falls back to an
/// arity-suffixed (``1`, ``2`, …) reflection lookup across the
/// file's imports and binds to the CLR open generic type definition when
/// exactly one match exists.
///
/// Issue #2012 (S1): the bare-name fallback stays ambiguous (GS0113) for
/// same-base-name multi-arity BCL families (`Func`, `Action`, …),
/// so #1989/#2011 added an explicit-arity spelling via `_` placeholder
/// bracket type arguments (`typeof(Name[_, ...])`). cs2gs now emits
/// THAT canonical form for every unbound generic — carrying the arity C#
/// derives from comma count the same way — rather than the bare name, so the
/// translated output round-trips correctly for every family, not just
/// single-arity ones.
open class Issue1915OpenGenericTypeOfTranslationTests {
    @Fact
    func UnboundGenericType_TypeOf_TranslatesToUnderscorePlaceholderAndRoundTrips() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(List<>);
    }
}`)
        Assert.Contains("typeof(List[_])", printed)
    }

    @Fact
    func UnboundGenericType_TwoArity_TranslatesToUnderscorePlaceholderAndRoundTrips() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Dictionary<,>);
    }
}`)
        Assert.Contains("typeof(Dictionary[_, _])", printed)
    }

    @Fact
    func QualifiedUnboundGenericType_PreservesQualifierAndRoundTrips() {
        let printed = TranslateUnit(`
using System;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(System.Threading.Tasks.ValueTask<>);
    }
}`)
        Assert.Contains("typeof(System.Threading.Tasks.ValueTask[_])", printed)
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
            Assert.Empty(context.Diagnostics)
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
