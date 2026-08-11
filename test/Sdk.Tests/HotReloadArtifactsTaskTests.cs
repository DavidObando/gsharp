// <copyright file="HotReloadArtifactsTaskTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Gsharp.HotReload.Runtime;
using Gsharp.NET.Sdk.Tools;
using Microsoft.Build.Utilities;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Tests SDK-generated hot-reload bootstrap and manifest artifacts.
/// </summary>
public class HotReloadArtifactsTaskTests
{
    [Fact]
    public void Execute_WritesDeterministicRelativeBootstrapAndHashedManifest()
    {
        var directory = Path.Combine(Path.GetTempPath(), "gsharp-hot-reload-task-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var project = Path.Combine(directory, "App.gsproj");
            var source = Path.Combine(directory, "Program.gs");
            var manifest = Path.Combine(directory, "obj", "App$Debug.manifest");
            var bootstrap = Path.Combine(directory, "obj", "Bootstrap.g.gs");
            var runtime = Path.Combine(directory, "tools", "Gsharp.HotReload.Runtime.dll");
            File.WriteAllText(project, "<Project />");
            File.WriteAllText(source, "package App");
            Directory.CreateDirectory(Path.Combine(directory, "tools"));
            File.WriteAllText(runtime, "runtime");

            var task = new WriteGsharpHotReloadArtifactsTask
            {
                ProjectPath = project,
                TargetFramework = "net10.0",
                Configuration = "Debug",
                AssemblyName = "App",
                ManifestPath = manifest,
                BootstrapPath = bootstrap,
                UpdateDirectory = Path.Combine(directory, "obj", "updates"),
                RuntimeAssemblyPath = runtime,
                IntermediateDirectory = Path.Combine(directory, "obj"),
                OutputDirectory = Path.Combine(directory, "bin"),
                WatchFiles = new[] { new TaskItem(source) },
            };

            Assert.True(task.Execute());

            var bootstrapText = File.ReadAllText(bootstrap);
            Assert.Contains("@ModuleInitializer", bootstrapText, StringComparison.Ordinal);
            Assert.Contains("\"App$$Debug.manifest\"", bootstrapText, StringComparison.Ordinal);
            Assert.Contains(
                "HotReloadAgent.Start(Assembly.GetExecutingAssembly(), \"App$$Debug.manifest\")",
                bootstrapText,
                StringComparison.Ordinal);
            Assert.DoesNotContain(directory, bootstrapText, StringComparison.Ordinal);

            using var references = ReferenceResolver.WithReferences(
                new[] { typeof(HotReloadAgent).Assembly.Location });
            var image = Emit(bootstrapText, references);
            using var stream = new MemoryStream(image, writable: false);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();
            var moduleType = reader.TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single(type => reader.GetString(type.Name) == "<Module>");
            var moduleInitializerHandle = Assert.Single(moduleType.GetMethods());
            var moduleInitializer = reader.GetMethodDefinition(moduleInitializerHandle);

            Assert.Equal(1, MetadataTokens.GetRowNumber(moduleInitializerHandle));
            Assert.Equal(".cctor", reader.GetString(moduleInitializer.Name));
            Assert.NotEqual(0, moduleInitializer.RelativeVirtualAddress);

            var moduleInitializerIl = peReader
                .GetMethodBody(moduleInitializer.RelativeVirtualAddress)
                .GetILBytes();
            Assert.Equal(6, moduleInitializerIl.Length);
            Assert.Equal(0x28, moduleInitializerIl[0]);
            Assert.Equal(0x2a, moduleInitializerIl[^1]);

            var initializerHandle = MetadataTokens.EntityHandle(
                ReadInlineToken(moduleInitializerIl, 1));
            Assert.Equal(HandleKind.MethodDefinition, initializerHandle.Kind);
            var initializer = reader.GetMethodDefinition((MethodDefinitionHandle)initializerHandle);
            var initializerType = reader.GetTypeDefinition(initializer.GetDeclaringType());
            Assert.Equal("Gsharp.HotReload.Bootstrap", reader.GetString(initializerType.Namespace));
            Assert.Equal("__GsharpHotReloadBootstrap", reader.GetString(initializerType.Name));
            Assert.Equal("Initialize", reader.GetString(initializer.Name));
            Assert.NotEqual(0, initializer.RelativeVirtualAddress);

            var initializerIl = peReader.GetMethodBody(initializer.RelativeVirtualAddress).GetILBytes();
            Assert.Equal(16, initializerIl.Length);
            Assert.Equal(0x28, initializerIl[0]);
            Assert.Equal(0x72, initializerIl[5]);
            Assert.Equal(0x28, initializerIl[10]);
            Assert.Equal(0x2a, initializerIl[^1]);

            var assemblyCallHandle = MetadataTokens.EntityHandle(ReadInlineToken(initializerIl, 1));
            Assert.Equal(HandleKind.MemberReference, assemblyCallHandle.Kind);
            var assemblyCall = reader.GetMemberReference((MemberReferenceHandle)assemblyCallHandle);
            var assemblyType = GetMemberReferenceParentType(reader, assemblyCall);
            Assert.Equal("System.Reflection", reader.GetString(assemblyType.Namespace));
            Assert.Equal("Assembly", reader.GetString(assemblyType.Name));
            Assert.Equal("GetExecutingAssembly", reader.GetString(assemblyCall.Name));

            var manifestHandle = MetadataTokens.UserStringHandle(
                ReadInlineToken(initializerIl, 6) & 0x00ffffff);
            Assert.Equal("App$Debug.manifest", reader.GetUserString(manifestHandle));

            var startCallHandle = MetadataTokens.EntityHandle(ReadInlineToken(initializerIl, 11));
            Assert.Equal(HandleKind.MemberReference, startCallHandle.Kind);
            var startCall = reader.GetMemberReference((MemberReferenceHandle)startCallHandle);
            var agentType = GetMemberReferenceParentType(reader, startCall);
            Assert.Equal("Gsharp.HotReload.Runtime", reader.GetString(agentType.Namespace));
            Assert.Equal("HotReloadAgent", reader.GetString(agentType.Name));
            Assert.Equal("Start", reader.GetString(startCall.Name));

            var manifestLines = File.ReadAllLines(manifest);
            Assert.Equal("GSHARP-HOT-RELOAD-1", manifestLines[0]);
            Assert.Contains(manifestLines, line => line.StartsWith("project\t", StringComparison.Ordinal));
            Assert.Contains(manifestLines, line => line.StartsWith("watch\t", StringComparison.Ordinal));
            Assert.DoesNotContain(manifestLines, line => line.EndsWith("\tmissing", StringComparison.Ordinal));
            Assert.Equal(
                "runtime",
                File.ReadAllText(Path.Combine(directory, "bin", "Gsharp.HotReload.Runtime.dll")));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static byte[] Emit(string source, ReferenceResolver references)
    {
        var compilation = new Compilation(references, SyntaxTree.Parse(source))
        {
            AssemblyName = "HotReloadBootstrapTests",
            IsLibrary = true,
            Optimize = false,
        };
        using var peStream = new MemoryStream();
        var result = compilation.Emit(
            peStream,
            pdbStream: null,
            refStream: null,
            assemblyName: "HotReloadBootstrapTests",
            assemblyVersion: "1.0.0");

        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));
        return peStream.ToArray();
    }

    private static int ReadInlineToken(ImmutableArray<byte> il, int offset)
    {
        Assert.InRange(offset, 0, il.Length - sizeof(int));
        return BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(offset, sizeof(int)));
    }

    private static TypeReference GetMemberReferenceParentType(
        MetadataReader reader,
        MemberReference memberReference)
    {
        Assert.Equal(HandleKind.TypeReference, memberReference.Parent.Kind);
        return reader.GetTypeReference((TypeReferenceHandle)memberReference.Parent);
    }
}
