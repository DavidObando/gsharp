// <copyright file="Issue4262UnrelatedObliviousSiblingTaintLeakageTests.cs" company="GSharp">
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
/// Follow-up regression tests found while reviewing #4262's fix (PR #4272):
/// widening <see cref="ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol, IReadOnlyList{CSharpCompilation})"/>'s
/// and <see cref="ObliviousNullabilityAnalyzer.IsParamsElementTainted"/>'s entry
/// gates makes them reachable for a nullable-ENABLED asking compilation, which
/// exposed three call sites that consult cross-project taint evidence WITHOUT
/// first requiring the queried declaration's own <see cref="NullableAnnotation"/>
/// to be <see cref="NullableAnnotation.None"/> (i.e. genuinely oblivious).
/// Without that guard, an UNRELATED oblivious sibling loaded in the same
/// migration run — one with no relationship to the actual call site under
/// translation, other than calling (or overriding) the SAME target with a
/// literal <c>null</c> somewhere in its own source — could repaint a
/// completely different, genuinely non-nullable ENABLED declaration's own
/// emitted type, or suppress the `!!` bridge a genuinely non-nullable target
/// needs. Both directions are the soundness class #4262's whole taint
/// machinery exists to prevent (issue #2113/#2412): "too permissive" here
/// means silently reintroducing a null-safety hole, not merely a diagnostic
/// nit.
///
/// <para>
/// <b>Why <see cref="ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol, IReadOnlyList{CSharpCompilation})"/>
/// itself is not the bug</b>: its sibling walk (<c>IsTaintedCore</c>) only
/// ever trusts a candidate's cached fixpoint after remapping the QUERIED
/// symbol into that candidate's own symbol table by metadata identity
/// (<c>RemapToCompilation</c>) — a false match requires an accidental
/// same-metadata-name collision across projects. Its ordinary caller,
/// <c>ShouldPromoteToNullableReference</c>, additionally never even calls
/// <c>IsTainted</c> unless the target's own declared type already has
/// <see cref="NullableAnnotation.None"/> (see its own doc comment). The bugs
/// below are in OTHER call sites that skip that second check.
/// </para>
/// </summary>
public class Issue4262UnrelatedObliviousSiblingTaintLeakageTests
{
    [Fact]
    public void UnrelatedObliviousSibling_ParamsElementConsumptionSite_DoesNotSuppressBridge()
    {
        // C (enabled): declares a params method with a genuinely non-nullable
        // element (real C# nullable annotations, not oblivious).
        (LoadedCSharpProject c, CSharpCompilation compilationC) = LoadEnabled(
            @"
#nullable enable
namespace LibC
{
    public static class Combiner
    {
        public static string Build(params string[] parts) => string.Join(""/"", parts);
    }
}", "LibC");

        // B (oblivious): calls C's Combiner.Build with a literal `null` in the
        // expanded params tail, in B's OWN source — unrelated to A below.
        LoadedCSharpProject b = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("LibB.cs", @"
using LibC;
namespace LibB
{
    public class Unrelated
    {
        public void Seed() { Combiner.Build(""seed"", null); }
    }
}"),
            },
            CSharpProjectLoader.RuntimeReferences().Concat(new[] { compilationC.ToMetadataReference() }).ToList(),
            "LibB");
        Assert.True(b.BoundWithoutErrors, string.Join("\n", b.ErrorDiagnostics));

        // A (enabled): calls C's Combiner.Build with a genuinely nullable
        // local. A has nothing to do with B — B just happens to be another
        // oblivious project loaded in the same migration run.
        (LoadedDocument documentA, CSharpCompilation compilationA) = ParseEnabled(
            @"
using LibC;
namespace LibA
{
    public class Caller
    {
        public string Execute(string? maybe) => Combiner.Build(""a"", maybe);
    }
}", "LibA", compilationC);

        string printed = Translate(documentA, compilationA, compilationA, b.Compilation, compilationC);

        Assert.Contains("Combiner.Build(\"a\", maybe!!)", Compact(printed));
    }

    [Fact]
    public void UnrelatedObliviousSibling_ParamsElementDeclarationSite_DoesNotRepaintNullable()
    {
        const string enabledLibCSource = @"
#nullable enable
namespace LibC
{
    public static class Combiner
    {
        public static string Build(params string[] parts) => string.Join(""/"", parts);
    }
}";
        (LoadedCSharpProject cForB, CSharpCompilation compilationCForB) = LoadEnabled(enabledLibCSource, "LibC");

        LoadedCSharpProject b = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("LibB.cs", @"
using LibC;
namespace LibB
{
    public class Unrelated
    {
        public void Seed() { Combiner.Build(""seed"", null); }
    }
}"),
            },
            CSharpProjectLoader.RuntimeReferences().Concat(new[] { compilationCForB.ToMetadataReference() }).ToList(),
            "LibB");
        Assert.True(b.BoundWithoutErrors, string.Join("\n", b.ErrorDiagnostics));

        // Translate C ITSELF, with B present as a sibling. C's own params
        // element must stay `...string`, never repainted `...string?` purely
        // from B's unrelated evidence about the same target method.
        (LoadedCSharpProject c, CSharpCompilation compilationC) = LoadEnabled(enabledLibCSource, "LibC");
        LoadedDocument documentC = Assert.Single(c.Documents);
        string printed = Translate(documentC, compilationC, compilationC, b.Compilation);

        Assert.Contains("Build(parts ...string)", Compact(printed));
        Assert.DoesNotContain("...string?", printed);
    }

