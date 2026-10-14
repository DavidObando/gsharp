// <copyright file="Issue4262CrossProjectObliviousDelegateArgumentTests.cs" company="GSharp">
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
import System.Collections.Generic
import System.Linq
import Xunit

/// Regression tests for issue #4262: a nullable-ENABLED consumer project
/// (e.g. Oahu.Cli.App) calling into a nullable-OBLIVIOUS sibling project
/// (e.g. Oahu.Core) it references got a spurious `!!` on an
/// intentionally-nullable delegate ARGUMENT, even though the sibling's own
/// parameter is proven null-tainted (via `ObliviousNullabilityAnalyzer`'s
/// whole-program fixpoint, walking a call chain that ends in an
/// `if (convertAction != null)` guard) and is therefore genuinely safe
/// to pass `nil` to.
///
/// <b>Root cause</b>: (cref:ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol,
/// IReadOnlyList{CSharpCompilation}))
/// bailed out immediately whenever the ASKING compilation (the consumer's
/// own, e.g. Oahu.Cli.App) was nullable-ENABLED, before its sibling-walk loop
/// — which already correctly remaps into, and checks the obliviousness of,
/// EACH sibling independently — ever got a chance to run. Issue #2412's own
/// cross-project machinery therefore only ever fired when the CONSUMER's own
/// compilation was oblivious; a nullable-enabled consumer calling into an
/// oblivious sibling (Oahu's actual shape) always answered "not tainted",
/// forcing `CSharpToGSharpTranslator.TranslateArgumentValue`'s
/// `targetIsPromotedMigratedSibling` bridge to stay unset and the
/// ordinary "target requires non-null" bridge to fire instead.
///
/// <b>Fix</b>: the entry gate now bails only when NEITHER the asking
/// compilation NOR any sibling is oblivious — there being nothing an
/// oblivious-only fixpoint could ever find in that case. Every existing
/// (oblivious-consumer) cross-project scenario in
/// `Issue2412CrossProjectObliviousNullabilityTranslationTests` is
/// unaffected: an oblivious consumer already satisfied the old gate.
open class Issue4262CrossProjectObliviousDelegateArgumentTests {
    @Fact
    func NullableEnabledCaller_ObliviousTaintedDelegateParameter_PassThrough_NoSpuriousAssertion() {
        let (core, printedCore) = TranslateOblivious(ObliviousDelegateLibrarySource, "LibCore")
        const appSource = `
using LibCore;

namespace LibApp
{
    public class Caller
    {
        public void Execute(bool export)
        {
            ConvertDelegate<int>? convertAction = null;
            if (export)
            {
                convertAction = ctx => { };
            }

            new Job<int>().Run(1, convertAction);
        }
    }
}`
        let printedApp = TranslateEnabled(appSource, "LibApp", core)
        Assert.DoesNotContain("convertAction!!", printedApp)
        Assert.Contains("Job[int32]().Run(1, convertAction)", Compact(printedApp))
        TranslationTestValidation.AssertBinds(printedApp, printedCore)
    }

    @Fact
    func NullableEnabledCaller_ObliviousTaintedDelegateParameter_CapturedInNestedClosure_NoSpuriousAssertion() {
        // Mirrors the real Oahu shape more closely: the nullable delegate
        // local is captured by a nested lambda (`Task.Run`) rather than
        // forwarded directly, so the argument value cs2gs sees at the call
        // site is a CAPTURED local, not the outer parameter/local itself.
        let (core, printedCore) = TranslateOblivious(ObliviousDelegateLibrarySource, "LibCore")
        const appSource = `
using System.Threading.Tasks;
using LibCore;

namespace LibApp
{
    public class Caller
    {
        public Task Execute(bool export)
        {
            ConvertDelegate<int>? convertAction = null;
            if (export)
            {
                convertAction = ctx => { };
            }

            return Task.Run(() => new Job<int>().Run(1, convertAction));
        }
    }
}`
        let printedApp = TranslateEnabled(appSource, "LibApp", core)
        Assert.DoesNotContain("convertAction!!", printedApp)
        TranslationTestValidation.AssertBinds(printedApp, printedCore)
    }

