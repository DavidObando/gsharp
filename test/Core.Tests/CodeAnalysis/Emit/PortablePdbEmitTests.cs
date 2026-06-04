// <copyright file="PortablePdbEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
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
        var result = compilation.Emit(peStream, pdbStream, null);

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
        var result = compilation.Emit(peStream, pdbStream, null);

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
        var result = compilation.Emit(peStream, pdbStream, null);
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
    public void Document_HashMatchesRawFileBytes_IncludingBom()
    {
        // A debugger computes the source checksum over the exact on-disk bytes
        // (BOM included). The PDB document hash must match those raw bytes — not
        // a re-encoded copy of the decoded text — or on-disk source resolution
        // fails and breakpoints never bind. Use a UTF-8 BOM, which File.ReadAllText
        // strips from the decoded text, to guard the regression.
        var sample = Path.Combine(Path.GetTempPath(), $"gs_pdbhash_{Guid.NewGuid():N}.gs");
        var rawBytes = Encoding.UTF8.GetPreamble()
            .Concat(Encoding.UTF8.GetBytes("package main\n\nfunc main() {\n    let x = 1\n}\n"))
            .ToArray();
        File.WriteAllBytes(sample, rawBytes);

        try
        {
            using var peStream = new MemoryStream();
            using var pdbStream = new MemoryStream();

            var compilation = new Compilation(SyntaxTree.Load(sample))
            {
                DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
            };
            var result = compilation.Emit(peStream, pdbStream, null);
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

            pdbStream.Position = 0;
            using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
            var reader = provider.GetMetadataReader();

            var doc = reader.GetDocument(reader.Documents.Single());
            var pdbHash = reader.GetBlobBytes(doc.Hash);

            byte[] expected;
            using (var sha = SHA256.Create())
            {
                expected = sha.ComputeHash(File.ReadAllBytes(sample));
            }

            Assert.Equal(expected, pdbHash);
        }
        finally
        {
            File.Delete(sample);
        }
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
        var result = compilation.Emit(peStream, pdbStream, null);
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
        var result = compilation.Emit(peStream, pdbStream, null);
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

public class PortablePdbPhase5Tests
{
    private const string ThreeLocalsProgram = @"package main

func main() {
    let x = 1
    let y = 2
    let z = x + y
}
";

    [Fact]
    public void Method_With_UserLocals_Emits_LocalScope_And_LocalVariable_Rows()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        Assert.True(reader.LocalScopes.Count >= 1, "expected at least one LocalScope row");
        Assert.True(reader.LocalVariables.Count >= 3, $"expected ≥3 LocalVariable rows for x/y/z, got {reader.LocalVariables.Count}");

        var localNames = new System.Collections.Generic.HashSet<string>();
        foreach (var lvh in reader.LocalVariables)
        {
            var lv = reader.GetLocalVariable(lvh);
            localNames.Add(reader.GetString(lv.Name));
        }

        Assert.Contains("x", localNames);
        Assert.Contains("y", localNames);
        Assert.Contains("z", localNames);
    }

    [Fact]
    public void LocalScope_Length_Equals_Method_Body_Size()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var pe = new System.Reflection.PortableExecutable.PEReader(peStream);
        var peReader = pe.GetMetadataReader();

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var pdbReader = provider.GetMetadataReader();

        foreach (var lsh in pdbReader.LocalScopes)
        {
            var scope = pdbReader.GetLocalScope(lsh);
            Assert.Equal(0, scope.StartOffset);

            var method = peReader.GetMethodDefinition(scope.Method);
            var body = pe.GetMethodBody(method.RelativeVirtualAddress);
            Assert.Equal(body.GetILBytes().Length, scope.Length);
        }
    }

    [Fact]
    public void Every_LocalScope_References_A_Root_ImportScope()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        Assert.True(reader.ImportScopes.Count >= 1, "expected a root ImportScope row");

        foreach (var lsh in reader.LocalScopes)
        {
            var scope = reader.GetLocalScope(lsh);
            Assert.False(scope.ImportScope.IsNil, "every LocalScope must reference an ImportScope");
        }
    }

    [Fact]
    public void SequencePoints_Header_References_Method_LocalSignature()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var pe = new System.Reflection.PortableExecutable.PEReader(peStream);
        var peReader = pe.GetMetadataReader();

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var pdbReader = provider.GetMetadataReader();

        // Find a method with locals and verify the PDB sequence-point header
        // identifies the same StandaloneSignature row that the PE method body
        // points at via localVariablesSignature.
        var verified = false;
        foreach (var mdih in pdbReader.MethodDebugInformation)
        {
            var mdi = pdbReader.GetMethodDebugInformation(mdih);
            if (mdi.LocalSignature.IsNil)
            {
                continue;
            }

            var methodHandle = MetadataTokens.MethodDefinitionHandle(MetadataTokens.GetRowNumber(mdih));
            var method = peReader.GetMethodDefinition(methodHandle);
            var body = pe.GetMethodBody(method.RelativeVirtualAddress);
            Assert.Equal(MetadataTokens.GetRowNumber(body.LocalSignature), MetadataTokens.GetRowNumber(mdi.LocalSignature));
            verified = true;
        }

        Assert.True(verified, "expected at least one method with a non-nil LocalSignature in the PDB header");
    }
}

