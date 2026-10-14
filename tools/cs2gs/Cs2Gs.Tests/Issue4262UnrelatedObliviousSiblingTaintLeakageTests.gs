// <copyright file="Issue4262UnrelatedObliviousSiblingTaintLeakageTests.cs" company="GSharp">
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

/// Follow-up regression tests found while reviewing #4262's fix (PR #4272):
/// widening (cref:ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol,
/// IReadOnlyList{CSharpCompilation}))'s
/// and (cref:ObliviousNullabilityAnalyzer.IsParamsElementTainted)'s entry
/// gates makes them reachable for a nullable-ENABLED asking compilation, which
/// exposed three call sites that consult cross-project taint evidence WITHOUT
/// first requiring the queried declaration's own (cref:NullableAnnotation)
/// to be (cref:NullableAnnotation.None) (i.e. genuinely oblivious).
/// Without that guard, an UNRELATED oblivious sibling loaded in the same
/// migration run — one with no relationship to the actual call site under
/// translation, other than calling (or overriding) the SAME target with a
/// literal `null` somewhere in its own source — could repaint a
/// completely different, genuinely non-nullable ENABLED declaration's own
/// emitted type, or suppress the `!!` bridge a genuinely non-nullable target
/// needs. Both directions are the soundness class #4262's whole taint
/// machinery exists to prevent (issue #2113/#2412): "too permissive" here
/// means silently reintroducing a null-safety hole, not merely a diagnostic
/// nit.
///
/// <b>Why <see cref="ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol,
/// IReadOnlyList{CSharpCompilation})" />
/// itself is not the bug</b>: its sibling walk (`IsTaintedCore`) only
/// ever trusts a candidate's cached fixpoint after remapping the QUERIED
/// symbol into that candidate's own symbol table. `RemapToCompilation`
/// first matches an identical linked source by path, content and declaration
/// span, then falls back to metadata identity; either route requires the same
/// source declaration or stable assembly/member contract. Its ordinary caller,
/// `ShouldPromoteToNullableReference`, additionally never even calls
/// `IsTainted` unless the target's own declared type already has
/// (cref:NullableAnnotation.None) (see its own doc comment). The bugs
/// below are in OTHER call sites that skip that second check.
open class Issue4262UnrelatedObliviousSiblingTaintLeakageTests {
    @Fact
    func UnrelatedObliviousSibling_ParamsElementConsumptionSite_DoesNotSuppressBridge() {
        // C (enabled): declares a params method with a genuinely non-nullable
        // element (real C# nullable annotations, not oblivious).
        let (c, compilationC) = LoadEnabled(`
#nullable enable
namespace LibC
{
    public static class Combiner
    {
        public static string Build(params string[] parts) => string.Join("/", parts);
    }
}`, "LibC")
        // B (oblivious): calls C's Combiner.Build with a literal `null` in the
        // expanded params tail, in B's OWN source — unrelated to A below.
        let b = CSharpProjectLoader.LoadInMemory([](string, string){("LibB.cs", `
using LibC;
namespace LibB
{
    public class Unrelated
    {
        public void Seed() { Combiner.Build("seed", null); }
    }
}`)}, CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]CompilationReference{compilationC.ToMetadataReference()})
                .ToList(), "LibB")
        Assert.True(b.BoundWithoutErrors, string.Join("\n", b.ErrorDiagnostics))
        // A (enabled): calls C's Combiner.Build with a genuinely nullable
        // local. A has nothing to do with B — B just happens to be another
        // oblivious project loaded in the same migration run.
        let (documentA, compilationA) = ParseEnabled(`
using LibC;
namespace LibA
{
    public class Caller
    {
        public string Execute(string? maybe) => Combiner.Build("a", maybe);
    }
}`, "LibA", compilationC)
        let printed = Translate(documentA, compilationA, compilationA, b.Compilation, compilationC)
        Assert.Contains("Combiner.Build(\"a\", maybe!!)", Compact(printed))
    }

    @Fact
    func UnrelatedObliviousSibling_ParamsElementDeclarationSite_DoesNotRepaintNullable() {
        const enabledLibCSource = `
#nullable enable
namespace LibC
{
    public static class Combiner
    {
        public static string Build(params string[] parts) => string.Join("/", parts);
    }
}`
        let (cForB, compilationCForB) = LoadEnabled(enabledLibCSource, "LibC")
        let b = CSharpProjectLoader.LoadInMemory([](string, string){("LibB.cs", `
using LibC;
namespace LibB
{
    public class Unrelated
    {
        public void Seed() { Combiner.Build("seed", null); }
    }
}`)}, CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]CompilationReference{compilationCForB.ToMetadataReference()})
                .ToList(), "LibB")
        Assert.True(b.BoundWithoutErrors, string.Join("\n", b.ErrorDiagnostics))
        // Translate C ITSELF, with B present as a sibling. C's own params
        // element must stay `...string`, never repainted `...string?` purely
        // from B's unrelated evidence about the same target method.
        let (c, compilationC) = LoadEnabled(enabledLibCSource, "LibC")
        let documentC = Assert.Single(c.Documents)
        let printed = Translate(documentC, compilationC, compilationC, b.Compilation)
        Assert.Contains("Build(parts ...string)", Compact(printed))
        Assert.DoesNotContain("...string?", printed)
    }

    @Fact
    func UnrelatedObliviousSibling_AsyncOverrideReturn_DoesNotRepaintEnabledBaseDeclaration() {
        const enabledLibASource = `
#nullable enable
using System.Threading.Tasks;
namespace LibA
{
    public class Base
    {
        public virtual async Task<string> M() { await Task.Yield(); return string.Empty; }
    }
}`
        let (aForB, compilationAForB) = LoadEnabled(enabledLibASource, "LibA")
        let b = CSharpProjectLoader.LoadInMemory([](string, string){("LibB.cs", `
using System.Threading.Tasks;
using LibA;
namespace LibB
{
    public class Derived : Base
    {
        public override async Task<string> M() { await Task.Yield(); return null; }
    }
}`)}, CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]CompilationReference{compilationAForB.ToMetadataReference()})
                .ToList(), "LibB")
        Assert.True(b.BoundWithoutErrors, string.Join("\n", b.ErrorDiagnostics))
        // Translate A ITSELF (the base declaration), with B present as a
        // sibling. A's own async return type must stay `Task[string]`, never
        // repainted `Task[string?]` purely from B's oblivious override.
        let (a, compilationA) = LoadEnabled(enabledLibASource, "LibA")
        let documentA = Assert.Single(a.Documents)
        let printed = Translate(documentA, compilationA, compilationA, b.Compilation)
        Assert.DoesNotContain("string?", Compact(printed))
    }

    shared {
        private func LoadEnabled(source string, assemblyName string)(
            Project LoadedCSharpProject,
            Compilation CSharpCompilation
        ) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
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
            return (
                LoadedCSharpProject(compilation, []LoadedDocument{document}, Array.Empty[Diagnostic]()),
                compilation
            )
        }

        private func ParseEnabled(source string, assemblyName string, references ...CSharpCompilation)(
            Document LoadedDocument,
            Compilation CSharpCompilation
        ) {
            let metadataReferences IReadOnlyList[MetadataReference] = CSharpProjectLoader
                .RuntimeReferences()
                .Concat(references.Select((r CSharpCompilation) -> r.ToMetadataReference()))
                .ToList()
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                metadataReferences,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let errors = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
            Assert.True(errors.Count == 0, "$assemblyName should bind with no C# errors: " + string.Join("\n", errors))
            return (LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree)), compilation)
        }

        private func Translate(
            document LoadedDocument,
            askingCompilation CSharpCompilation,
            siblings ...CSharpCompilation
        ) string {
            let context = TranslationContext(
                askingCompilation,
                document.SemanticModel,
                document.FilePath,
                siblings,
                siblings
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