    [Fact]
    public void UnrelatedObliviousSibling_AsyncOverrideReturn_DoesNotRepaintEnabledBaseDeclaration()
    {
        const string enabledLibASource = @"
#nullable enable
using System.Threading.Tasks;
namespace LibA
{
    public class Base
    {
        public virtual async Task<string> M() { await Task.Yield(); return string.Empty; }
    }
}";
        (LoadedCSharpProject aForB, CSharpCompilation compilationAForB) = LoadEnabled(enabledLibASource, "LibA");

        LoadedCSharpProject b = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("LibB.cs", @"
using System.Threading.Tasks;
using LibA;
namespace LibB
{
    public class Derived : Base
    {
        public override async Task<string> M() { await Task.Yield(); return null; }
    }
}"),
            },
            CSharpProjectLoader.RuntimeReferences().Concat(new[] { compilationAForB.ToMetadataReference() }).ToList(),
            "LibB");
        Assert.True(b.BoundWithoutErrors, string.Join("\n", b.ErrorDiagnostics));

        // Translate A ITSELF (the base declaration), with B present as a
        // sibling. A's own async return type must stay `Task[string]`, never
        // repainted `Task[string?]` purely from B's oblivious override.
        (LoadedCSharpProject a, CSharpCompilation compilationA) = LoadEnabled(enabledLibASource, "LibA");
        LoadedDocument documentA = Assert.Single(a.Documents);
        string printed = Translate(documentA, compilationA, compilationA, b.Compilation);

        Assert.DoesNotContain("string?", Compact(printed));
    }

    private static (LoadedCSharpProject Project, CSharpCompilation Compilation) LoadEnabled(string source, string assemblyName)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest), path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        var errors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        Assert.True(errors.Count == 0, $"{assemblyName} should bind with no C# errors: " + string.Join("\n", errors));

        var document = new LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree));
        return (
            new LoadedCSharpProject(compilation, new[] { document }, Array.Empty<Diagnostic>()),
            compilation);
    }

    private static (LoadedDocument Document, CSharpCompilation Compilation) ParseEnabled(
        string source, string assemblyName, params CSharpCompilation[] references)
    {
        IReadOnlyList<MetadataReference> metadataReferences = CSharpProjectLoader.RuntimeReferences()
            .Concat(references.Select(r => r.ToMetadataReference()))
            .ToList();
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest), path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            metadataReferences,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
        var errors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        Assert.True(errors.Count == 0, $"{assemblyName} should bind with no C# errors: " + string.Join("\n", errors));

        return (new LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree)), compilation);
    }

    private static string Translate(
        LoadedDocument document,
        CSharpCompilation askingCompilation,
        params CSharpCompilation[] siblings)
    {
        var context = new TranslationContext(askingCompilation, document.SemanticModel, document.FilePath, siblings, siblings);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
}
