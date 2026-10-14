// <copyright file="HotReloadArtifactsTaskTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import Gsharp.HotReload.Runtime
import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Buffers.Binary
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Tests SDK-generated hot-reload bootstrap and manifest artifacts.
open class HotReloadArtifactsTaskTests {
    @Fact
    func Execute_WritesDeterministicRelativeBootstrapAndHashedManifest() {
        let directory = Path.Combine(Path.GetTempPath(), "gsharp-hot-reload-task-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let project = Path.Combine(directory, "App.gsproj")
            let source = Path.Combine(directory, "Program.gs")
            let manifest = Path.Combine(directory, "obj", "App$$Debug.manifest")
            let bootstrap = Path.Combine(directory, "obj", "Bootstrap.g.gs")
            let runtime = Path.Combine(directory, "tools", "Gsharp.HotReload.Runtime.dll")
            File.WriteAllText(project, "<Project />")
            File.WriteAllText(source, "package App")
            Directory.CreateDirectory(Path.Combine(directory, "tools"))
            File.WriteAllText(runtime, "runtime")
            let task = WriteGsharpHotReloadArtifactsTask{
                ProjectPath: project,
                TargetFramework: "net10.0",
                Configuration: "Debug",
                AssemblyName: "App",
                ManifestPath: manifest,
                BootstrapPath: bootstrap,
                UpdateDirectory: Path.Combine(directory, "obj", "updates"),
                RuntimeAssemblyPath: runtime,
                IntermediateDirectory: Path.Combine(directory, "obj"),
                OutputDirectory: Path.Combine(directory, "bin"),
                WatchFiles: cast[[]ITaskItem]([]TaskItem{TaskItem(source)})
            }
            Assert.True(task.Execute())
            let bootstrapText = File.ReadAllText(bootstrap)
            Assert.Contains("@ModuleInitializer", bootstrapText, StringComparison.Ordinal)
            Assert.Contains("\"App$$$$Debug.manifest\"", bootstrapText, StringComparison.Ordinal)
            Assert.Contains(
                "HotReloadAgent.Start(Assembly.GetExecutingAssembly(), \"App$$$$Debug.manifest\")",
                bootstrapText,
                StringComparison.Ordinal
            )
            Assert.DoesNotContain(directory, bootstrapText, StringComparison.Ordinal)
            using let references = ReferenceResolver.WithReferences([]string{typeof(HotReloadAgent).Assembly.Location})
            let image = Emit(bootstrapText, references)
            using let stream = MemoryStream(image, writable: false)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let moduleType = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((type TypeDefinition) -> reader.GetString(type.Name) == "<Module>")
            let moduleInitializerHandle = Assert.Single(moduleType.GetMethods())
            let moduleInitializer = reader.GetMethodDefinition(moduleInitializerHandle)
            Assert.Equal(1, MetadataTokens.GetRowNumber(moduleInitializerHandle))
            Assert.Equal(".cctor", reader.GetString(moduleInitializer.Name))
            Assert.NotEqual(0, moduleInitializer.RelativeVirtualAddress)
            let moduleInitializerIl[]?uint8 = peReader.GetMethodBody(moduleInitializer.RelativeVirtualAddress)
                .GetILBytes()
            Assert.Equal(6, moduleInitializerIl!!.Length)
            Assert.Equal(0x28, int32(moduleInitializerIl!![0]))
            Assert.Equal(0x2a, int32(moduleInitializerIl!![^1]))
            let initializerHandle = MetadataTokens.EntityHandle(ReadInlineToken(moduleInitializerIl, 1))
            Assert.Equal(HandleKind.MethodDefinition, initializerHandle.Kind)
            let initializer = reader.GetMethodDefinition(MethodDefinitionHandle(initializerHandle))
            let initializerType = reader.GetTypeDefinition(initializer.GetDeclaringType())
            Assert.Equal("Gsharp.HotReload.Bootstrap", reader.GetString(initializerType.Namespace))
            Assert.Equal("__GsharpHotReloadBootstrap", reader.GetString(initializerType.Name))
            Assert.Equal("Initialize", reader.GetString(initializer.Name))
            Assert.NotEqual(0, initializer.RelativeVirtualAddress)
            let initializerIl[]?uint8 = peReader.GetMethodBody(initializer.RelativeVirtualAddress).GetILBytes()
            Assert.Equal(16, initializerIl!!.Length)
            Assert.Equal(0x28, int32(initializerIl!![0]))
            Assert.Equal(0x72, int32(initializerIl!![5]))
            Assert.Equal(0x28, int32(initializerIl!![10]))
            Assert.Equal(0x2a, int32(initializerIl!![^1]))
            let assemblyCallHandle = MetadataTokens.EntityHandle(ReadInlineToken(initializerIl, 1))
            Assert.Equal(HandleKind.MemberReference, assemblyCallHandle.Kind)
            let assemblyCall = reader.GetMemberReference(MemberReferenceHandle(assemblyCallHandle))
            let assemblyType = GetMemberReferenceParentType(reader, assemblyCall)
            Assert.Equal("System.Reflection", reader.GetString(assemblyType.Namespace))
            Assert.Equal("Assembly", reader.GetString(assemblyType.Name))
            Assert.Equal("GetExecutingAssembly", reader.GetString(assemblyCall.Name))
            let manifestHandle = MetadataTokens.UserStringHandle(ReadInlineToken(initializerIl, 6) & 0x00ffffff)
            Assert.Equal("App$$Debug.manifest", reader.GetUserString(manifestHandle))
            let startCallHandle = MetadataTokens.EntityHandle(ReadInlineToken(initializerIl, 11))
            Assert.Equal(HandleKind.MemberReference, startCallHandle.Kind)
            let startCall = reader.GetMemberReference(MemberReferenceHandle(startCallHandle))
            let agentType = GetMemberReferenceParentType(reader, startCall)
            Assert.Equal("Gsharp.HotReload.Runtime", reader.GetString(agentType.Namespace))
            Assert.Equal("HotReloadAgent", reader.GetString(agentType.Name))
            Assert.Equal("Start", reader.GetString(startCall.Name))
            let manifestLines = File.ReadAllLines(manifest)
            Assert.Equal("GSHARP-HOT-RELOAD-1", manifestLines[0])
            Assert.Contains(manifestLines, (line string) -> line.StartsWith("project\t", StringComparison.Ordinal))
            Assert.Contains(manifestLines, (line string) -> line.StartsWith("watch\t", StringComparison.Ordinal))
            Assert.DoesNotContain(manifestLines, (line string) -> line.EndsWith("\tmissing", StringComparison.Ordinal))
            Assert.Equal("runtime", File.ReadAllText(Path.Combine(directory, "bin", "Gsharp.HotReload.Runtime.dll")))
            let copiedRuntime = Path.Combine(directory, "bin", "Gsharp.HotReload.Runtime.dll")
            File.Delete(copiedRuntime)
            File.Delete(bootstrap)
            task.CopyRuntime = false
            task.WriteBootstrap = false
            Assert.True(task.Execute())
            Assert.False(File.Exists(copiedRuntime))
            Assert.False(File.Exists(bootstrap))
            Assert.True(File.Exists(manifest))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func Emit(source string, references ReferenceResolver)[]uint8 {
            let compilation = Compilation(references, SyntaxTree.Parse(source)){
                AssemblyName = "HotReloadBootstrapTests",
                IsLibrary = true,
                Optimize = false
            }
            using let peStream = MemoryStream()
            let result = compilation.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "HotReloadBootstrapTests",
                assemblyVersion: "1.0.0"
            )
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            return peStream.ToArray()
        }

        private func ReadInlineToken(il[]?uint8, offset int32) int32 {
            Assert.InRange(offset, 0, il!!.Length - 4)
            return BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(offset, 4))
        }

        private func GetMemberReferenceParentType(
            reader MetadataReader,
            memberReference MemberReference
        ) TypeReference {
            Assert.Equal(HandleKind.TypeReference, memberReference.Parent.Kind)
            return reader.GetTypeReference(TypeReferenceHandle(memberReference.Parent))
        }
    }
}
