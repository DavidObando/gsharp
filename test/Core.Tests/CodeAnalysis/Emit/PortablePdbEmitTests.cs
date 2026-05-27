// <copyright file="PortablePdbEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Security.Cryptography;
using System.Text;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Phase 4 (ADR-0027 §7.7a) acceptance tests for the Portable PDB writer.
/// Compiles a tiny program with <see cref="DebugInformationFormat.Portable"/>,
/// reads the produced PDB stream back through
/// <see cref="MetadataReaderProvider"/>, and asserts the table contents match
/// the source: one <c>Document</c> row per <see cref="SyntaxTree"/>, one
/// <c>MethodDebugInformation</c> row per <c>MethodDef</c>, and at least one
/// visible sequence point anchored at the expected source line.
/// </summary>
public class PortablePdbEmitTests
{
    private const string SimpleProgram = @"package main

func main() {
    let x = 1
    let y = 2
    let z = x + y
}
";

    [Fact]
    public void PdbStream_IsEmpty_WhenFormatIsNone()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")));
        var result = compilation.Emit(peStream: peStream, pdbStream: pdbStream, refStream: null);

        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));
        Assert.Equal(0, pdbStream.Length);
    }

    [Fact]
    public void PdbStream_HasValidHeader_WhenFormatIsPortable()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream: peStream, pdbStream: pdbStream, refStream: null);

        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));
        Assert.True(pdbStream.Length > 0);

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        // At least one document for main.gs.
        Assert.True(reader.Documents.Count >= 1);
    }

    [Fact]
    public void Document_HasExpectedNameAndSha256Hash()
    {
        const string source = "package main\n\nfunc main() {\n    let x = 1\n}\n";
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source, "hello.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream: peStream, pdbStream: pdbStream, refStream: null);
        Assert.True(result.Success);

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        var docHandle = reader.Documents.Single();
        var doc = reader.GetDocument(docHandle);

        var name = reader.GetString(doc.Name);
        Assert.Equal("hello.gs", name);

        var hashBytes = reader.GetBlobBytes(doc.Hash);
        byte[] expected;
        using (var sha = SHA256.Create())
        {
            expected = sha.ComputeHash(Encoding.UTF8.GetBytes(source));
        }

        Assert.Equal(expected, hashBytes);

        // GSharp language GUID matches the constant exposed by the emitter.
        var languageGuid = reader.GetGuid(doc.Language);
        Assert.Equal(PortablePdbEmitterTestHelpers.GSharpLanguageGuid, languageGuid);
    }

    [Fact]
    public void MethodDebugInformation_RowCount_MatchesMethodDef()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream: peStream, pdbStream: pdbStream, refStream: null);
        Assert.True(result.Success);

        // Read MethodDef count from the PE side.
        peStream.Position = 0;
        using var peProvider = new System.Reflection.PortableExecutable.PEReader(peStream);
        var peReader = peProvider.GetMetadataReader();
        var peMethodDefCount = peReader.MethodDefinitions.Count;

        // Read MethodDebugInformation count from the PDB side.
        pdbStream.Position = 0;
        using var pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var pdbReader = pdbProvider.GetMetadataReader();
        var pdbMethodDebugCount = pdbReader.MethodDebugInformation.Count;

        Assert.Equal(peMethodDefCount, pdbMethodDebugCount);
    }

    [Fact]
    public void MainMethod_HasVisibleSequencePoint_AtExpectedLine()
    {
        const string source = "package main\n\nfunc main() {\n    let x = 42\n}\n";
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source, "prog.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream: peStream, pdbStream: pdbStream, refStream: null);
        Assert.True(result.Success);

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        // Scan every method's debug info for a visible sequence point landing
        // on line 4 (the `let x = 42` line, 1-based).
        var foundLine4 = false;
        foreach (var handle in reader.MethodDebugInformation)
        {
            var info = reader.GetMethodDebugInformation(handle);
            if (info.SequencePointsBlob.IsNil)
            {
                continue;
            }

            foreach (var point in info.GetSequencePoints())
            {
                if (point.IsHidden)
                {
                    continue;
                }

                if (point.StartLine == 4)
                {
                    foundLine4 = true;
                    Assert.True(point.StartColumn >= 1);
                    Assert.True(point.Offset >= 0);
                    break;
                }
            }

            if (foundLine4)
            {
                break;
            }
        }

        Assert.True(foundLine4, "Expected a visible sequence point on source line 4.");
    }
}

internal static class PortablePdbEmitterTestHelpers
{
    // Mirror of PortablePdbEmitter.GSharpLanguageGuid for cross-assembly assertion.
    // Kept in sync via the unit test below in PortablePdbEmitTests — if the
    // emitter ever reissues the GUID this constant must move with it.
    public static readonly Guid GSharpLanguageGuid = new Guid("4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00");
}
