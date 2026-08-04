// <copyright file="DebugInformationOptionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Phase 3 (ADR-0027 §7.7a) tests covering the <see cref="DebugInformationOptions"/>
/// surface on <see cref="Compilation"/>: defaults, null normalisation, and
/// that the option set does not change PE output until later phases light up
/// the actual PDB writer. (The <c>ContinueWith</c> options-cloning pin was
/// deleted with <c>Compilation.ContinueWith</c> itself in ADR-0156 Phase 3c,
/// #3176 — its only product consumer was the evaluator SessionEngine.)
/// </summary>
public class DebugInformationOptionsTests
{
    [Fact]
    public void DebugInformation_HasNoneDefault()
    {
        var compilation = new Compilation(SyntaxTree.Parse("package P\n"));

        Assert.NotNull(compilation.DebugInformation);
        Assert.Equal(DebugInformationFormat.None, compilation.DebugInformation.Format);
        Assert.Null(compilation.DebugInformation.PdbFilePath);
        Assert.Null(compilation.DebugInformation.SourceLinkFilePath);
        Assert.False(compilation.DebugInformation.Deterministic);
    }

    [Fact]
    public void DebugInformation_NullAssignmentNormalisesToDefault()
    {
        var compilation = new Compilation(SyntaxTree.Parse("package P\n"))
        {
            DebugInformation = null,
        };

        Assert.NotNull(compilation.DebugInformation);
        Assert.Equal(DebugInformationFormat.None, compilation.DebugInformation.Format);
    }

    [Fact]
    public void DebugInformation_AssignsValuesIndependently()
    {
        var compilation = new Compilation(SyntaxTree.Parse("package P\n"))
        {
            DebugInformation = new DebugInformationOptions
            {
                Format = DebugInformationFormat.Portable,
                PdbFilePath = "/tmp/x.pdb",
                SourceLinkFilePath = "/tmp/sourcelink.json",
                Deterministic = true,
            },
        };

        Assert.Equal(DebugInformationFormat.Portable, compilation.DebugInformation.Format);
        Assert.Equal("/tmp/x.pdb", compilation.DebugInformation.PdbFilePath);
        Assert.Equal("/tmp/sourcelink.json", compilation.DebugInformation.SourceLinkFilePath);
        Assert.True(compilation.DebugInformation.Deterministic);
    }

    [Fact]
    public void Emit_WithDebugInformationNone_ProducesIdenticalPeAsBefore()
    {
        // Phase 3 is pure plumbing: requesting None must not perturb PE bytes.
        var src = "package P\nimport System\nfunc Main() { Console.WriteLine(\"hi\") }\n";

        var baseline = new Compilation(SyntaxTree.Parse(src));
        var withOptions = new Compilation(SyntaxTree.Parse(src))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.None },
        };

        using var baselineStream = new MemoryStream();
        using var withOptionsStream = new MemoryStream();

        var baselineResult = baseline.Emit(baselineStream);
        var withOptionsResult = withOptions.Emit(withOptionsStream);

        Assert.True(baselineResult.Success);
        Assert.True(withOptionsResult.Success);
        Assert.Equal(baselineStream.ToArray(), withOptionsStream.ToArray());
    }

    [Fact]
    public void Emit_WithPdbStreamOverload_ProducesPe()
    {
        // Phase 3 only plumbs the pdbStream parameter — the emitter currently
        // ignores it. Future phases (4-7) will actually write content. This
        // test pins the surface so callers (SDK BuildTask, gsc) can adopt
        // it now without a follow-up signature break.
        var src = "package P\nfunc Main() { }\n";
        var compilation = new Compilation(SyntaxTree.Parse(src))
        {
            DebugInformation = new DebugInformationOptions
            {
                Format = DebugInformationFormat.Portable,
                PdbFilePath = "P.pdb",
            },
        };

        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var result = compilation.Emit(peStream, pdbStream, null);

        Assert.True(result.Success);
        Assert.True(peStream.Length > 0, "PE stream should have content");
    }
}
