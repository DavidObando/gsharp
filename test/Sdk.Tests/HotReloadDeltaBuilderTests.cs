// <copyright file="HotReloadDeltaBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
                    private func Initialize() {}
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

        var update = new HotReloadDeltaBuilder(baseline).CreateUpdate(current);

        Assert.Equal(HotReloadDeltaStatus.Unsupported, update.Status);
        Assert.Contains("GSHR1001", update.Diagnostic, System.StringComparison.Ordinal);
        Assert.Contains("MethodDef", update.Diagnostic, System.StringComparison.Ordinal);
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
}
