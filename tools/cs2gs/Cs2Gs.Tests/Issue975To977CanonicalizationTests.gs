// <copyright file="Issue975To977CanonicalizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Canonicalization tests for the three L4-discovered compiler gaps that are now
/// resolved on the compiler side (ADR-0115 §B.4/§B.28/§B.30, §G):
/// - #975 — an interpolated string in a `: base(...)` constructor argument is emitted directly (no
/// bare-parameter forward needed).
/// - #976 — a `struct` keeps its interface clause (`struct Money : IEquatable[Money]`).
/// - #977 — a BCL method invoked with an inline `out var x` is emitted inline (no pre-declared `&x`
/// workaround needed).
/// The translator already produces these canonical forms for canonical-capable
/// C#; these tests lock that in so a regression to the former workaround forms
/// is caught. Each printed form additionally round-trip-parses with the real
/// G# parser via (cref:Translate).
open class Issue975To977CanonicalizationTests {
    /// #975 (ADR-0115 §B.28): an interpolated string in `: base(...)` arg
    /// position is emitted directly into the base initializer — the canonical
    /// `init(params) : base($"…")` form — now that the emitter no longer
    /// ICEs (GS9998) on it.
    @Fact
    func InterpolatedString_InBaseInitializer_EmittedDirectly() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;

    public sealed class ShortStockException : Exception
    {
        public ShortStockException(int n) : base($"only {n} left") { }
    }
}`)
        Assert.Contains("init(n int32) : base(\"only $$n left\") {", printed)
    }

    /// #976 (ADR-0115 §B.4): a `struct` that implements an interface keeps
    /// its interface clause (`struct S : I[…]`) now that the parser accepts
    /// a struct base clause (struct naming a class base is rejected with
    /// GS0382, but an interface clause is legal).
    @Fact
    func Struct_ImplementingInterface_KeepsInterfaceClause() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System;

    public struct Money : IEquatable<Money>
    {
        public int Cents;

        public Money(int cents)
        {
            Cents = cents;
        }

        public bool Equals(Money other) => Cents == other.Cents;

        public override int GetHashCode() => Cents;
    }
}`)
        Assert.Contains("struct Money : IEquatable[Money] {", printed)
        Assert.Contains("init(cents int32)", printed)
    }

    /// #977 (ADR-0115 §B.30): a BCL method (`Dictionary.TryGetValue`)
    /// invoked with an inline `out var x` declaration is emitted inline as
    /// `out var x` — the canonical form — now that BCL overload resolution
    /// accepts it (no pre-declared `&x` workaround).
    @Fact
    func BclMethod_WithInlineOutVar_EmittedInline() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;

    public static class Lookup
    {
        public static int Get(Dictionary<string, int> table, string key)
        {
            if (table.TryGetValue(key, out var value))
            {
                return value;
            }

            return 0;
        }
    }
}`)
        Assert.Contains("if table.TryGetValue(key, out var value) {", printed)
        Assert.DoesNotContain("&value", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let (printed, _) = Translate(source)
            return printed
        }

        private func Translate(source string)(Printed string, Context TranslationContext) {
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
            return (printed, context)
        }
    }
}
