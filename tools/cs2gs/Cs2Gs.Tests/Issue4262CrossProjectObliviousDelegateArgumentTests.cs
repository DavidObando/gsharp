// <copyright file="Issue4262CrossProjectObliviousDelegateArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
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
/// Regression tests for issue #4262: a nullable-ENABLED consumer project
/// (e.g. Oahu.Cli.App) calling into a nullable-OBLIVIOUS sibling project
/// (e.g. Oahu.Core) it references got a spurious <c>!!</c> on an
/// intentionally-nullable delegate ARGUMENT, even though the sibling's own
/// parameter is proven null-tainted (via <c>ObliviousNullabilityAnalyzer</c>'s
/// whole-program fixpoint, walking a call chain that ends in an
/// <c>if (convertAction != null)</c> guard) and is therefore genuinely safe
/// to pass <c>nil</c> to.
///
/// <para>
/// <b>Root cause</b>: <see cref="ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol, IReadOnlyList{CSharpCompilation})"/>
/// bailed out immediately whenever the ASKING compilation (the consumer's
/// own, e.g. Oahu.Cli.App) was nullable-ENABLED, before its sibling-walk loop
/// — which already correctly remaps into, and checks the obliviousness of,
/// EACH sibling independently — ever got a chance to run. Issue #2412's own
/// cross-project machinery therefore only ever fired when the CONSUMER's own
/// compilation was oblivious; a nullable-enabled consumer calling into an
/// oblivious sibling (Oahu's actual shape) always answered "not tainted",
/// forcing <c>CSharpToGSharpTranslator.TranslateArgumentValue</c>'s
/// <c>targetIsPromotedMigratedSibling</c> bridge to stay unset and the
/// ordinary "target requires non-null" bridge to fire instead.
/// </para>
/// <para>
/// <b>Fix</b>: the entry gate now bails only when NEITHER the asking
/// compilation NOR any sibling is oblivious — there being nothing an
/// oblivious-only fixpoint could ever find in that case. Every existing
/// (oblivious-consumer) cross-project scenario in
/// <c>Issue2412CrossProjectObliviousNullabilityTranslationTests</c> is
/// unaffected: an oblivious consumer already satisfied the old gate.
/// </para>
/// </summary>
public class Issue4262CrossProjectObliviousDelegateArgumentTests
{
    private const string ObliviousDelegateLibrarySource = @"
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
}";

    [Fact]
    public void NullableEnabledCaller_ObliviousTaintedDelegateParameter_PassThrough_NoSpuriousAssertion()
    {
        (LoadedCSharpProject core, string printedCore) = TranslateOblivious(ObliviousDelegateLibrarySource, "LibCore");

        const string appSource = @"
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
}";
        string printedApp = TranslateEnabled(appSource, "LibApp", core);

        Assert.DoesNotContain("convertAction!!", printedApp);
        Assert.Contains("Job[int32]().Run(1, convertAction)", Compact(printedApp));
        TranslationTestValidation.AssertBinds(printedApp, printedCore);
    }

    [Fact]
    public void NullableEnabledCaller_ObliviousTaintedDelegateParameter_CapturedInNestedClosure_NoSpuriousAssertion()
    {
        // Mirrors the real Oahu shape more closely: the nullable delegate
        // local is captured by a nested lambda (`Task.Run`) rather than
        // forwarded directly, so the argument value cs2gs sees at the call
        // site is a CAPTURED local, not the outer parameter/local itself.
        (LoadedCSharpProject core, string printedCore) = TranslateOblivious(ObliviousDelegateLibrarySource, "LibCore");

        const string appSource = @"
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
}";
        string printedApp = TranslateEnabled(appSource, "LibApp", core);

        Assert.DoesNotContain("convertAction!!", printedApp);
        TranslationTestValidation.AssertBinds(printedApp, printedCore);
    }

    [Fact]
    public void NullableEnabledCaller_ObliviousParameterWithoutTaintEvidence_StillAssertsNonNull()
    {
        // Precision guard: the fix must not blanket-disable the bridge for
        // every oblivious cross-project delegate parameter — only one PROVEN
        // (by the sibling's own taint fixpoint) to accept null. A sibling
        // parameter with NO null-check anywhere still gets `!!` when a
        // genuinely nullable value from the enabled caller flows into it.
        const string libCore = @"
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
}";
        (LoadedCSharpProject core, string printedCore) = TranslateOblivious(libCore, "LibCore");

        const string appSource = @"
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
}";
        string printedApp = TranslateEnabled(appSource, "LibApp", core);

        Assert.Contains("Job[int32]().Run(1, convertAction!!)", Compact(printedApp));
        TranslationTestValidation.AssertBinds(printedApp, printedCore);
    }

    [Fact]
    public void NullableEnabledCaller_ObliviousTaintedParamsElement_NoSpuriousAssertion()
    {
        // Same root cause, the params-ELEMENT sibling of the scalar-argument
        // bug above: `ObliviousNullabilityAnalyzer.IsParamsElementTainted`
        // (issue #3888) has the identical entry gate, reachable from
        // `TargetWillRemainNonNullableReference`'s variadic-carrier branch.
        const string libCore = @"
namespace LibCore
{
    public static class Combiner
    {
        public static string Build(params string[] parts) => string.Join(""/"", parts);

        // Seeds the params ELEMENT taint fixpoint: a nullable argument in
        // the expanded tail of a call within LibCore's own oblivious source.
        public static string BuildWithDefault(string extra) => Build(extra, null);
    }
}";
        (LoadedCSharpProject core, string printedCore) = TranslateOblivious(libCore, "LibCore");

        const string appSource = @"
using LibCore;

namespace LibApp
{
    public class Caller
    {
        public string Execute(string? maybe) => Combiner.Build(""a"", ""b"", maybe, ""d"");
    }
}";
        string printedApp = TranslateEnabled(appSource, "LibApp", core);

        Assert.DoesNotContain("maybe!!", printedApp);
        TranslationTestValidation.AssertBinds(printedApp, printedCore);
    }

    private static (LoadedCSharpProject Project, string Printed) TranslateOblivious(string source, string assemblyName)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (assemblyName + ".cs", source) }, CSharpProjectLoader.RuntimeReferences(), assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            $"{assemblyName} should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var siblings = new[] { project.Compilation };
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath, siblings, siblings);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (project, GSharpPrinter.Print(unit));
    }

    // A genuinely nullable-ENABLED compilation for the consumer, referencing
    // `oblivious`'s compilation as a sibling — `CSharpProjectLoader.LoadInMemory`
    // always builds nullable-DISABLED compilations (a `#nullable enable`
    // pragma only changes the per-file annotation context, never the
    // compilation-level option `ObliviousNullabilityAnalyzer.IsTainted` reads),
    // so the enabled compilation is built directly here, exactly as
    // `Issue2412CrossProjectObliviousNullabilityTranslationTests.LoadEnabled` does.
    private static string TranslateEnabled(string source, string assemblyName, LoadedCSharpProject oblivious)
    {
        IReadOnlyList<MetadataReference> references = CSharpProjectLoader.RuntimeReferences()
            .Concat(new[] { oblivious.Compilation.ToMetadataReference() })
            .ToList();

        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source, new CSharpParseOptions(LanguageVersion.Latest), path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        var errors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        Assert.True(errors.Count == 0, $"{assemblyName} should bind with no C# errors: " + string.Join("\n", errors));

        var document = new LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree));
        var siblings = new[] { compilation, oblivious.Compilation };
        var context = new TranslationContext(compilation, document.SemanticModel, document.FilePath, siblings, siblings);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    // Collapses incidental whitespace/newlines so an assertion on a
    // multi-line call expression is not sensitive to the printer's exact
    // line-wrapping.
    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
}
