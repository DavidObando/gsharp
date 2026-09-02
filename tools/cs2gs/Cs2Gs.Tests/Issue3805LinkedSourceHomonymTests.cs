// <copyright file="Issue3805LinkedSourceHomonymTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3805: a LINKED source — one <c>.cs</c> file compiled into several
/// projects via <c>&lt;Compile Include="..\Shared\X.cs" /&gt;</c> — must
/// translate to the SAME G# in every project. The repository mirror writes one
/// <c>.gs</c> per source file and <c>TranslateStage</c> rejects divergent
/// renderings ("Linked source ... translates differently in multiple
/// projects").
/// <para>
/// The #1174 homonym census decides whether a bare type name is safe by
/// looking for a same-named type declared in SOURCE anywhere in the
/// compilation — and a project reference is a source-bearing compilation
/// reference, so the census follows the project's reference graph.
/// <c>test/Shared/EmittedOracle.cs</c> is linked into <c>test/Core.Tests</c>,
/// <c>tools/cs2gs/Cs2Gs.Tests</c> and <c>test/Interpreter.Tests</c>; only the
/// last references the Repl and through it
/// <c>GSharp.LanguageServer.Protocol.Diagnostic</c>. Its inferred lambda
/// parameter therefore printed <c>(d GSharp.Core.CodeAnalysis.Diagnostic)</c>
/// while the other two printed <c>(d Diagnostic)</c>, and the whole-repository
/// translate stage failed.
/// </para>
/// <para>
/// The rule adopted here is the one the shared-document nullability taint
/// already follows (issue #3501): a decision that can differ between the
/// projects linking a file is answered over the WHOLE set of them, converged
/// and order-independent. The qualified spelling binds in every project, so
/// the union answer is the safe one.
/// </para>
/// </summary>
public class Issue3805LinkedSourceHomonymTests
{
    /// <summary>
    /// The type the linked file's lambda parameter is inferred as. Referenced
    /// by both projects.
    /// </summary>
    private const string CoreLibrarySource = @"
using System.Collections.Generic;

namespace Corpus.Issue3805.Core
{
    public sealed class Diagnostic { public bool IsError { get; set; } }

    public sealed class EmitResult { public IReadOnlyList<Diagnostic> Diagnostics { get; set; } }
}
";

    /// <summary>
    /// The <c>GSharp.LanguageServer.Protocol</c> stand-in: a second
    /// <c>Diagnostic</c> in a namespace the linked file never imports and
    /// never names, referenced by only ONE of the linking projects.
    /// </summary>
    private const string RivalLibrarySource = @"
namespace Corpus.Issue3805.Rival
{
    public sealed class Diagnostic { public bool IsError { get; set; } }
}
";

    /// <summary>
    /// The linked file. It never SPELLS <c>Diagnostic</c> — C# infers the
    /// lambda parameter's type — but G# always spells a lambda parameter's
    /// type (ADR-0074), so cs2gs has to choose a spelling.
    /// </summary>
    private const string LinkedSource = @"
using System.Collections.Generic;
using System.Linq;
using Corpus.Issue3805.Core;

namespace Corpus.Issue3805.Tests
{
    public static class Oracle
    {
        public static int ErrorCount(EmitResult result)
        {
            return result.Diagnostics.Where(d => d.IsError).ToList().Count;
        }
    }
}
";

    /// <summary>
    /// The repo-relative path both projects link the file under. The two
    /// compilations parse it into distinct <see cref="SyntaxTree"/> instances,
    /// so the linked-document set is matched by path and content.
    /// </summary>
    private const string LinkedPath = "test/Shared/Oracle.cs";

    [Fact]
    public void LinkedSource_TranslatesIdenticallyInEveryLinkingProject()
    {
        (string withoutHomonym, string withHomonym) = TranslateBothProjects();

        // This is exactly what TranslateStage's cross-check compares.
        Assert.Equal(withoutHomonym, withHomonym);
    }

    [Fact]
    public void LinkedSource_QualifiesTheNameThatIsAmbiguousInAnyLinkingProject()
    {
        (string withoutHomonym, string withHomonym) = TranslateBothProjects();

        // The qualified spelling binds in both projects; the bare one is the
        // spelling the census calls unsafe in the project that also sees
        // Corpus.Issue3805.Rival.Diagnostic.
        Assert.Contains("(d Corpus.Issue3805.Core.Diagnostic) ->", withHomonym, StringComparison.Ordinal);
        Assert.Contains("(d Corpus.Issue3805.Core.Diagnostic) ->", withoutHomonym, StringComparison.Ordinal);
        Assert.DoesNotContain("(d Diagnostic) ->", withoutHomonym, StringComparison.Ordinal);
    }

    [Fact]
    public void LinkedSource_WithNoHomonymAnywhere_StaysBare()
    {
        // Guard rail: the union answer must not qualify a name that is
        // unambiguous in EVERY linking project, or the fix would qualify the
        // whole corpus.
        MetadataReference core = Reference("Corpus.Issue3805.Core", CoreLibrarySource);

        LoadedCSharpProject first = LoadLinkingProject("Corpus.Issue3805.First", core);
        LoadedCSharpProject second = LoadLinkingProject("Corpus.Issue3805.Second", core);
        var repository = new[] { first.Compilation, second.Compilation };

        string rendered = Translate(first, repository);

        Assert.Contains("(d Diagnostic) ->", rendered, StringComparison.Ordinal);
        Assert.Equal(rendered, Translate(second, repository));
    }

    /// <summary>
    /// Translates the linked file as each of the two linking projects, with
    /// the repository compilation set both of them would see in a
    /// whole-repository migration.
    /// </summary>
    /// <returns>The rendering from the project without the rival type, then the one with it.</returns>
    private static (string WithoutHomonym, string WithHomonym) TranslateBothProjects()
    {
        MetadataReference core = Reference("Corpus.Issue3805.Core", CoreLibrarySource);
        MetadataReference rival = Reference("Corpus.Issue3805.Rival", RivalLibrarySource);

        LoadedCSharpProject withoutHomonym = LoadLinkingProject(
            "Corpus.Issue3805.WithoutHomonym", core);
        LoadedCSharpProject withHomonym = LoadLinkingProject(
            "Corpus.Issue3805.WithHomonym", core, rival);
        var repository = new[] { withoutHomonym.Compilation, withHomonym.Compilation };

        return (Translate(withoutHomonym, repository), Translate(withHomonym, repository));
    }

    /// <summary>
    /// A PROJECT reference: a compilation reference, whose types carry source
    /// locations exactly like an MSBuild <c>&lt;ProjectReference&gt;</c>'s do.
    /// That is what puts them in the #1174 source census, and what makes the
    /// census answer depend on the linking project's reference graph.
    /// </summary>
    /// <param name="assemblyName">The referenced assembly name.</param>
    /// <param name="source">Its source.</param>
    /// <returns>The compilation reference.</returns>
    private static MetadataReference Reference(string assemblyName, string source)
    {
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source) },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.Empty(compilation
            .GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
        return compilation.ToMetadataReference();
    }

    private static LoadedCSharpProject LoadLinkingProject(
        string assemblyName,
        params MetadataReference[] extraReferences)
    {
        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences());
        references.AddRange(extraReferences);

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (LinkedPath, LinkedSource) },
            references,
            assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static string Translate(
        LoadedCSharpProject project,
        IReadOnlyList<CSharpCompilation> repositoryCompilations)
    {
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            repositoryCompilations,
            repositoryCompilations);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }
}