/// <summary>
/// Phase 6 (issue #216) acceptance tests for <c>LocalConstant</c> PDB rows.
/// A <c>const</c>-declared binding with a literal initializer must produce a
/// <c>LocalConstant</c> row in the Portable PDB and must NOT occupy an IL slot.
/// </summary>
public class PortablePdbLocalConstantTests
{
    private const string ConstFloatProgram = @"package main

func main() {
    const PI = 3.14
    let x = PI + 1.0
}
";

    private const string MultipleConstsProgram = @"package main

func main() {
    const A = 1
    const B = true
    const C = ""hello""
    let x = A
}
";

    [Fact]
    public void Const_Float_Produces_LocalConstant_Row()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ConstFloatProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        Assert.True(reader.LocalConstants.Count >= 1, $"expected ≥1 LocalConstant row, got {reader.LocalConstants.Count}");

        // Find the PI constant row.
        string piName = null;
        byte[] piBlob = null;
        foreach (var handle in reader.LocalConstants)
        {
            var lc = reader.GetLocalConstant(handle);
            var name = reader.GetString(lc.Name);
            if (name == "PI")
            {
                piName = name;
                piBlob = reader.GetBlobBytes(lc.Signature);
                break;
            }
        }

        Assert.NotNull(piName);
        Assert.NotNull(piBlob);

        // Blob[0] must be ELEMENT_TYPE_R8 (0x0D), followed by 8 bytes of the value.
        Assert.True(piBlob.Length >= 9, $"expected ≥9 blob bytes for R8 constant, got {piBlob.Length}");
        Assert.Equal(0x0D, piBlob[0]);
        var encodedValue = BitConverter.ToDouble(piBlob, 1);
        Assert.Equal(3.14, encodedValue, precision: 10);
    }

    [Fact]
    public void Const_Does_Not_Allocate_IL_Slot()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ConstFloatProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var pdbReader = pdbProvider.GetMetadataReader();

        // PI must not appear in LocalVariables (it has no IL slot).
        foreach (var handle in pdbReader.LocalVariables)
        {
            var lv = pdbReader.GetLocalVariable(handle);
            Assert.NotEqual("PI", pdbReader.GetString(lv.Name));
        }
    }

    [Fact]
    public void LocalScope_ConstantList_Anchors_Constant_Range()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ConstFloatProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        // There must be a LocalScope whose constantList points at a valid constant row.
        bool found = false;
        foreach (var handle in reader.LocalScopes)
        {
            var scope = reader.GetLocalScope(handle);
            var constantHandle = scope.GetLocalConstants();
            if (!constantHandle.GetEnumerator().MoveNext())
            {
                continue;
            }

            // Scope has at least one constant — verify the PI row is reachable.
            foreach (var ch in scope.GetLocalConstants())
            {
                var lc = reader.GetLocalConstant(ch);
                var name = reader.GetString(lc.Name);
                if (name == "PI")
                {
                    found = true;
                    break;
                }
            }

            if (found)
            {
                break;
            }
        }

        Assert.True(found, "expected a LocalScope whose constantList contains the PI LocalConstant row");
    }

    [Fact]
    public void Multiple_Const_Types_All_Produce_Rows()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(MultipleConstsProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        var names = new System.Collections.Generic.HashSet<string>();
        foreach (var handle in reader.LocalConstants)
        {
            var lc = reader.GetLocalConstant(handle);
            names.Add(reader.GetString(lc.Name));
        }

        Assert.Contains("A", names);
        Assert.Contains("B", names);
        Assert.Contains("C", names);
    }

    /// <summary>
    /// Issue #421 (P2-11): a <c>null</c> string constant must produce a
    /// well-formed <c>LocalConstant</c> blob (<c>ELEMENT_TYPE_STRING</c>
    /// followed by the <c>0xFF</c> sentinel per Portable PDB spec §II.23.2)
    /// rather than being silently dropped. Drives the private
    /// <c>EncodeLocalConstantSignature</c> encoder directly via reflection
    /// because the source language has no surface syntax for a typed
    /// <c>const</c> initialised to <c>nil</c>.
    /// </summary>
    [Fact]
    public void Null_String_Constant_Is_Encoded_As_NullString_Sentinel()
    {
        var emitter = new PortablePdbEmitter(new DebugInformationOptions { Format = DebugInformationFormat.Portable });
        var method = typeof(PortablePdbEmitter).GetMethod(
            "EncodeLocalConstantSignature",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(method);

        var nullHandle = (BlobHandle)method.Invoke(emitter, new object[] { null });

        // The pre-fix code matched `case string str:` (which never matches
        // null) and fell through to `default: return default`, producing a
        // nil BlobHandle that the caller then dropped — so the LocalConstant
        // row never reached the PDB. A non-nil handle here proves the
        // regression is fixed.
        Assert.False(nullHandle.IsNil, "null constant must produce a non-nil signature blob (regression: previously fell through to default and was dropped)");

        // A sibling non-null string still produces its own distinct blob —
        // confirms the null path didn't accidentally collapse onto the
        // empty-string encoding.
        var emptyHandle = (BlobHandle)method.Invoke(emitter, new object[] { string.Empty });
        Assert.False(emptyHandle.IsNil);
        Assert.NotEqual(nullHandle, emptyHandle);

        // Equal blobs deduplicate through GetOrAddBlob, so two null encodings
        // must round-trip to the same handle — i.e. the encoder is
        // deterministic, not accidentally emitting per-call garbage.
        var secondNullHandle = (BlobHandle)method.Invoke(emitter, new object[] { null });
        Assert.Equal(nullHandle, secondNullHandle);
    }
}

