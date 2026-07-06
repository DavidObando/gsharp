// <copyright file="Issue2167TransitiveNullabilityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #2167: in a nullable-<em>oblivious</em>
/// compilation the whole-program taint analysis
/// (<see cref="ObliviousNullabilityAnalyzer"/>) must be TRANSITIVE /
/// INTERPROCEDURAL, so a <c>T?</c> value that flows into a sink cs2gs would
/// otherwise type as non-null <c>T</c> promotes that sink to <c>T?</c>. This
/// covers two canonical flows from Oahu.SystemManagement:
/// <list type="number">
/// <item><description><b>Local-type widening</b> — a <c>var</c> local whose
/// initializer is non-null but which is later assigned a nullable value takes
/// the JOIN over all assignments (<c>string?</c>).</description></item>
/// <item><description><b>Interprocedural return promotion</b> — a property /
/// method whose body returns the result of calling a method with a nullable
/// return type is itself promoted to <c>T?</c> (the callee's return taint flows
/// to the caller's return through the call edge).</description></item>
/// </list>
/// The analysis is gated to oblivious compilations, so a nullable-<em>enabled</em>
/// compilation is untouched.
/// </summary>
public class Issue2167TransitiveNullabilityTranslationTests
{
    [Fact]
    public void Oblivious_VarLocal_LaterAssignedNullableValue_IsPromotedToNullable()
    {
        // `var id = String.Empty` infers a non-null `string` from the initializer,
        // but `id = mo.ToString()` assigns a `string?` (`object.ToString()` is
        // declared `string?`). The local's emitted type is the JOIN over the
        // initializer AND every assignment, so it must be `string?`; otherwise
        // gsc rejects the `string? -> string` assignment (GS0156).
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("var id string? =", printed);
    }

    [Fact]
    public void Oblivious_VarLocal_OnlyNonNullAssignments_StaysNonNull()
    {
        // Precision guard: a `var` local that is only ever assigned non-null
        // values keeps its inferred non-null type (no spurious `?`).
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public string GetId()
        {
            var id = System.String.Empty;
            id = ""x"";
            return id;
        }
    }
}");

        Assert.DoesNotContain("string?", printed);
    }

    [Fact]
    public void Oblivious_PropertyReturningNullableReturningCall_IsPromotedToNullable()
    {
        // `InstallDate` returns `ConvertToDateTime(...)`, whose OWN return is
        // nullable (it returns `s?.Trim()`). Knowing `InstallDate` must be
        // `string?` requires analyzing the CALLEE's return type — the
        // interprocedural edge. Without it gsc reports GS0156 on the return.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public static class C
    {
        public static string InstallDate
        {
            get
            {
                return ConvertToDateTime(""x"");
            }
        }

        private static string ConvertToDateTime(string s)
        {
            return s?.Trim();
        }
    }
}");

        Assert.Contains("prop InstallDate string?", printed);
        Assert.Contains("func ConvertToDateTime(s string?) string?", printed);
    }

    [Fact]
    public void Oblivious_MethodReturningNullableReturningCall_IsPromotedToNullable()
    {
        // The same interprocedural return propagation for a METHOD sink: a method
        // whose body returns a call to a nullable-returning method must itself be
        // `string?`. Iterated to a fixpoint, promoting the callee promotes the
        // caller.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public string Outer()
        {
            return Inner(""x"");
        }

        private string Inner(string s)
        {
            return s?.Trim();
        }
    }
}");

        Assert.Contains("func Outer() string?", printed);
        Assert.Contains("func Inner(s string?) string?", printed);
    }

    [Fact]
    public void Oblivious_PropertyForwardingTaintedProperty_IsNotPromotedThroughCallOnlyEdge()
    {
        // Guardrail (issue #1354 / #2157): only CALL returns are followed
        // interprocedurally for a property sink. `Work => Make()` returns a
        // (transitively-nullable) method call, so `Work` is promoted to
        // `string?`. But `Forward => Work` merely FORWARDS the property `Work`
        // (not a call), so `Forward` keeps its declared non-null `string` type
        // and relies on the null-forgiveness `!!` pass, preserving the property
        // contract. Promoting every forwarder would regress #1354's golden
        // `OperationTask => Work` behavior.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        private string Make() { return null; }
        public string Work => Make();
        public void Guard() { if (Work == null) { } }
        public string Forward => Work;
    }
}");

        Assert.Contains("prop Work string?", printed);
        Assert.Contains("prop Forward string ", printed);
        Assert.DoesNotContain("prop Forward string?", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
