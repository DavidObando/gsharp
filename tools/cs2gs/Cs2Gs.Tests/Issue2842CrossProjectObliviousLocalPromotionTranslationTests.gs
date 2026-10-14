// <copyright file="Issue2842CrossProjectObliviousLocalPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Positive controls for issue #2842. PR #2860 fixed the actual defect by
/// reporting C# binding errors from `TranslateStage`; these fixtures pin
/// the already-correct local-declaration forgiveness path when the member binds
/// across nullable-oblivious and nullable-enabled project boundaries.
open class Issue2842CrossProjectObliviousLocalPromotionTranslationTests {
    @Fact
    func ObliviousDataTaintedInProject_ToObliviousCore_PreservesTaintThroughLocalReturn() {
        let data = LoadOblivious(DataWithInProjectTaint, "Data")
        let core = LoadOblivious(ConsumerSource, "Core", []MetadataReference{data.Compilation.ToMetadataReference()})
        let compilations = []CSharpCompilation{core.Compilation, data.Compilation}
        let printedData = TranslateProject(data, compilations)
        let printed = TranslateProject(core, compilations)
        TranslationTestValidation.AssertBinds(printed, printedData)
        let compact = Compact(printed)
        Assert.Contains("let reason = conversion.FailureReason!!", compact)
        Assert.Contains("return reason!!", compact)
    }

    @Fact
    func ObliviousDataTaintedInProject_ToNullableEnabledCore_KeepsLocalNonNullable() {
        let data = LoadOblivious(DataWithInProjectTaint, "Data")
        let core = LoadEnabled(ConsumerSource, "Core", []MetadataReference{data.Compilation.ToMetadataReference()})
        let compilations = []CSharpCompilation{core.Compilation, data.Compilation}
        let printedData = TranslateProject(data, compilations)
        let printed = TranslateProject(core, compilations)
        TranslationTestValidation.AssertBinds(printed, printedData)
        let compact = Compact(printed)
        Assert.Contains("let reason = conversion.FailureReason!!", compact)
        Assert.DoesNotContain("return reason!!", compact)
    }

    @Fact
    func ObliviousData_ToObliviousMidTaint_ToNullableEnabledApp_PreservesDistinctContracts() {
        const dataSource = `
namespace Data
{
    public class Conversion
    {
        public string FailureReason { get; set; }
    }
}`
        let data = LoadOblivious(dataSource, "Data")
        const midSource = `
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
}`
        let mid = LoadOblivious(midSource, "Mid", []MetadataReference{data.Compilation.ToMetadataReference()})
        const appSource = `
using Data;

namespace App
{
    public class Consumer
    {
        public string Read(Conversion conversion)
        {
            if (conversion is null)
            {
                return "";
            }

            string reason = conversion.FailureReason;
            return reason;
        }
    }
}`
        let app = LoadEnabled(
            appSource,
            "App",
            []MetadataReference{data.Compilation.ToMetadataReference(), mid.Compilation.ToMetadataReference()}
        )
        let compilations = []CSharpCompilation{app.Compilation, mid.Compilation, data.Compilation}
        let printedData = TranslateProject(data, compilations)
        let printedApp = TranslateProject(app, compilations)
        TranslationTestValidation.AssertBinds(printedApp, printedData)
        Assert.Contains("prop FailureReason string?", Compact(printedData))
        let compactApp = Compact(printedApp)
        Assert.Contains("func Read(conversion Conversion?)", compactApp)
        Assert.Contains("let reason = conversion.FailureReason!!", compactApp)
        Assert.DoesNotContain("conversion!!", compactApp)
        Assert.DoesNotContain("return reason!!", compactApp)
    }

    shared {
        private const DataWithInProjectTaint string = `
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
}`

        private const ConsumerSource string = `
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
}`

        private func LoadOblivious(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let project = LoadWithReferences(source, assemblyName, extraReferences)
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func LoadEnabled(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let diagnostics = compilation
                .GetDiagnostics()
                .Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
                .ToList()
            Assert.True(
                diagnostics.Count == 0,
                "$assemblyName should bind with no C# errors: " + string.Join(Environment.NewLine, diagnostics)
            )
            let document = LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree))
            return LoadedCSharpProject(compilation, []LoadedDocument{document}, Array.Empty[Diagnostic]())
        }

        private func LoadWithReferences(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]?
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                references,
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            return project
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations,
                repositoryCompilations: siblingCompilations
            )
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