internal static class PortablePdbEmitterTestHelpers
{
    // Mirror of PortablePdbEmitter.GSharpLanguageGuid for cross-assembly assertion.
    // Kept in sync via the unit test in PortablePdbEmitTests — if the
    // emitter ever reissues the GUID this constant must move with it.
    public static readonly Guid GSharpLanguageGuid = new Guid("4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00");

    // Mirror of PortablePdbEmitter's CustomDebugInformation kind GUIDs;
    // used by Phase 6 acceptance tests to look up specific CDI rows.
    public static readonly Guid EmbeddedSourceKind = new Guid("0E8A571B-6926-466E-B4AD-8AB04611F5FE");
    public static readonly Guid SourceLinkKind = new Guid("CC110556-A091-4D38-9FEC-25AB9A351A6A");
    public static readonly Guid CompilationOptionsKind = new Guid("B5FEEC05-8CD0-4A83-96DA-466284BB4BD8");
}

public class PortablePdbPhase6Tests
{
    private const string SimpleProgram = @"package main

func main() {
    let x = 1
}
";

    [Fact]
    public void EmbeddedSource_IsAbsent_When_EmbedAllSources_Is_False()
    {
        var (_, pdb) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });
        Assert.Empty(FindCdi(pdb, PortablePdbEmitterTestHelpers.EmbeddedSourceKind));
    }

    [Fact]
    public void EmbeddedSource_IsPresent_When_EmbedAllSources_Is_True()
    {
        var (_, pdb) = EmitWith(new DebugInformationOptions
        {
            Format = DebugInformationFormat.Portable,
            EmbedAllSources = true,
        });

        var rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.EmbeddedSourceKind);
        Assert.NotEmpty(rows);

        // Decode the first embedded-source blob: int32 formatMarker, then bytes.
        var blob = pdb.GetBlobBytes(rows[0].Value);
        Assert.True(blob.Length > 4);
        var formatMarker = blob[0] | (blob[1] << 8) | (blob[2] << 16) | (blob[3] << 24);
        Assert.Equal(0, formatMarker); // Phase 6: uncompressed
        var sourceBytes = new byte[blob.Length - 4];
        System.Buffer.BlockCopy(blob, 4, sourceBytes, 0, sourceBytes.Length);
        var sourceText = System.Text.Encoding.UTF8.GetString(sourceBytes);
        Assert.Contains("func main()", sourceText);
    }

    [Fact]
    public void EmbeddedSource_Parent_Is_A_Document_Row()
    {
        var (_, pdb) = EmitWith(new DebugInformationOptions
        {
            Format = DebugInformationFormat.Portable,
            EmbedAllSources = true,
        });

        var rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.EmbeddedSourceKind);
        Assert.NotEmpty(rows);
        foreach (var (parent, _) in rows)
        {
            Assert.Equal(HandleKind.Document, parent.Kind);
        }
    }

    [Fact]
    public void SourceLink_BlobMatches_File_Contents()
    {
        var sourceLinkPath = Path.Combine(Path.GetTempPath(), $"sl-{Guid.NewGuid():N}.json");
        var json = @"{ ""documents"": { ""*"": ""https://example.com/raw/*"" } }";
        File.WriteAllText(sourceLinkPath, json);

        try
        {
            var (_, pdb) = EmitWith(new DebugInformationOptions
            {
                Format = DebugInformationFormat.Portable,
                SourceLinkFilePath = sourceLinkPath,
            });

            var rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.SourceLinkKind);
            Assert.Single(rows);
            var blob = pdb.GetBlobBytes(rows[0].Value);
            Assert.Equal(File.ReadAllBytes(sourceLinkPath), blob);

            // SourceLink CDI must be parented on the Module row.
            Assert.Equal(HandleKind.ModuleDefinition, rows[0].Parent.Kind);
        }
        finally
        {
            File.Delete(sourceLinkPath);
        }
    }

    [Fact]
    public void SourceLink_IsAbsent_When_No_File_Configured()
    {
        var (_, pdb) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });
        Assert.Empty(FindCdi(pdb, PortablePdbEmitterTestHelpers.SourceLinkKind));
    }

    [Fact]
    public void CompilationOptions_Always_Emitted_With_Compiler_And_Language_Identifiers()
    {
        var (_, pdb) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });
        var rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.CompilationOptionsKind);
        Assert.Single(rows);

        var blob = pdb.GetBlobBytes(rows[0].Value);
        var options = DecodeCompilationOptions(blob);

        Assert.Equal("gsc", options["compiler-name"]);
        Assert.Equal("GSharp", options["language"]);
        Assert.Equal("1.0", options["language-version"]);
        Assert.True(options.ContainsKey("compiler-version"));
        Assert.False(string.IsNullOrWhiteSpace(options["compiler-version"]));

        // CompilationOptions CDI must be parented on the Module row.
        Assert.Equal(HandleKind.ModuleDefinition, rows[0].Parent.Kind);
    }

    private static (MemoryStream Pe, MetadataReader Pdb) EmitWith(DebugInformationOptions options)
    {
        var peStream = new MemoryStream();
        var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = options,
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        return (peStream, provider.GetMetadataReader());
    }

    private static System.Collections.Generic.List<(EntityHandle Parent, BlobHandle Value)> FindCdi(
        MetadataReader reader, Guid kind)
    {
        var matches = new System.Collections.Generic.List<(EntityHandle, BlobHandle)>();
        foreach (var handle in reader.CustomDebugInformation)
        {
            var cdi = reader.GetCustomDebugInformation(handle);
            if (reader.GetGuid(cdi.Kind) == kind)
            {
                matches.Add((cdi.Parent, cdi.Value));
            }
        }

        return matches;
    }

    private static System.Collections.Generic.Dictionary<string, string> DecodeCompilationOptions(byte[] blob)
    {
        // Format: (utf8 name \0 utf8 value \0)*
        var dict = new System.Collections.Generic.Dictionary<string, string>(System.StringComparer.Ordinal);
        var i = 0;
        while (i < blob.Length)
        {
            var nameStart = i;
            while (i < blob.Length && blob[i] != 0)
            {
                i++;
            }

            var name = System.Text.Encoding.UTF8.GetString(blob, nameStart, i - nameStart);
            i++; // skip null
            var valueStart = i;
            while (i < blob.Length && blob[i] != 0)
            {
                i++;
            }

            var value = System.Text.Encoding.UTF8.GetString(blob, valueStart, i - valueStart);
            i++; // skip null
            dict[name] = value;
        }

        return dict;
    }
}

