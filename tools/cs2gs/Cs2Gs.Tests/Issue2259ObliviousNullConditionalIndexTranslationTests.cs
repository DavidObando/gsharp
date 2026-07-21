// <copyright file="Issue2259ObliviousNullConditionalIndexTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
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
/// Translator-fidelity tests for issue #2259: a null-conditional element/member
/// access result (<c>expr?[i]</c> / <c>expr?.Member</c>) — or any other
/// analyzer-promoted-nullable value — assigned into an ELEMENT-access target
/// (an array element, a <c>Dictionary</c>/user-indexer write) trips a
/// <c>T? -&gt; T</c> GS0156 once gsc's strict nullability sees the RHS's true
/// <c>T?</c> type. Unlike a field/property/local/parameter assignment target,
/// which the whole-program taint analysis widens to <c>T?</c> at its OWN
/// declaration, an element-access target has no single declaration to widen,
/// so the fix asserts <c>!!</c> at the RHS use site instead — exactly like
/// every other promoted-nullable-into-non-nullable sink (return/argument/
/// tuple/event). The dominant real-world shape is
/// <c>Oahu.Foundation</c>'s <c>EnumUtil.cs</c>: <c>parts[i] = punct.Infix?[x - ByteA];</c>
/// where <c>Infix</c> is a <c>string[]</c>.
/// </summary>
public class Issue2259ObliviousNullConditionalIndexTranslationTests
{
    [Fact]
    public void Oblivious_NullConditionalIndex_AssignedToArrayElement_AssertsNonNull()
    {
        // Mirrors the Oahu.Foundation EnumUtil.cs repro: `Infix` is a
        // `string[]`, so `punct.Infix?[x]` yields `string?`, assigned into the
        // non-null `string` element `parts[i]`.
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("parts[i] = punct.Infix?[x]!!", printed);
    }

    [Fact]
    public void Oblivious_NullConditionalMember_AssignedToArrayElement_AssertsNonNull()
    {
        // Generalizes the shape beyond `string`/index access to a `?.Member`
        // read of a custom reference type, assigned into an array element of
        // that SAME custom type.
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("items[i] = w?.Value!!", printed);
    }

    [Fact]
    public void Oblivious_PromotedLocal_AssignedToIndexerWrite_AssertsNonNull()
    {
        // Mirrors Oahu.Core's ProgrammaticLogin.cs `inputs[name] = value;`
        // shape: `value` is a ternary-null-tainted local (promoted to
        // `string?`) assigned into a `Dictionary<string, string>` indexer
        // write, not a `?[]`/`?.` conditional-access RHS at all — proving the
        // fix covers any promoted-nullable RHS, not just conditional access.
        string printed = TranslateOblivious(@"
namespace Demo
{
    using System.Collections.Generic;

    public class C
    {
        public void Run(Dictionary<string, string> inputs, string name, bool ok)
        {
            string value = ok ? ""x"" : null;
            inputs[name] = value;
        }
    }
}");

        Assert.Contains("inputs[name] = value!!", printed);
    }

    [Fact]
    public void Enabled_NullConditionalIndex_AssignedToNonNullElement_IsForgiven()
    {
        // Nullable-enabled C# also permits this warning-level conversion.
        // Preserve that boundary with an assertion rather than widening the
        // destination array's element contract.
        string printed = TranslateEnabled(@"
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
}");

        Assert.Contains("parts[i] = (punct.Infix?[x])!!", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string TranslateEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Select(r => r).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
