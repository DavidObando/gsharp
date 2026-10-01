// <copyright file="Issue4628AccessorArrayNullTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4628: <c>Issue4589ExplicitPropertyAccessorEmitTests</c> collected
/// <c>new[] { property.GetMethod, property.SetMethod }.OfType&lt;MethodInfo&gt;()</c>.
/// <c>SetMethod</c> is null for a get-only property, and cs2gs bridges each
/// possibly-null array element with a fail-fast <c>!!</c> (the settled policy;
/// see #4612), so the migrated test threw where the C# filtered the null. The
/// test now adds only the accessors that exist.
/// </summary>
public class Issue4628AccessorArrayNullTests
{
    /// <summary>
    /// The discriminating witness (ADR-0154): migrate the real test file in its
    /// own project, exactly as the self-migration does, and reject any
    /// fail-fast bridge on a property accessor read.
    /// </summary>
    [Fact]
    public async Task CoreTestsSelfMigration_NeverAssertsAPropertyAccessor()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(repoRoot, "test", "Core.Tests", "Core.Tests.csproj"));
        Assert.True(
            project.BoundWithoutErrors,
            "Core.Tests should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(
            project.Documents,
            candidate => Path.GetFileName(candidate.FilePath) == "Issue4589ExplicitPropertyAccessorEmitTests.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator(preservePartialParts: true).TranslateDocument(document, context));

        Assert.Contains("PropertyAccessors_AreSpecialName", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetMethod!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("SetMethod!!", printed, StringComparison.Ordinal);
    }
}