public class PortablePdbPhase7Tests
{
    private const string SimpleProgram = @"package main

func main() {
    let x = 1
}
";

    [Fact]
    public void Portable_Writes_CodeView_And_PdbChecksum_Into_PE_DebugDirectory()
    {
        var (pe, _) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });
        var entries = ReadDebugDirectoryEntries(pe);

        Assert.Contains(entries, e => e.Type == DebugDirectoryEntryType.CodeView);
        Assert.Contains(entries, e => e.Type == DebugDirectoryEntryType.PdbChecksum);
    }

    [Fact]
    public void CodeView_PdbPath_Defaults_To_Bare_PdbFileName()
    {
        var (pe, _) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });
        using var peReader = new PEReader(new MemoryStream(pe.ToArray()));
        var cv = peReader.ReadDebugDirectory()
            .Single(e => e.Type == DebugDirectoryEntryType.CodeView);
        var data = peReader.ReadCodeViewDebugDirectoryData(cv);

        // Default path when /pdb:<path> is not set should be "<asm>.pdb".
        Assert.EndsWith(".pdb", data.Path, StringComparison.Ordinal);
        Assert.DoesNotContain('/', data.Path);
        Assert.DoesNotContain('\\', data.Path);
    }

    [Fact]
    public void CodeView_PdbPath_Is_Absolute_For_Sidecar_When_PdbFilePath_Is_Relative()
    {
        // Regression for #421 (P2-8): a relative /pdb:<path> (or a relative
        // /out:<path> that defaults the PDB beside it) used to flow into the
        // CodeView entry verbatim, leaving vsdbg unable to locate the sidecar
        // from its working directory. The emitter must root the path.
        var peStream = new MemoryStream();
        var pdbStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions
            {
                Format = DebugInformationFormat.Portable,
                PdbFilePath = Path.Combine("relative", "sub", "out.pdb"),
            },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        using var peReader = new PEReader(new MemoryStream(peStream.ToArray()));
        var cv = peReader.ReadDebugDirectory()
            .Single(e => e.Type == DebugDirectoryEntryType.CodeView);
        var data = peReader.ReadCodeViewDebugDirectoryData(cv);

        Assert.True(Path.IsPathRooted(data.Path), $"expected rooted CodeView path, got: {data.Path}");
        Assert.EndsWith("out.pdb", data.Path, StringComparison.Ordinal);
    }

    [Fact]
    public void CodeView_PdbPath_Is_Bare_Filename_For_Embedded_When_PdbFilePath_Has_Directory()
    {
        // For embedded format the CodeView path is conventionally just the
        // bare ".pdb" file name (no directory) because the consumer reads the
        // PDB blob out of the PE itself. A directory portion would be
        // misleading and inconsistent with csc.
        var peStream = new MemoryStream();
        var pdbStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions
            {
                Format = DebugInformationFormat.Embedded,
                PdbFilePath = Path.Combine(Path.GetTempPath(), "some", "dir", "embedded.pdb"),
            },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        using var peReader = new PEReader(new MemoryStream(peStream.ToArray()));
        var cv = peReader.ReadDebugDirectory()
            .Single(e => e.Type == DebugDirectoryEntryType.CodeView);
        var data = peReader.ReadCodeViewDebugDirectoryData(cv);

        Assert.Equal("embedded.pdb", data.Path);
    }

    [Fact]
    public void CodeView_Pdb_ContentId_Matches_Sidecar_PdbId()
    {
        var (pe, pdbBytes) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });

        using var peReader = new PEReader(new MemoryStream(pe.ToArray()));
        var cv = peReader.ReadDebugDirectory()
            .Single(e => e.Type == DebugDirectoryEntryType.CodeView);
        var data = peReader.ReadCodeViewDebugDirectoryData(cv);

        using var pdbProvider = MetadataReaderProvider.FromPortablePdbStream(new MemoryStream(pdbBytes));
        var pdbReader = pdbProvider.GetMetadataReader();
        var pdbId = pdbReader.DebugMetadataHeader.Id;

        // Portable PDB content id layout: first 16 bytes = guid, next 4 = stamp.
        var pdbGuid = new Guid(pdbId.Slice(0, 16).ToArray());
        Assert.Equal(pdbGuid, data.Guid);
    }

    [Fact]
    public void PdbChecksum_Algorithm_Is_SHA256_And_Matches_Pdb_Content()
    {
        var (pe, pdbBytes) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });

        using var peReader = new PEReader(new MemoryStream(pe.ToArray()));
        var cs = peReader.ReadDebugDirectory()
            .Single(e => e.Type == DebugDirectoryEntryType.PdbChecksum);
        var data = peReader.ReadPdbChecksumDebugDirectoryData(cs);

        Assert.Equal("SHA256", data.AlgorithmName);

        using var sha = SHA256.Create();
        var expected = sha.ComputeHash(pdbBytes);
        Assert.Equal(expected, data.Checksum.ToArray());
    }

    [Fact]
    public void Reproducible_Entry_Is_Present_When_Deterministic_Is_True()
    {
        var (pe, _) = EmitWith(new DebugInformationOptions
        {
            Format = DebugInformationFormat.Portable,
            Deterministic = true,
        });

        var entries = ReadDebugDirectoryEntries(pe);
        Assert.Contains(entries, e => e.Type == DebugDirectoryEntryType.Reproducible);
    }

    [Fact]
    public void Reproducible_Entry_Is_Absent_When_Deterministic_Is_False()
    {
        var (pe, _) = EmitWith(new DebugInformationOptions { Format = DebugInformationFormat.Portable });
        var entries = ReadDebugDirectoryEntries(pe);
        Assert.DoesNotContain(entries, e => e.Type == DebugDirectoryEntryType.Reproducible);
    }

    [Fact]
    public void Pdb_DebugDirectory_Entries_Are_Absent_When_DebugFormat_Is_None()
    {
        var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.None },
        };
        var result = compilation.Emit(peStream, null, null);
        Assert.True(result.Success);

        using var peReader = new PEReader(new MemoryStream(peStream.ToArray()));
        var entries = peReader.ReadDebugDirectory();

        // ManagedPEBuilder may insert a bare Reproducible entry when given a
        // deterministicIdProvider; what must NOT appear are PDB-pointing
        // entries since the caller did not request debug info.
        Assert.DoesNotContain(entries, e => e.Type == DebugDirectoryEntryType.CodeView);
        Assert.DoesNotContain(entries, e => e.Type == DebugDirectoryEntryType.PdbChecksum);
        Assert.DoesNotContain(entries, e => e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb);
    }

    [Fact]
    public void Embedded_Format_Writes_EmbeddedPortablePdb_Entry_And_Suppresses_Sidecar()
    {
        var peStream = new MemoryStream();
        var pdbStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Embedded },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        // Embedded format must not produce sidecar bytes even if the caller
        // passed a stream — Roslyn behaves the same way.
        Assert.Equal(0, pdbStream.Length);

        using var peReader = new PEReader(new MemoryStream(peStream.ToArray()));
        var entries = peReader.ReadDebugDirectory();
        Assert.Contains(entries, e => e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb);
        Assert.Contains(entries, e => e.Type == DebugDirectoryEntryType.CodeView);
        Assert.Contains(entries, e => e.Type == DebugDirectoryEntryType.PdbChecksum);
    }

    [Fact]
    public void Embedded_Portable_Pdb_Roundtrips_With_Original_Documents()
    {
        var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Embedded },
        };
        var result = compilation.Emit(peStream, null, null);
        Assert.True(result.Success);

        using var peReader = new PEReader(new MemoryStream(peStream.ToArray()));
        var embed = peReader.ReadDebugDirectory()
            .Single(e => e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb);
        using var pdbProvider = peReader.ReadEmbeddedPortablePdbDebugDirectoryData(embed);
        var pdbReader = pdbProvider.GetMetadataReader();

        Assert.Equal(1, (int)pdbReader.Documents.Count);
        var doc = pdbReader.GetDocument(pdbReader.Documents.First());
        Assert.Equal("main.gs", pdbReader.GetString(doc.Name));
        Assert.Equal(PortablePdbEmitterTestHelpers.GSharpLanguageGuid, pdbReader.GetGuid(doc.Language));
    }

    private static (MemoryStream Pe, byte[] PdbBytes) EmitWith(DebugInformationOptions options)
    {
        var peStream = new MemoryStream();
        var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = options,
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));
        return (peStream, pdbStream.ToArray());
    }

    private static System.Collections.Immutable.ImmutableArray<DebugDirectoryEntry> ReadDebugDirectoryEntries(MemoryStream pe)
    {
        using var peReader = new PEReader(new MemoryStream(pe.ToArray()));
        return peReader.ReadDebugDirectory();
    }
}

