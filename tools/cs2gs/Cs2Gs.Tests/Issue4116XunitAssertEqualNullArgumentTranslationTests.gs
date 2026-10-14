// <copyright file="Issue4116XunitAssertEqualNullArgumentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #4116 (split from #4045's #2745 residual runtime failure,
/// `Issue2745OptionalParameterMetadataEmitTests`, "NRE while checking
/// reflected defaults"): `Assert.Equal<T>(T expected, T actual)` /
/// `Assert.NotEqual<T>(T, T)` carry no non-null constraint on
/// `T` in xunit's own signature — comparing a value against a
/// legitimately-null expected/actual result is exactly the point of these
/// overloads (e.g. asserting a reflected `ParameterInfo.DefaultValue`
/// equals `null` for a `string? = nil`-defaulted
/// parameter).
///
/// `IsXunitNullAssertionArgument` already exempted
/// `Assert.Null`/`Assert.NotNull` arguments from gsc's oblivious-
/// forwarding bridge (which otherwise forces a G# `!!` runtime
/// assertion whenever a nullable-oblivious value flows into an apparently
/// non-null sink), but did not exempt `Assert.Equal`/
/// `Assert.NotEqual` — so a helper like
/// `AssertDefault(ParameterInfo parameter, object expected) =>
/// Assert.Equal(expected, parameter.DefaultValue);`, called once with a
/// literal `null` expected value, translated to
/// `Assert.Equal(expected!!, parameter.DefaultValue!!)` — throwing an
/// NRE on the exact call the test exists to prove doesn't throw.
open class Issue4116XunitAssertEqualNullArgumentTranslationTests {
    @Fact
    func AssertEqual_WithLiteralNullArgument_IsNotForcedNonNull() {
        let rendered = Render(`
using System;
using Xunit;

public static class Probe
{
    public static void CheckDefault(object expected, object actual)
    {
        Assert.Equal(expected, actual);
    }

    public static void Run()
    {
        CheckDefault(null, null);
    }
}
`)
        Assert.DoesNotContain("Assert.Equal(expected!!", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("actual!!)", rendered, StringComparison.Ordinal)
        Assert.Contains("Assert.Equal(expected, actual)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func AssertNotEqual_WithLiteralNullArgument_IsNotForcedNonNull() {
        let rendered = Render(`
using System;
using Xunit;

public static class Probe
{
    public static void CheckDifferent(object expected, object actual)
    {
        Assert.NotEqual(expected, actual);
    }

    public static void Run()
    {
        CheckDifferent(null, "x");
    }
}
`)
        Assert.DoesNotContain("Assert.NotEqual(expected!!", rendered, StringComparison.Ordinal)
        Assert.Contains("Assert.NotEqual(expected, actual)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func AssertContains_WithObliviouslyPromotedArgument_StaysForcedNonNull() {
        // Control: Assert.Contains<T>(T expected, IEnumerable<T> collection)
        // shares Assert.Equal's generic two-argument shape (an unconstrained
        // T the general oblivious-forwarding bridge treats as non-null) but
        // is NOT in the Null/NotNull/Equal/NotEqual exemption, so it must
        // keep the existing forced-non-null behavior for an oblivious value
        // promoted nullable by usage evidence (called once with a literal
        // `null`) — proving the exemption is scoped to exactly those four
        // method names, not to every generic-comparison-shaped Xunit method.
        let rendered = Render(`
using System;
using Xunit;

public static class Probe
{
    private static void CheckContains(object expected, object[] collection)
    {
        Assert.Contains(expected, collection);
    }

    public static void Run()
    {
        CheckContains(null, new object[0]);
    }
}
`)
        Assert.Contains("expected!!", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func CustomAssertEqual_InANamespaceOnlyEndingInXunit_StaysForcedNonNull() {
        // Control (Copilot review on #4209): the namespace check must pin
        // the EXACT top-level `Xunit` namespace (`global::Xunit`), not
        // merely a namespace whose LAST segment happens to be named
        // "Xunit". `Company.Xunit.Assert.Equal` is an unrelated,
        // non-exempted method that just happens to share the name/shape.
        //
        // IMPORTED (a genuinely separately-compiled, referenced assembly —
        // not a same-compilation declaration): gsc's oblivious-PROMOTION
        // mechanism only ever rewrites a SAME-compilation declaration's own
        // parameter type, so a same-file "Company.Xunit.Assert.Equal" would
        // itself get silently promoted to `object?` by usage evidence,
        // masking the exact bug this control exists to catch. An imported
        // method's declared (non-nullable, explicitly `#nullable enable`)
        // parameter can never be rewritten that way, so its own contract is
        // what decides — and a mutant that matches on the namespace's leaf
        // name alone is caught here.
        let customAssertLibrary = CompileLibraryReference(`
#nullable enable
namespace Company.Xunit
{
    public static class Assert
    {
        public static void Equal(object expected, object actual)
        {
        }
    }
}
`)
        let rendered = Render(`
using Company.Xunit;

public static class Probe
{
    private static void CheckDefault(object expected, object actual)
    {
        Assert.Equal(expected, actual);
    }

    public static void Run()
    {
        CheckDefault(null, null);
    }
}
`, additionalReferences: []MetadataReference{customAssertLibrary})
        // Round-trip binding is skipped here: it would require also
        // resolving the compiled "Company.Xunit.Assert" library on gsc's
        // OWN (separate) ReferenceResolver, which this control's narrow
        // purpose — proving the printed text still forces `!!` — does not
        // warrant.
        Assert.Contains("expected!!", rendered, StringComparison.Ordinal)
    }

    shared {
        private func CompileLibraryReference(source string) MetadataReference {
            let syntaxTree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let compilation = CSharpCompilation.Create(
                "Issue4116CustomXunitLibrary",
                []SyntaxTree{syntaxTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            stream.Position = 0
            return MetadataReference.CreateFromStream(stream)
        }

        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string, additionalReferences[]?MetadataReference = nil) string {
            let references IReadOnlyList[MetadataReference]? = if additionalReferences == nil {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader.RuntimeReferences().Concat(additionalReferences).ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)}, references)
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
            return GSharpPrinter.Print(unit)
        }
    }
}