    @Fact
    func NullableEnabledCaller_ObliviousParameterWithoutTaintEvidence_StillAssertsNonNull() {
        // Precision guard: the fix must not blanket-disable the bridge for
        // every oblivious cross-project delegate parameter — only one PROVEN
        // (by the sibling's own taint fixpoint) to accept null. A sibling
        // parameter with NO null-check anywhere still gets `!!` when a
        // genuinely nullable value from the enabled caller flows into it.
        const libCore = `
namespace LibCore
{
    public delegate void ConvertDelegate<T>(T ctx);

    public class Job<T>
    {
        public void Run(T ctx, ConvertDelegate<T> convertAction)
        {
            convertAction(ctx);
        }
    }
}`
        let (core, printedCore) = TranslateOblivious(libCore, "LibCore")
        const appSource = `
using LibCore;

namespace LibApp
{
    public class Caller
    {
        public void Execute(bool export)
        {
            ConvertDelegate<int>? convertAction = null;
            if (export)
            {
                convertAction = ctx => { };
            }

            new Job<int>().Run(1, convertAction);
        }
    }
}`
        let printedApp = TranslateEnabled(appSource, "LibApp", core)
        Assert.Contains("Job[int32]().Run(1, convertAction!!)", Compact(printedApp))
        TranslationTestValidation.AssertBinds(printedApp, printedCore)
    }

    @Fact
    func NullableEnabledCaller_ObliviousTaintedParamsElement_NoSpuriousAssertion() {
        // Same root cause, the params-ELEMENT sibling of the scalar-argument
        // bug above: `ObliviousNullabilityAnalyzer.IsParamsElementTainted`
        // (issue #3888) has the identical entry gate, reachable from
        // `TargetWillRemainNonNullableReference`'s variadic-carrier branch.
        const libCore = `
namespace LibCore
{
    public static class Combiner
    {
        public static string Build(params string[] parts) => string.Join("/", parts);

        // Seeds the params ELEMENT taint fixpoint: a nullable argument in
        // the expanded tail of a call within LibCore's own oblivious source.
        public static string BuildWithDefault(string extra) => Build(extra, null);
    }
}`
        let (core, printedCore) = TranslateOblivious(libCore, "LibCore")
        const appSource = `
using LibCore;

namespace LibApp
{
    public class Caller
    {
        public string Execute(string? maybe) => Combiner.Build("a", "b", maybe, "d");
    }
}`
        let printedApp = TranslateEnabled(appSource, "LibApp", core)
        Assert.DoesNotContain("maybe!!", printedApp)
        TranslationTestValidation.AssertBinds(printedApp, printedCore)
    }

    shared {
        private const ObliviousDelegateLibrarySource string = `
namespace LibCore
{
    public delegate void ConvertDelegate<T>(T ctx);

    public class Job<T>
    {
        // Forwards to a second method so the taint evidence (the null check)
        // is one hop away from the parameter cs2gs decides at the call site —
        // matching Oahu's own DownloadDecryptAndConvertAsync -> ... -> the
        // guard shape.
        public void Run(T ctx, ConvertDelegate<T> convertAction) => Inner(ctx, convertAction);

        private void Inner(T ctx, ConvertDelegate<T> convertAction)
        {
            if (convertAction != null)
            {
                convertAction(ctx);
            }
        }
    }
}`

        private func TranslateOblivious(source string, assemblyName string)(
            Project LoadedCSharpProject,
            Printed string
        ) {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                CSharpProjectLoader.RuntimeReferences(),
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let siblings = []CSharpCompilation{project.Compilation}
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblings,
                siblings
            )
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (project, GSharpPrinter.Print(unit))
        }

        // A genuinely nullable-ENABLED compilation for the consumer, referencing
        // `oblivious`'s compilation as a sibling — `CSharpProjectLoader.LoadInMemory`
        // always builds nullable-DISABLED compilations (a `#nullable enable`
        // pragma only changes the per-file annotation context, never the
        // compilation-level option `ObliviousNullabilityAnalyzer.IsTainted` reads),
        // so the enabled compilation is built directly here, exactly as
        // `Issue2412CrossProjectObliviousNullabilityTranslationTests.LoadEnabled` does.
        private func TranslateEnabled(source string, assemblyName string, oblivious LoadedCSharpProject) string {
            let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]CompilationReference{oblivious.Compilation.ToMetadataReference()})
                .ToList()
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
            let errors = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
            Assert.True(errors.Count == 0, "$assemblyName should bind with no C# errors: " + string.Join("\n", errors))
            let document = LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree))
            let siblings = []CSharpCompilation{compilation, oblivious.Compilation}
            let context = TranslationContext(compilation, document.SemanticModel, document.FilePath, siblings, siblings)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        // Collapses incidental whitespace/newlines so an assertion on a
        // multi-line call expression is not sensitive to the printer's exact
        // line-wrapping.
        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
