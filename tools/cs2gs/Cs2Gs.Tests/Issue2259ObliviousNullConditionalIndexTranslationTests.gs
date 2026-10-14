// <copyright file="Issue2259ObliviousNullConditionalIndexTranslationTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #2259: a null-conditional element/member
/// access result (`expr?[i]` / `expr?.Member`) — or any other
/// analyzer-promoted-nullable value — assigned into an ELEMENT-access target
/// (an array element, a `Dictionary`/user-indexer write) trips a
/// `T? -> T` GS0156 once gsc's strict nullability sees the RHS's true
/// `T?` type. Unlike a field/property/local/parameter assignment target,
/// which the whole-program taint analysis widens to `T?` at its OWN
/// declaration, an element-access target has no single declaration to widen,
/// so the fix asserts `!!` at the RHS use site instead — exactly like
/// every other promoted-nullable-into-non-nullable sink (return/argument/
/// tuple/event). The dominant real-world shape is
/// `Oahu.Foundation`'s `EnumUtil.cs`: `parts[i] = punct.Infix?[x - ByteA];`
/// where `Infix` is a `string[]`.
open class Issue2259ObliviousNullConditionalIndexTranslationTests {
    @Fact
    func Oblivious_NullConditionalIndex_AssignedToArrayElement_AssertsNonNull() {
        // Mirrors the Oahu.Foundation EnumUtil.cs repro: `Infix` is a
        // `string[]`, so `punct.Infix?[x]` yields `string?`, assigned into the
        // non-null `string` element `parts[i]`.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Punctuation
    {
        public string[] Infix;
    }

    public class C
    {
        public void Run(Punctuation punct, string[] parts, int i, int x)
        {
            parts[i] = punct.Infix?[x];
        }
    }
}`)
        Assert.Contains("parts[i] = punct.Infix?[x]!!", printed)
    }

    @Fact
    func Oblivious_NullConditionalMember_AssignedToArrayElement_AssertsNonNull() {
        // Generalizes the shape beyond `string`/index access to a `?.Member`
        // read of a custom reference type, assigned into an array element of
        // that SAME custom type.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Foo
    {
        public string Name;
    }

    public class Wrapper
    {
        public Foo Value;
    }

    public class C
    {
        public void Run(Wrapper w, Foo[] items, int i)
        {
            items[i] = w?.Value;
        }
    }
}`)
        Assert.Contains("items[i] = w?.Value!!", printed)
    }

    @Fact
    func Oblivious_PromotedLocal_AssignedToIndexerWrite_AssertsNonNull() {
        // Mirrors Oahu.Core's ProgrammaticLogin.cs `inputs[name] = value;`
        // shape: `value` is a ternary-null-tainted local (promoted to
        // `string?`) assigned into a `Dictionary<string, string>` indexer
        // write, not a `?[]`/`?.` conditional-access RHS at all — proving the
        // fix covers any promoted-nullable RHS, not just conditional access.
        let printed = TranslateOblivious(`
namespace Demo
{
    using System.Collections.Generic;

    public class C
    {
        public void Run(Dictionary<string, string> inputs, string name, bool ok)
        {
            string value = ok ? "x" : null;
            inputs[name] = value;
        }
    }
}`)
        Assert.Contains("inputs[name] = value!!", printed)
    }

    @Fact
    func Enabled_NullConditionalIndex_AssignedToNonNullElement_IsForgiven() {
        // Nullable-enabled C# also permits this warning-level conversion.
        // Preserve that boundary with an assertion rather than widening the
        // destination array's element contract.
        let printed = TranslateEnabled(`
namespace Demo
{
    public class Punctuation
    {
        public string?[] Infix = System.Array.Empty<string?>();
    }

    public class C
    {
        public void Run(Punctuation punct, string[] parts, int i, int x)
        {
            parts[i] = punct.Infix?[x];
        }
    }
}`)
        Assert.Contains("parts[i] = (punct.Infix?[x])!!", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func TranslateEnabled(source string) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.EnabledInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Select((r MetadataReference) -> r).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
