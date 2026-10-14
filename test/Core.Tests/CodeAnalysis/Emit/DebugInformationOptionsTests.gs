// <copyright file="DebugInformationOptionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import System.IO
import Xunit

/// Phase 3 (ADR-0027 §7.7a) tests covering the (cref:DebugInformationOptions)
/// surface on (cref:Compilation): defaults, null normalisation, and
/// that the option set does not change PE output until later phases light up
/// the actual PDB writer. (The `ContinueWith` options-cloning pin was
/// deleted with `Compilation.ContinueWith` itself in ADR-0156 Phase 3c,
/// #3176 — its only product consumer was the evaluator SessionEngine.)
open class DebugInformationOptionsTests {
    @Fact
    func DebugInformation_HasNoneDefault() {
        let compilation = Compilation(SyntaxTree.Parse("package P\n"))
        Assert.NotNull(compilation.DebugInformation)
        Assert.Equal(DebugInformationFormat.None, compilation.DebugInformation!!.Format)
        Assert.Null(compilation.DebugInformation!!.PdbFilePath)
        Assert.Null(compilation.DebugInformation!!.SourceLinkFilePath)
        Assert.False(compilation.DebugInformation!!.Deterministic)
    }

    @Fact
    func DebugInformation_NullAssignmentNormalisesToDefault() {
        let compilation = Compilation(SyntaxTree.Parse("package P\n")){DebugInformation = nil}
        Assert.NotNull(compilation.DebugInformation)
        Assert.Equal(DebugInformationFormat.None, compilation.DebugInformation!!.Format)
    }

    @Fact
    func DebugInformation_AssignsValuesIndependently() {
        let compilation = Compilation(SyntaxTree.Parse("package P\n")){
            DebugInformation = DebugInformationOptions{
                Format: DebugInformationFormat.Portable,
                PdbFilePath: "/tmp/x.pdb",
                SourceLinkFilePath: "/tmp/sourcelink.json",
                Deterministic: true
            }
        }
        Assert.Equal(DebugInformationFormat.Portable, compilation.DebugInformation!!.Format)
        Assert.Equal("/tmp/x.pdb", compilation.DebugInformation!!.PdbFilePath)
        Assert.Equal("/tmp/sourcelink.json", compilation.DebugInformation!!.SourceLinkFilePath)
        Assert.True(compilation.DebugInformation!!.Deterministic)
    }

    @Fact
    func Emit_WithDebugInformationNone_ProducesIdenticalPeAsBefore() {
        // Phase 3 is pure plumbing: requesting None must not perturb PE bytes.
        let src = `package P
import System
func Main() { Console.WriteLine("hi") }
`
        let baseline = Compilation(SyntaxTree.Parse(src))
        let withOptions = Compilation(SyntaxTree.Parse(src)){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.None}
        }
        using let baselineStream = MemoryStream()
        using let withOptionsStream = MemoryStream()
        let baselineResult = baseline.Emit(baselineStream)
        let withOptionsResult = withOptions.Emit(withOptionsStream)
        Assert.True(baselineResult.Success)
        Assert.True(withOptionsResult.Success)
        Assert.Equal(baselineStream.ToArray(), withOptionsStream.ToArray())
    }

    @Fact
    func Emit_WithPdbStreamOverload_ProducesPe() {
        // Phase 3 only plumbs the pdbStream parameter — the emitter currently
        // ignores it. Future phases (4-7) will actually write content. This
        // test pins the surface so callers (SDK BuildTask, gsc) can adopt
        // it now without a follow-up signature break.
        let src = `package P
func Main() { }
`
        let compilation = Compilation(SyntaxTree.Parse(src)){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable, PdbFilePath: "P.pdb"}
        }
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success)
        Assert.True(peStream.Length > int64(0), "PE stream should have content")
    }
}
