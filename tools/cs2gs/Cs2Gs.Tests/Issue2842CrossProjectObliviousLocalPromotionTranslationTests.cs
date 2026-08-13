// <copyright file="Issue2842CrossProjectObliviousLocalPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Positive controls for issue #2842. PR #2860 fixed the actual defect by
/// reporting C# binding errors from <c>TranslateStage</c>; these fixtures pin
/// the already-correct local-declaration forgiveness path when the member binds
/// across nullable-oblivious and nullable-enabled project boundaries.
/// </summary>
public class Issue2842CrossProjectObliviousLocalPromotionTranslationTests
{
    private const string DataWithInProjectTaint = @"
namespace Data
{
    public class Conversion
    {
        public string FailureReason { get; set; }

        public void ClearFailure()
        {
            FailureReason = null;
        }
    }
}";

    private const string ConsumerSource = @"
using Data;

namespace Core
{
    public class Consumer
    {
        public string Read(Conversion conversion)
        {
            string reason = conversion.FailureReason;
            return reason;
        }
    }
}";

    [Fact]
    public void ObliviousDataTaintedInProject_ToObliviousCore_PreservesTaintThroughLocalReturn()
    {
        LoadedCSharpProject data = LoadOblivious(DataWithInProjectTaint, "Data");
        LoadedCSharpProject core = LoadOblivious(
            ConsumerSource,
            "Core",
            new MetadataReference[] { data.Compilation.ToMetadataReference() });

        var compilations = new[] { core.Compilation, data.Compilation };
        string printedData = TranslateProject(data, compilations);
        string printed = TranslateProject(core, compilations);
        TranslationTestValidation.AssertBinds(printed, printedData);

        string compact = Compact(printed);
        Assert.Contains("let reason = conversion.FailureReason!!", compact);
        Assert.Contains("return reason!!", compact);
    }

    [Fact]
    public void ObliviousDataTaintedInProject_ToNullableEnabledCore_KeepsLocalNonNullable()
    {
        LoadedCSharpProject data = LoadOblivious(DataWithInProjectTaint, "Data");
        LoadedCSharpProject core = LoadEnabled(
            ConsumerSource,
            "Core",
            new MetadataReference[] { data.Compilation.ToMetadataReference() });

        var compilations = new[] { core.Compilation, data.Compilation };
        string printedData = TranslateProject(data, compilations);
        string printed = TranslateProject(core, compilations);
        TranslationTestValidation.AssertBinds(printed, printedData);

        string compact = Compact(printed);
        Assert.Contains("let reason = conversion.FailureReason!!", compact);
        Assert.DoesNotContain("return reason!!", compact);
    }

    [Fact]
    public void ObliviousData_ToObliviousMidTaint_ToNullableEnabledApp_PreservesDistinctContracts()
    {
        const string dataSource = @"
namespace Data
{
    public class Conversion
    {
        public string FailureReason { get; set; }
    }
}";
        LoadedCSharpProject data = LoadOblivious(dataSource, "Data");

        const string midSource = @"
using Data;

namespace Mid
{
    public static class ConversionTainter
    {
        public static void ClearFailure(Conversion conversion)
        {
            conversion.FailureReason = null;
        }
    }
}";
        LoadedCSharpProject mid = LoadOblivious(
            midSource,
            "Mid",
            new MetadataReference[] { data.Compilation.ToMetadataReference() });

        const string appSource = @"
using Data;

namespace App
{
    public class Consumer
    {
        public string Read(Conversion conversion)
        {
            if (conversion is null)
            {
                return """";
            }

            string reason = conversion.FailureReason;
            return reason;
        }
    }
}";
        LoadedCSharpProject app = LoadEnabled(
            appSource,
            "App",
            new MetadataReference[]
            {
                data.Compilation.ToMetadataReference(),
                mid.Compilation.ToMetadataReference(),
            });

        var compilations = new[] { app.Compilation, mid.Compilation, data.Compilation };
        string printedData = TranslateProject(data, compilations);
        string printedApp = TranslateProject(app, compilations);
        TranslationTestValidation.AssertBinds(printedApp, printedData);

        Assert.Contains("prop FailureReason string?", Compact(printedData));

        string compactApp = Compact(printedApp);
        Assert.Contains("func Read(conversion Conversion?)", compactApp);
        Assert.Contains("let reason = conversion!!.FailureReason!!", compactApp);
        Assert.DoesNotContain("return reason!!", compactApp);
    }

    private static LoadedCSharpProject LoadOblivious(
        string source,
        string assemblyName,
        IReadOnlyList<MetadataReference> extraReferences = null)
    {
        LoadedCSharpProject project = LoadWithReferences(source, assemblyName, extraReferences);
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        return project;
    }

    private static LoadedCSharpProject LoadEnabled(
        string source,
        string assemblyName,
        IReadOnlyList<MetadataReference> extraReferences = null)
    {
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();

        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        List<Diagnostic> diagnostics = compilation.GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToList();
        Assert.True(
            diagnostics.Count == 0,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, diagnostics));

        var document = new LoadedDocument(
            assemblyName + ".cs",
            tree,
            compilation.GetSemanticModel(tree));
        return new LoadedCSharpProject(compilation, new[] { document }, Array.Empty<Diagnostic>());
    }

    private static LoadedCSharpProject LoadWithReferences(
        string source,
        string assemblyName,
        IReadOnlyList<MetadataReference> extraReferences)
    {
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (assemblyName + ".cs", source) },
            references,
            assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static string TranslateProject(
        LoadedCSharpProject project,
        IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations,
            repositoryCompilations: siblingCompilations);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' },
            StringSplitOptions.RemoveEmptyEntries));
}
