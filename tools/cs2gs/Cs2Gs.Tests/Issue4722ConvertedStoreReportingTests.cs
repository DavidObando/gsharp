// <copyright file="Issue4722ConvertedStoreReportingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// An assertion on an operator's input does not report its independently
/// asserted nullable result. Both sites must remain visible (#4722).
/// </summary>
public class Issue4722ConvertedStoreReportingTests
{
    [Theory]
    [InlineData("value!")]
    [InlineData("Read(value)!")]
    [InlineData("checked(Read(value)!)")]
    [InlineData("unchecked(Read(value)!)")]
    public void AssertedInputAndNewConvertedResult_ReportDistinctSites(string expression)
    {
        string source = $$"""
            #nullable enable
            using System.Collections.Generic;
            public static class C
            {
                private static string? Read(string? value) => value;
                public static void Add(List<ReportBox> list, string? value)
                {
                    list.Add({{expression}});
                }
            }
            """;
        string directory = Path.Combine(
            AppContext.BaseDirectory, "issue4722-reporting", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            const string nativeSource = """
                #nullable enable
                public sealed class ReportBox
                {
                    public static implicit operator ReportBox?(string value)
                        => value == "nil" ? null : new ReportBox();
                }
                """;
            LoadedCSharpProject native = CSharpProjectLoader.LoadInMemory(
                new[] { ("NativeOperator.cs", nativeSource) },
                assemblyName: "NativeReporting" + Guid.NewGuid().ToString("N"));
            Assert.True(native.BoundWithoutErrors, string.Join(Environment.NewLine, native.ErrorDiagnostics));
            string fixture = Path.Combine(directory, native.Compilation.AssemblyName + ".dll");
            var emitted = native.Compilation.Emit(fixture);
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            Assembly assembly = EmittedFixture.Load(fixture);
            Assert.True(AssemblyLoadContext.GetLoadContext(assembly).IsCollectible);
            Assert.Empty(assembly.Location);
            MethodInfo conversion = assembly.GetType("ReportBox").GetMethod("op_Implicit");
            Assert.NotNull(conversion);
            var nullability = new NullabilityInfoContext();
            Assert.Equal(NullabilityState.Nullable, nullability.Create(conversion.ReturnParameter).ReadState);
            Assert.Equal(NullabilityState.NotNull, nullability.Create(Assert.Single(conversion.GetParameters())).ReadState);
            Assert.Null(conversion.Invoke(null, new object[] { "nil" }));
            Assert.NotNull(conversion.Invoke(null, new object[] { "present" }));

            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
                new[] { ("Probe.cs", source) },
                CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(fixture)).ToArray());
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
            LoadedDocument document = Assert.Single(project.Documents);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            TranslationDiagnostic[] sites = context.Diagnostics
                .Where(site => site.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId).ToArray();
            Assert.DoesNotContain(context.Diagnostics, site => site.Severity == TranslationSeverity.Unsupported);
            string operand = expression == "value!" ? "value!!" : "Read(value)!!";
            if (expression.StartsWith("checked", StringComparison.Ordinal) || expression.StartsWith("unchecked", StringComparison.Ordinal))
            {
                operand = expression.Substring(0, expression.IndexOf('(')) + "(" + operand + ")!!";
            }

            Assert.Contains("ReportBox?(" + operand + ")!!", printed);
            Assert.Equal(2, sites.Length);
            TranslationDiagnostic input = Assert.Single(sites, site => site.Message.StartsWith("kind=forgiven,", StringComparison.Ordinal));
            TranslationDiagnostic result = Assert.Single(sites, site => site.Message.StartsWith("kind=constructed-generic-member", StringComparison.Ordinal));
            Assert.All(sites, site =>
            {
                Assert.Equal(TranslationSeverity.Warning, site.Severity);
                Assert.Equal("Probe.cs", site.Location.GetLineSpan().Path);
                Assert.Equal(7, site.Location.GetLineSpan().StartLinePosition.Line);
                Assert.Contains("target=List<ReportBox>.Add(ReportBox) parameter 'item'", site.Message);
            });
            Assert.Contains("slot-type=ReportBox (NotAnnotated)", result.Message);
            Assert.Equal(expression.EndsWith(')') ? "Read(value)!" : expression, input.Location.SourceTree.GetText().ToString(input.Location.SourceSpan));
            Assert.Equal(expression, result.Location.SourceTree.GetText().ToString(result.Location.SourceSpan));
            Assert.NotEqual(input.Message, result.Message);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }

        Assert.False(Directory.Exists(directory));
    }

    [Theory]
    [InlineData("value!")]
    [InlineData("(value!)")]
    [InlineData("((value!))")]
    public void UnchangedAlreadyAssertedValue_ReportsOnlyItsAuthoredInput(string expression)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Probe.cs", $$"""
                #nullable enable
                using System.Collections.Generic;
                public static class C
                {
                    public static void Add(List<string> list, string? value) => list.Add({{expression}});
                }
                """),
        });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains("value!!", printed);
        Assert.DoesNotContain("value!!!!", printed);
        TranslationDiagnostic site = Assert.Single(
            context.Diagnostics, diagnostic => diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId);
        Assert.StartsWith("kind=forgiven,constructed-generic-member", site.Message, StringComparison.Ordinal);
        Assert.Equal(4, site.Location.GetLineSpan().StartLinePosition.Line);
    }

    [Fact]
    public void NativeReportingFixture_IsDeletedWhenBindingAssertionFails()
    {
        string root = Path.Combine(AppContext.BaseDirectory, "issue4722-reporting");
        Directory.CreateDirectory(root);
        string[] before = Directory.GetDirectories(root).OrderBy(path => path).ToArray();
        var failure = Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            this.AssertedInputAndNewConvertedResult_ReportDistinctSites("missing!"));
        Assert.Contains("missing", failure.Message);
        Assert.Equal(before, Directory.GetDirectories(root).OrderBy(path => path).ToArray());
    }
}