/// <summary>
/// Issue #217: per-file <c>ImportScope</c> chain tests. Verifies that explicit
/// namespace imports in a GSharp source file are encoded into <c>ImportScope</c>
/// blobs that debuggers can use to resolve unqualified type names.
/// </summary>
public class PortablePdbPhase217Tests
{
    private const string ProgramWithImports = @"package main

import System.Collections.Generic

func main() {
    let x = 1
    let y = 2
    let z = x + y
}
";

    private const string ProgramWithAliasImport = @"package main

import gen = System.Collections.Generic

func main() {
    let x = 1
}
";

    private const string ProgramWithNoExplicitImports = @"package main

func main() {
    let x = 1
}
";

    [Fact]
    public void ImportScope_Blob_Contains_Namespace_For_Explicit_Import()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithImports, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        // Expect at least two ImportScope rows: the root (empty) + one per-file scope.
        Assert.True(reader.ImportScopes.Count >= 2, $"expected ≥2 ImportScope rows, got {reader.ImportScopes.Count}");

        // At least one non-root scope must decode to a namespace import for System.Collections.Generic.
        var foundNamespace = false;
        foreach (var handle in reader.ImportScopes)
        {
            var scope = reader.GetImportScope(handle);
            foreach (var import in scope.GetImports())
            {
                if (import.Kind == ImportDefinitionKind.ImportNamespace)
                {
                    var ns = Encoding.UTF8.GetString(reader.GetBlobBytes(import.TargetNamespace));
                    if (ns == "System.Collections.Generic")
                    {
                        foundNamespace = true;
                        break;
                    }
                }
            }

            if (foundNamespace)
            {
                break;
            }
        }

