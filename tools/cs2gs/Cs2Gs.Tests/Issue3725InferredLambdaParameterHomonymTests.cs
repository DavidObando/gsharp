// <copyright file="Issue3725InferredLambdaParameterHomonymTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3725 (#3724 family B): a lambda parameter is the one type position
/// cs2gs manufactures — C# infers it from the delegate target and writes no
/// name at all, while the canonical G# arrow lambda always spells it
/// (ADR-0074). The #2222/#3554 homonym check that decides whether a bare type
/// name is safe consulted a purely SYNTACTIC pre-scan of the file's name
/// nodes, so a namespace reached only through such an inferred parameter type
/// was invisible to it even though the translator still synthesized an
/// <c>import</c> for it.
/// <para>
/// In <c>test/LanguageServer.Tests/DocumentSyncHandlerTests.cs</c> that meant
/// <c>GSharp.Core.CodeAnalysis.Diagnostic</c> and
/// <c>GSharp.LanguageServer.Protocol.Diagnostic</c> — both reached only
/// through <c>d =&gt; d.Message…</c> lambdas — both printed bare while both
/// namespaces were imported. gsc resolves a bare imported type name by
/// first-import-wins with no ambiguity report, so every Protocol-typed lambda
/// silently bound the Core type and the enclosing generic call failed
/// inference with <c>GS0159 Cannot find function DoesNotContain</c>/<c>Where</c>.
/// </para>
/// </summary>
public class Issue3725InferredLambdaParameterHomonymTests
{
    /// <summary>
    /// The referenced-assembly shape: two namespaces declaring the same simple
    /// type name, reachable from the test file only through inference. Both
    /// live in METADATA, so the compilation-wide source census
    /// (<c>HasSourceHomonym</c>) cannot see the collision either.
    /// </summary>
    private const string LibrarySource = @"
using System.Collections.Generic;

namespace Corpus.Issue3725.Core
{
    public sealed class Diagnostic { public string Message { get; set; } }

    public sealed class Scope { public IReadOnlyList<Diagnostic> Diagnostics { get; set; } }

    public sealed class Compilation { public Scope GlobalScope { get; set; } }
}

namespace Corpus.Issue3725.Protocol
{
    public sealed class Diagnostic { public string Message { get; set; } }
}

namespace Corpus.Issue3725.Server
{
    public sealed class Result { public IReadOnlyList<Protocol.Diagnostic> Diagnostics { get; set; } }

    public static class Handler
    {
        public static Result Compute() => null;

        public static Core.Compilation Bind() => null;
    }
}
";

    private const string HomonymTestsSource = @"
using System.Linq;
using Corpus.Issue3725.Server;

namespace Corpus.Issue3725.Tests
{
    public class Probe
    {
        public void M()
        {
            var protocolDiagnostics = Handler.Compute().Diagnostics;
            var coreDiagnostics = Handler.Bind().GlobalScope.Diagnostics;

            var a = protocolDiagnostics.Where(d => d.Message.Length > 0).ToList();
            var b = coreDiagnostics.Where(d => d.Message.Length > 0).ToList();
        }
    }
}
";

    private const string SingleTypeTestsSource = @"
using System.Linq;
using Corpus.Issue3725.Server;

namespace Corpus.Issue3725.Tests
{
    public class Probe
    {
        public void M()
        {
            var protocolDiagnostics = Handler.Compute().Diagnostics;

            var a = protocolDiagnostics.Where(d => d.Message.Length > 0).ToList();
        }
    }
}
";

    [Fact]
    public void InferredLambdaParameter_QualifiesTheHomonymReachedOnlyThroughInference()
    {
        string rendered = Translate(HomonymTestsSource);

        Assert.Contains(
            "(d Corpus.Issue3725.Protocol.Diagnostic) ->",
            rendered,
            StringComparison.Ordinal);
        Assert.Contains(
            "(d Corpus.Issue3725.Core.Diagnostic) ->",
            rendered,
            StringComparison.Ordinal);
    }

    [Fact]
    public void InferredLambdaParameter_LeavesNoBareHomonymSpelling()
    {
        // The bare spelling is what gsc silently mis-binds; neither lambda may
        // keep it once both namespaces are imported.
        Assert.DoesNotContain("(d Diagnostic) ->", Translate(HomonymTestsSource), StringComparison.Ordinal);
    }

    [Fact]
    public void InferredLambdaParameter_WithoutHomonym_StaysBare()
    {
        // Guard rail: the widened pre-scan only ADDS namespaces the homonym
        // check may consider — a lambda parameter whose type has no same-named
        // sibling in another imported namespace must still print bare, or the
        // fix would qualify the whole corpus.
        string rendered = Translate(SingleTypeTestsSource);

        Assert.Contains("(d Diagnostic) ->", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Corpus.Issue3725.Protocol.Diagnostic", rendered, StringComparison.Ordinal);
    }

    private static string Translate(string testsSource)
    {
        IReadOnlyList<MetadataReference> runtime = CSharpProjectLoader.RuntimeReferences();

        var library = CSharpCompilation.Create(
            "Corpus.Issue3725.Library",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            runtime,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = library.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;

        var references = new List<MetadataReference>(runtime)
        {
            MetadataReference.CreateFromStream(peStream),
        };

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Tests.cs", testsSource) },
            references);

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }
}
