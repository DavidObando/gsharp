// <copyright file="Issue2167TransitiveNullabilityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import Xunit

/// Translator-fidelity tests for issue #2167: in a nullable-<em>oblivious</em>
/// compilation the whole-program taint analysis
/// ((cref:ObliviousNullabilityAnalyzer)) must be TRANSITIVE /
/// INTERPROCEDURAL, so a `T?` value that flows into a sink cs2gs would
/// otherwise type as non-null `T` promotes that sink to `T?`. This
/// covers two canonical flows from Oahu.SystemManagement:
/// 1. <b>Local-type widening</b> — a `var` local whose initializer is non-null but which is later
/// assigned a nullable value takes the JOIN over all assignments (`string?`).
/// 2. <b>Interprocedural return promotion</b> — a property / method whose body returns the result of
/// calling a method with a nullable return type is itself promoted to `T?` (the callee's return taint
/// flows to the caller's return through the call edge).
/// The analysis is gated to oblivious compilations, so a nullable-<em>enabled</em>
/// compilation is untouched.
open class Issue2167TransitiveNullabilityTranslationTests {
    @Fact
    func Oblivious_VarLocal_LaterAssignedNullableValue_IsPromotedToNullable() {
        // `var id = String.Empty` infers a non-null `string` from the initializer,
        // but `id = mo.ToString()` assigns a `string?` (`object.ToString()` is
        // declared `string?`). The local's emitted type is the JOIN over the
        // initializer AND every assignment, so it must be `string?`; otherwise
        // gsc rejects the `string? -> string` assignment (GS0156).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public string GetId(object mo)
        {
            var id = System.String.Empty;
            id = mo.ToString();
            return id;
        }
    }
}`)
        Assert.Contains("var id string? =", printed)
    }

    @Fact
    func Oblivious_VarLocal_OnlyNonNullAssignments_StaysNonNull() {
        // Precision guard: a `var` local that is only ever assigned non-null
        // values keeps its inferred non-null type (no spurious `?`).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public string GetId()
        {
            var id = System.String.Empty;
            id = "x";
            return id;
        }
    }
}`)
        Assert.DoesNotContain("string?", printed)
    }

    @Fact
    func Oblivious_PropertyReturningNullableReturningCall_IsPromotedToNullable() {
        // `InstallDate` returns `ConvertToDateTime(...)`, whose OWN return is
        // nullable (it returns `s?.Trim()`). Knowing `InstallDate` must be
        // `string?` requires analyzing the CALLEE's return type — the
        // interprocedural edge. Without it gsc reports GS0156 on the return.
        let printed = TranslateOblivious(`
namespace Demo
{
    public static class C
    {
        public static string InstallDate
        {
            get
            {
                return ConvertToDateTime("x");
            }
        }

        private static string ConvertToDateTime(string s)
        {
            return s?.Trim();
        }
    }
}`)
        Assert.Contains("prop InstallDate string?", printed)
        Assert.Contains("func ConvertToDateTime(s string?) string?", printed)
    }

    @Fact
    func Oblivious_MethodReturningNullableReturningCall_IsPromotedToNullable() {
        // The same interprocedural return propagation for a METHOD sink: a method
        // whose body returns a call to a nullable-returning method must itself be
        // `string?`. Iterated to a fixpoint, promoting the callee promotes the
        // caller.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public string Outer()
        {
            return Inner("x");
        }

        private string Inner(string s)
        {
            return s?.Trim();
        }
    }
}`)
        Assert.Contains("func Outer() string?", printed)
        Assert.Contains("func Inner(s string?) string?", printed)
    }

    @Fact
    func Oblivious_PropertyForwardingTaintedProperty_IsNotPromotedThroughCallOnlyEdge() {
        // Guardrail (issue #1354 / #2157): only CALL returns are followed
        // interprocedurally for a property sink. `Work => Make()` returns a
        // (transitively-nullable) method call, so `Work` is promoted to
        // `string?`. But `Forward => Work` merely FORWARDS the property `Work`
        // (not a call), so `Forward` keeps its declared non-null `string` type
        // and relies on the null-forgiveness `!!` pass, preserving the property
        // contract. Promoting every forwarder would regress #1354's golden
        // `OperationTask => Work` behavior.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        private string Make() { return null; }
        public string Work => Make();
        public void Guard() { if (Work == null) { } }
        public string Forward => Work;
    }
}`)
        Assert.Contains("prop Work string?", printed)
        Assert.Contains("prop Forward string ", printed)
        Assert.DoesNotContain("prop Forward string?", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
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