        Assert.True(foundNamespace, "expected an ImportScope row whose blob contains a namespace import for System.Collections.Generic");
    }

    [Fact]
    public void ImportScope_Blob_Contains_Alias_And_Namespace_For_Alias_Import()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithAliasImport, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        Assert.True(reader.ImportScopes.Count >= 2, $"expected ≥2 ImportScope rows, got {reader.ImportScopes.Count}");

        var foundAlias = false;
        foreach (var handle in reader.ImportScopes)
        {
            var scope = reader.GetImportScope(handle);
            foreach (var import in scope.GetImports())
            {
                if (import.Kind == ImportDefinitionKind.AliasNamespace)
                {
                    var alias = Encoding.UTF8.GetString(reader.GetBlobBytes((BlobHandle)import.Alias));
                    var ns = Encoding.UTF8.GetString(reader.GetBlobBytes(import.TargetNamespace));
                    if (alias == "gen" && ns == "System.Collections.Generic")
                    {
                        foundAlias = true;
                        break;
                    }
                }
            }

            if (foundAlias)
            {
                break;
            }
        }

        Assert.True(foundAlias, "expected an ImportScope row whose blob contains AliasNamespace(gen → System.Collections.Generic)");
    }

    [Fact]
    public void Every_LocalScope_References_The_Per_Tree_ImportScope()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithImports, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        // Find the per-file scope (a scope whose parent is not nil).
        ImportScopeHandle perFileScope = default;
        foreach (var handle in reader.ImportScopes)
        {
            var scope = reader.GetImportScope(handle);
            if (!scope.Parent.IsNil)
            {
                perFileScope = handle;
                break;
            }
        }

        Assert.False(perFileScope.IsNil, "expected at least one per-file ImportScope (with a non-nil parent)");

        // Every LocalScope that references an ImportScope should reference
        // the per-file scope, not the root.
        foreach (var lsh in reader.LocalScopes)
        {
            var ls = reader.GetLocalScope(lsh);
            Assert.False(ls.ImportScope.IsNil, "every LocalScope must reference an ImportScope");
            Assert.Equal(perFileScope, ls.ImportScope);
        }
    }

    [Fact]
    public void Program_With_No_Explicit_Imports_Still_Produces_Root_ImportScope_Only()
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithNoExplicitImports, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var reader = provider.GetMetadataReader();

        // Without explicit imports there is only the single root scope.
        Assert.Equal(1, (int)reader.ImportScopes.Count);

        foreach (var lsh in reader.LocalScopes)
        {
            var ls = reader.GetLocalScope(lsh);
            Assert.False(ls.ImportScope.IsNil, "every LocalScope must reference an ImportScope");
        }
    }
}

