// <copyright file="HotReloadDeltaBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Gsharp.HotReload.Runtime;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Tests G#'s System.Reflection.Metadata-based Edit-and-Continue deltas.
/// </summary>
public class HotReloadDeltaBuilderTests
{
    [Fact]
    public void ModuleInitializerAttribute_EmitsModuleStaticConstructor()
    {
        var image = Emit(
            """
            package HotReloadTests
            import System.Runtime.CompilerServices

            class Bootstrap {
                shared {
                    @ModuleInitializer
                    internal func Initialize() {}
                }
            }
            """);

        using var stream = new MemoryStream(image, writable: false);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var moduleType = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(type => reader.GetString(type.Name) == "<Module>");
        var moduleInitializer = moduleType.GetMethods()
            .Select(reader.GetMethodDefinition)
            .Single(method => reader.GetString(method.Name) == ".cctor");

        Assert.NotEqual(0, moduleInitializer.RelativeVirtualAddress);
        var il = peReader.GetMethodBody(moduleInitializer.RelativeVirtualAddress).GetILBytes();
        Assert.Equal(0x28, il[0]);
        Assert.Equal(0x2a, il[^1]);
    }

    [Fact]
    public void MethodBodyEdit_ProducesMinimalEncDelta()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func Value() int32 { return 1 }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Value() int32 { return 2 }
            """);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status);
        Assert.NotEmpty(update.MetadataDelta);
        Assert.NotEmpty(update.IlDelta);
        Assert.Empty(update.PdbDelta);
        Assert.Contains(update.UpdatedMethods, name => name.EndsWith(".Value", System.StringComparison.Ordinal));

        using var provider = MetadataReaderProvider.FromMetadataImage(
            ImmutableArray.CreateRange(update.MetadataDelta));
        var reader = provider.GetMetadataReader();
        Assert.True(reader.GetTableRowCount(TableIndex.MethodDef) > 0);
        Assert.True(reader.GetTableRowCount(TableIndex.EncLog) > 0);
        Assert.Contains(
            reader.GetEditAndContinueMapEntries(),
            handle => handle.Kind == HandleKind.MethodDefinition);
        Assert.Equal(1, reader.GetModuleDefinition().Generation);
    }

    [Fact]
    public void MultipleMethodBodyEdits_PreserveMethodDefinitionRowsAndEmitCompleteDelta()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func First() int32 { return 1 }
            func Middle() int32 { return 2 }
            func Last() int32 { return 3 }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func First() int32 { return 11 }
            func Middle() int32 { return 2 }
            func Last() int32 { return 33 }
            """);
        var methodNames = new[] { "First", "Middle", "Last" };
        var baselineRows = GetMethodDefinitionRows(baseline, methodNames);
        var currentRows = GetMethodDefinitionRows(current, methodNames);

        Assert.Equal(methodNames.Length, baselineRows.Count);
        Assert.Equal(methodNames.Length, currentRows.Count);
        Assert.All(methodNames, name => Assert.Equal(baselineRows[name], currentRows[name]));

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status);
        Assert.Equal(
            new[] { "First", "Last" },
            update.UpdatedMethods
                .Select(name => name[(name.LastIndexOf('.') + 1)..])
                .ToArray());
        Assert.NotEmpty(update.MetadataDelta);
        Assert.NotEmpty(update.IlDelta);
        Assert.Empty(update.PdbDelta);

        using var provider = MetadataReaderProvider.FromMetadataImage(
            ImmutableArray.CreateRange(update.MetadataDelta));
        var reader = provider.GetMetadataReader();
        Assert.Equal(1, reader.GetModuleDefinition().Generation);
        Assert.Equal(2, reader.GetTableRowCount(TableIndex.MethodDef));

        var deltaMethods = reader.MethodDefinitions
            .Select(handle => (
                Handle: handle,
                Definition: reader.GetMethodDefinition(handle)))
            .ToArray();

        var expectedHandles = new[]
        {
            MetadataTokens.MethodDefinitionHandle(baselineRows["First"]),
            MetadataTokens.MethodDefinitionHandle(baselineRows["Last"]),
        };
        var mappedMethods = reader.GetEditAndContinueMapEntries()
            .Where(handle => handle.Kind == HandleKind.MethodDefinition)
            .Select(handle => (MethodDefinitionHandle)handle)
            .ToArray();
        Assert.Equal(expectedHandles, mappedMethods);

        var loggedMethods = reader.GetEditAndContinueLogEntries()
            .Where(entry => entry.Handle.Kind == HandleKind.MethodDefinition)
            .ToArray();
        Assert.Equal(
            expectedHandles,
            loggedMethods.Select(entry => (MethodDefinitionHandle)entry.Handle).ToArray());
        Assert.All(
            loggedMethods,
            entry => Assert.Equal(EditAndContinueOperation.Default, entry.Operation));

        Assert.All(
            deltaMethods,
            method => Assert.NotEqual(0, method.Definition.RelativeVirtualAddress));
        Assert.NotEqual(
            deltaMethods[0].Definition.RelativeVirtualAddress,
            deltaMethods[1].Definition.RelativeVirtualAddress);
        Assert.Equal(
            11,
            ReadReturnedInt32(update.IlDelta, deltaMethods[0].Definition.RelativeVirtualAddress));
        Assert.Equal(
            33,
            ReadReturnedInt32(update.IlDelta, deltaMethods[1].Definition.RelativeVirtualAddress));
    }

    [Fact]
    public void StringLiteralEdit_AddsUserStringHeapEntry()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func Value() string { return "before" }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Value() string { return "after" }
            """);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status);
        using var provider = MetadataReaderProvider.FromMetadataImage(
            ImmutableArray.CreateRange(update.MetadataDelta));
        Assert.True(provider.GetMetadataReader().GetHeapSize(HeapIndex.UserString) > 1);
    }

    [Fact]
    public void ConsecutiveEdits_AdvanceEncGenerationAndBaseId()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func Value() string { return "one" }
            """);
        var second = Emit(
            """
            package HotReloadTests
            func Value() string { return "two" }
            """);
        var third = Emit(
            """
            package HotReloadTests
            func Value() string { return "three" }
            """);
        var builder = new HotReloadDeltaBuilder(baseline);

        var firstUpdate = builder.CreateUpdate(second);
        Assert.Equal(HotReloadDeltaStatus.Ready, firstUpdate.Status);
        firstUpdate.Commit();

        var secondUpdate = builder.CreateUpdate(third);
        Assert.Equal(HotReloadDeltaStatus.Ready, secondUpdate.Status);
        using var provider = MetadataReaderProvider.FromMetadataImage(
            ImmutableArray.CreateRange(secondUpdate.MetadataDelta));
        var module = provider.GetMetadataReader().GetModuleDefinition();
        Assert.Equal(2, module.Generation);
        Assert.False(module.BaseGenerationId.IsNil);
    }

    [Fact]
    public void NewLocalSignature_IsMappedIntoDelta()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func Value() int32 { return 1 }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Value() int32 {
                var value int32 = 2
                return value
            }
            """);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Ready, update.Status);
        using var provider = MetadataReaderProvider.FromMetadataImage(
            ImmutableArray.CreateRange(update.MetadataDelta));
        var reader = provider.GetMetadataReader();
        Assert.True(reader.GetTableRowCount(TableIndex.StandAloneSig) > 0);
        Assert.Contains(
            reader.GetEditAndContinueMapEntries(),
            handle => handle.Kind == HandleKind.StandaloneSignature);
    }

    [Fact]
    public void AddedMethod_ReportsExplicitRestartDiagnostic()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func Value() int32 { return 1 }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Value() int32 { return 2 }
            func Added() int32 { return 3 }
            """);
        var baselineMethodCount = GetTableRowCount(baseline, TableIndex.MethodDef);
        var currentMethodCount = GetTableRowCount(current, TableIndex.MethodDef);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status);
        Assert.Contains("GSHR1001", update.Diagnostic, System.StringComparison.Ordinal);
        Assert.Contains("MethodDef", update.Diagnostic, System.StringComparison.Ordinal);
        Assert.Contains(
            $"MethodDef rows {baselineMethodCount} -> {currentMethodCount}",
            update.Diagnostic,
            StringComparison.Ordinal);
        Assert.Contains("requires restart", update.Diagnostic, StringComparison.Ordinal);
        Assert.Empty(update.MetadataDelta);
        Assert.Empty(update.IlDelta);
        Assert.Empty(update.UpdatedMethods);
    }

    [Fact]
    public void MethodThatStartsSuspending_ReportsGshr1002RestartDiagnostic()
    {
        // ADR-0174 P3-9: adding a channel receive to a plain func flips its
        // compiled shape (int32 -> ValueTask[int32] state machine) — a body
        // edit at the source level that is a signature change in metadata.
        var baseline = Emit(
            """
            package HotReloadTests
            func Value(ch chan[int32]) int32 { return 1 }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Value(ch chan[int32]) int32 { return <-ch }
            """);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status);
        Assert.StartsWith("GSHR1002: method 'HotReloadTests.<Program>.Value' changed suspension", update.Diagnostic, StringComparison.Ordinal);
        Assert.Contains("now performs a channel operation", update.Diagnostic, StringComparison.Ordinal);
        Assert.Contains("Restart required", update.Diagnostic, StringComparison.Ordinal);
        Assert.Empty(update.MetadataDelta);
        Assert.Empty(update.IlDelta);
    }

    [Fact]
    public void MethodThatStopsSuspending_ReportsGshr1002RestartDiagnostic()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func Value(ch chan[int32]) int32 { return <-ch }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Value(ch chan[int32]) int32 { return 1 }
            """);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status);
        Assert.StartsWith("GSHR1002: method 'HotReloadTests.<Program>.Value' changed suspension", update.Diagnostic, StringComparison.Ordinal);
        Assert.Contains("no longer performs a channel operation", update.Diagnostic, StringComparison.Ordinal);
    }

    [Fact]
    public void SuspendingMethod_BodyEdit_KeepsSuspending_IsNotGshr1002()
    {
        // The same method suspending before and after is an ordinary body edit
        // as far as the suspension check goes; whatever else the delta builder
        // says about it, it must not be blamed on a suspension change.
        var baseline = Emit(
            """
            package HotReloadTests
            func Value(ch chan[int32]) int32 { return <-ch }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Value(ch chan[int32]) int32 { return <-ch + 1 }
            """);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.DoesNotContain("GSHR1002", update.Diagnostic ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    public void RenamedMethod_ReportsMetadataShapeRestartDiagnostic()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            func Value() int32 { return 1 }
            """);
        var current = Emit(
            """
            package HotReloadTests
            func Renamed() int32 { return 1 }
            """);

        Assert.Equal(
            GetTableRowCount(baseline, TableIndex.MethodDef),
            GetTableRowCount(current, TableIndex.MethodDef));

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status);
        Assert.Equal(
            "GSHR1001: MethodDef metadata changed. Restart required; in-place updates currently support existing managed method bodies only.",
            update.Diagnostic);
        Assert.Empty(update.MetadataDelta);
        Assert.Empty(update.IlDelta);
        Assert.Empty(update.UpdatedMethods);
    }

    [Fact]
    public void NewMetadataReference_ReportsExplicitRestartDiagnostic()
    {
        var baseline = Emit(
            """
            package HotReloadTests
            import System

            func Value() int32 { return 1 }
            """);
        var current = Emit(
            """
            package HotReloadTests
            import System

            func Value() int32 { return Math.Abs(-1) }
            """);

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status);
        Assert.Contains("GSHR1001", update.Diagnostic, StringComparison.Ordinal);
        Assert.Contains("rows", update.Diagnostic, StringComparison.Ordinal);
        Assert.Contains("requires restart", update.Diagnostic, StringComparison.Ordinal);
        Assert.Empty(update.MetadataDelta);
        Assert.Empty(update.IlDelta);
        Assert.Empty(update.PdbDelta);
    }

    private static byte[] Emit(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source))
        {
            AssemblyName = "HotReloadTests",
            IsLibrary = true,
            Optimize = false,
        };
        using var peStream = new MemoryStream();
        var result = compilation.Emit(
            peStream,
            pdbStream: null,
            refStream: null,
            assemblyName: "HotReloadTests",
            assemblyVersion: "1.0.0");

        Assert.True(
            result.Success,
            string.Join(System.Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));
        return peStream.ToArray();
    }

    private static Dictionary<string, int> GetMethodDefinitionRows(
        byte[] image,
        IEnumerable<string> methodNames)
    {
        var names = methodNames.ToHashSet(StringComparer.Ordinal);
        using var stream = new MemoryStream(image, writable: false);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        return reader.MethodDefinitions
            .Select(handle => (
                Name: reader.GetString(reader.GetMethodDefinition(handle).Name),
                Row: MetadataTokens.GetRowNumber(handle)))
            .Where(method => names.Contains(method.Name))
            .ToDictionary(method => method.Name, method => method.Row, StringComparer.Ordinal);
    }

    private static int GetTableRowCount(byte[] image, TableIndex table)
    {
        using var stream = new MemoryStream(image, writable: false);
        using var peReader = new PEReader(stream);
        return peReader.GetMetadataReader().GetTableRowCount(table);
    }

    private static int ReadReturnedInt32(byte[] ilDelta, int methodBodyOffset)
    {
        Assert.InRange(methodBodyOffset, 0, ilDelta.Length - 1);
        var body = ilDelta.AsSpan(methodBodyOffset);
        var format = body[0] & 0x3;
        int headerSize;
        int codeSize;
        if (format == 0x2)
        {
            headerSize = 1;
            codeSize = body[0] >> 2;
        }
        else if (format == 0x3)
        {
            Assert.True(body.Length >= 12);
            var flagsAndSize = BinaryPrimitives.ReadUInt16LittleEndian(body[..2]);
            headerSize = ((flagsAndSize >> 12) & 0xf) * 4;
            codeSize = BinaryPrimitives.ReadInt32LittleEndian(body.Slice(4, 4));
        }
        else
        {
            throw new BadImageFormatException(
                $"Unexpected managed method header format 0x{format:x2}.");
        }

        Assert.True(headerSize > 0);
        Assert.True(codeSize > 0);
        Assert.True(body.Length >= headerSize + codeSize);
        var il = body.Slice(headerSize, codeSize);
        Assert.Equal(0x2a, il[^1]);

        int value;
        int instructionSize;
        if (il[0] == 0x15)
        {
            value = -1;
            instructionSize = 1;
        }
        else if (il[0] >= 0x16 && il[0] <= 0x1e)
        {
            value = il[0] - 0x16;
            instructionSize = 1;
        }
        else if (il[0] == 0x1f)
        {
            Assert.True(il.Length >= 3);
            value = unchecked((sbyte)il[1]);
            instructionSize = 2;
        }
        else if (il[0] == 0x20)
        {
            Assert.True(il.Length >= 6);
            value = BinaryPrimitives.ReadInt32LittleEndian(il.Slice(1, 4));
            instructionSize = 5;
        }
        else
        {
            throw new BadImageFormatException(
                $"Expected ldc.i4 at the start of the delta method body, found 0x{il[0]:x2}.");
        }

        Assert.Equal(instructionSize + 1, il.Length);
        return value;
    }
}
