// <copyright file="Issue4722ConvertedStoreReportingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit
import Xunit.Sdk

/// An assertion on an operator's input does not report its independently
/// asserted nullable result. Both sites must remain visible (#4722).
open class Issue4722ConvertedStoreReportingTests {
    @Theory
    @InlineData("value!")
    @InlineData("Read(value)!")
    @InlineData("checked(Read(value)!)")
    @InlineData("unchecked(Read(value)!)")
    func AssertedInputAndNewConvertedResult_ReportDistinctSites(expression string) {
        let source = (`#nullable enable
using System.Collections.Generic;
public static class C
{
    private static string? Read(string? value) => value;
    public static void Add(List<ReportBox> list, string? value)
    {
        list.Add(` + "$expression" + `);
    }
}`)
        let directory = Path.Combine(AppContext.BaseDirectory, "issue4722-reporting", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            const nativeSource = `#nullable enable
public sealed class ReportBox
{
    public static implicit operator ReportBox?(string value)
        => value == "nil" ? null : new ReportBox();
}`
            let native = CSharpProjectLoader.LoadInMemory(
                [](string, nativeSource string){("NativeOperator.cs", nativeSource)},
                assemblyName: "NativeReporting" + Guid.NewGuid().ToString("N")
            )
            Assert.True(native.BoundWithoutErrors, string.Join(Environment.NewLine, native.ErrorDiagnostics))
            let fixture = Path.Combine(directory, native.Compilation.AssemblyName + ".dll")
            let emitted = native.Compilation.Emit(fixture)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let assembly = EmittedFixture.Load(fixture)
            Assert.True(AssemblyLoadContext.GetLoadContext(assembly)!!.IsCollectible)
            Assert.Empty(assembly.Location)
            let conversion MethodInfo? = assembly.GetType("ReportBox")!!.GetMethod("op_Implicit")
            Assert.NotNull(conversion)
            let nullability = NullabilityInfoContext()
            Assert.Equal(NullabilityState.Nullable, nullability.Create(conversion!!.ReturnParameter).ReadState)
            Assert.Equal(
                NullabilityState.NotNull,
                nullability.Create(Assert.Single(conversion!!.GetParameters())).ReadState
            )
            Assert.Null(conversion!!.Invoke(nil, []object{"nil"}))
            Assert.NotNull(conversion!!.Invoke(nil, []object{"present"}))
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Probe.cs", source)},
                CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(fixture)).ToArray()
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            let sites = context
                .Diagnostics
                .Where(
                (
                    site TranslationDiagnostic
                ) -> site.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            )
                .ToArray()
            Assert.DoesNotContain(
                context.Diagnostics,
                (site TranslationDiagnostic) -> site.Severity == TranslationSeverity.Unsupported
            )
            var operand = if expression == "value!" {
                "value!!"
            } else {
                "Read(value)!!"
            }
            if expression.StartsWith("checked", StringComparison.Ordinal) || expression.StartsWith(
                "unchecked",
                StringComparison.Ordinal
            ) {
                operand = expression.Substring(0, expression.IndexOf('(')) + "(" + operand + ")!!"
            }
            Assert.Contains("ReportBox?(" + operand + ")!!", printed)
            Assert.Equal(2, sites.Length)
            let input = Assert.Single(
                sites,
                (site TranslationDiagnostic) -> site.Message!!.StartsWith("kind=forgiven,", StringComparison.Ordinal)
            )
            let result = Assert.Single(
                sites,
                (site TranslationDiagnostic) -> site.Message!!.StartsWith(
                    "kind=constructed-generic-member",
                    StringComparison.Ordinal
                )
            )
            Assert.All(
                sites,
                (site TranslationDiagnostic) -> {
                    Assert.Equal(TranslationSeverity.Warning, site.Severity)
                    Assert.Equal("Probe.cs", site.Location!!.GetLineSpan().Path)
                    Assert.Equal(7, site.Location!!.GetLineSpan().StartLinePosition.Line)
                    Assert.Contains("target=List<ReportBox>.Add(ReportBox) parameter 'item'", site.Message)
                }
            )
            Assert.Contains("slot-type=ReportBox (NotAnnotated)", result.Message)
            Assert.Equal(
                if expression.EndsWith(')') {
                    "Read(value)!"
                } else {
                    expression
                },
                input.Location!!.SourceTree!!.GetText().ToString(input.Location!!.SourceSpan)
            )
            Assert.Equal(expression, result.Location!!.SourceTree!!.GetText().ToString(result.Location!!.SourceSpan))
            Assert.NotEqual(input.Message, result.Message)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
        Assert.False(Directory.Exists(directory))
    }

    @Theory
    @InlineData("value!")
    @InlineData("(value!)")
    @InlineData("((value!))")
    func UnchangedAlreadyAssertedValue_ReportsOnlyItsAuthoredInput(expression string) {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", (`#nullable enable
using System.Collections.Generic;
public static class C
{
    public static void Add(List<string> list, string? value) => list.Add(` + "$expression" + `);
}`))})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("value!!", printed)
        Assert.DoesNotContain("value!!!!", printed)
        let site = Assert.Single(
            context.Diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
        Assert.StartsWith("kind=forgiven,constructed-generic-member", site.Message, StringComparison.Ordinal)
        Assert.Equal(4, site.Location!!.GetLineSpan().StartLinePosition.Line)
    }

    @Fact
    func NativeReportingFixture_IsDeletedWhenBindingAssertionFails() {
        let root = Path.Combine(AppContext.BaseDirectory, "issue4722-reporting")
        Directory.CreateDirectory(root)
        let before = Directory.GetDirectories(root).OrderBy((path string) -> path).ToArray()
        let failure = Assert.ThrowsAny[XunitException](
            () -> this.AssertedInputAndNewConvertedResult_ReportDistinctSites("missing!")
        )
        Assert.Contains("missing", failure.Message)
        Assert.Equal(before, Directory.GetDirectories(root).OrderBy((path string) -> path).ToArray())
    }
}