/// <summary>
/// Issue #219: <c>CompilationMetadataReferences</c>
/// <c>CustomDebugInformation</c> acceptance tests. Verifies that a CDI row
/// keyed on <c>7E4D4708-096E-4C5C-AEDA-CB10BA6A740D</c> is written at the
/// module level, and that the blob contains one record per file-backed
/// reference with the expected layout and correct MVID.
/// </summary>
public class PortablePdbPhase219Tests
{
    public static readonly Guid CompilationMetadataReferencesKind = new Guid("7E4D4708-096E-4C5C-AEDA-CB10BA6A740D");

    private const string SimpleProgram = @"package main

func main() {
    let x = 1
}
";

    [Fact]
    public void CompilationMetadataReferences_CDI_Is_Emitted_As_Module_Level_Row()
    {
        var (_, pdb) = EmitWithDefault();
        var rows = FindCdi(pdb, CompilationMetadataReferencesKind);

        Assert.NotEmpty(rows);
        Assert.All(rows, row => Assert.Equal(HandleKind.ModuleDefinition, row.Parent.Kind));
    }

    [Fact]
    public void CompilationMetadataReferences_Blob_Contains_SystemConsole_With_Matching_Mvid()
    {
        // System.Console is always loaded by the Default() resolver via
        // WellKnownBclAssemblyNames. Skip the test on environments where the
        // assembly has no on-disk location (e.g. single-file publish).
        var consolePath = typeof(Console).Assembly.Location;
        if (string.IsNullOrEmpty(consolePath) || !File.Exists(consolePath))
        {
            return;
        }

        var (_, pdb) = EmitWithDefault();
        var rows = FindCdi(pdb, CompilationMetadataReferencesKind);
        Assert.NotEmpty(rows);

        var blob = pdb.GetBlobBytes(rows[0].Value);
        var records = DecodeReferenceRecords(blob);

        // The blob must contain a record for System.Console.dll.
        var consoleRecord = records.FirstOrDefault(r =>
            r.FileName.EndsWith("System.Console.dll", StringComparison.OrdinalIgnoreCase));
        Assert.NotNull(consoleRecord.FileName);

        // Its MVID must match the MVID read directly from the PE file.
        Guid expectedMvid;
        using (var fs = new FileStream(consolePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var peReader = new PEReader(fs))
        {
            var mdReader = peReader.GetMetadataReader();
            var module = mdReader.GetModuleDefinition();
            expectedMvid = mdReader.GetGuid(module.Mvid);
        }

        Assert.Equal(expectedMvid, consoleRecord.Mvid);
    }

    [Fact]
    public void CompilationMetadataReferences_Record_Flags_Mark_Assembly_Kind()
    {
        var consolePath = typeof(Console).Assembly.Location;
        if (string.IsNullOrEmpty(consolePath) || !File.Exists(consolePath))
        {
            return;
        }

        var (_, pdb) = EmitWithDefault();
        var rows = FindCdi(pdb, CompilationMetadataReferencesKind);
        var blob = pdb.GetBlobBytes(rows[0].Value);
        var records = DecodeReferenceRecords(blob);

        // Every record must have bit 1 set (MetadataImageKind.Assembly = 0x02).
        Assert.All(records, r => Assert.Equal(0x02, r.Flags & 0x02));
    }

    private static (MemoryStream Pe, MetadataReader Pdb) EmitWithDefault()
    {
        var peStream = new MemoryStream();
        var pdbStream = new MemoryStream();

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var result = compilation.Emit(peStream, pdbStream, null);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.Message)));

        pdbStream.Position = 0;
        var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        return (peStream, provider.GetMetadataReader());
    }

    private static System.Collections.Generic.List<(EntityHandle Parent, BlobHandle Value)> FindCdi(
        MetadataReader reader, Guid kind)
    {
        var matches = new System.Collections.Generic.List<(EntityHandle, BlobHandle)>();
        foreach (var handle in reader.CustomDebugInformation)
        {
            var cdi = reader.GetCustomDebugInformation(handle);
            if (reader.GetGuid(cdi.Kind) == kind)
            {
                matches.Add((cdi.Parent, cdi.Value));
            }
        }

        return matches;
    }

    private static System.Collections.Generic.List<RefRecord> DecodeReferenceRecords(byte[] blob)
    {
        var records = new System.Collections.Generic.List<RefRecord>();
        var i = 0;
        while (i < blob.Length)
        {
            var fileName = ReadNullTerminatedUtf8(blob, ref i);
            var aliases = ReadNullTerminatedUtf8(blob, ref i);
            var flags = blob[i++];
            var timeStamp = System.BitConverter.ToUInt32(blob, i);
            i += 4;
            var fileSize = System.BitConverter.ToUInt32(blob, i);
            i += 4;
            var mvidBytes = new byte[16];
            System.Buffer.BlockCopy(blob, i, mvidBytes, 0, 16);
            i += 16;
            records.Add(new RefRecord(fileName, aliases, flags, timeStamp, fileSize, new Guid(mvidBytes)));
        }

        return records;
    }

    private static string ReadNullTerminatedUtf8(byte[] blob, ref int i)
    {
        var start = i;
        while (i < blob.Length && blob[i] != 0)
        {
            i++;
        }

        var s = System.Text.Encoding.UTF8.GetString(blob, start, i - start);
        i++; // skip null terminator
        return s;
    }

    private readonly record struct RefRecord(
        string FileName,
        string Aliases,
        byte Flags,
        uint TimeStamp,
        uint FileSize,
        Guid Mvid);
}
