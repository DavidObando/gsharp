// <copyright file="Issue4792ProjectReferencedStaticHolderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.InteropServices
import System.Security.Cryptography
import System.Text.Json
import System.Threading.Tasks
import Xunit

open class Issue4792ProjectReferencedStaticHolderTests {
    @Theory
    @InlineData("source")
    @InlineData("metadata")
    @InlineData("current")
    async func ExplicitCalls_KeepOriginalHolderAndInstanceDispatch(referenceKind string) {
        let workspace = Path.Combine(AppContext.BaseDirectory, "issue4792-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(workspace)
        try {
            File.WriteAllText(Path.Combine(workspace, "Directory.Build.props"), "<Project />")
            File.WriteAllText(Path.Combine(workspace, "Directory.Build.targets"), "<Project />")
            let library = Path.Combine(workspace, "Lib")
            let caller = Path.Combine(workspace, "Caller")
            Directory.CreateDirectory(library)
            Directory.CreateDirectory(caller)
            File.WriteAllText(Path.Combine(library, "Producer.cs"), Producer)
            File.WriteAllText(Path.Combine(caller, "Consumer.cs"), Consumer)
            File.WriteAllText(
                Path.Combine(library, "Lib.csproj"),
                Issue4792ProjectReferencedStaticHolderTests.Project("Issue4792Contracts")
            )
            File.WriteAllText(
                Path.Combine(caller, "Caller.csproj"),
                Issue4792ProjectReferencedStaticHolderTests.Project("Issue4792Caller", "../Lib/Lib.csproj")
            )
            let project = Path.Combine(caller, "Caller.csproj")
            Run(workspace, "sdk-restore", "dotnet", []string{"restore", project, "--locked-mode", "-nr:false"})
            Run(
                workspace,
                "sdk-native-build",
                "dotnet",
                []string{
                    "build",
                    project,
                    "--configuration",
                    "Release",
                    "--no-restore",
                    "-graph",
                    "-nr:false",
                    "-p:UseSharedCompilation=false",
                    "-warnaserror",
                    "-bl:" + Path.Combine(workspace, "native.binlog")
                }
            )
            let nativeProducer = Path.Combine(library, "bin", "Release", "net10.0", "Issue4792Contracts.dll")
            let nativeCaller = Path.Combine(caller, "bin", "Release", "net10.0", "Issue4792Caller.dll")
            Assert.True(File.Exists(Path.ChangeExtension(nativeProducer, ".pdb")))
            Assert.True(File.Exists(Path.ChangeExtension(nativeCaller, ".pdb")))
            Assert.Equal("11,11,99,11,ok,4,True,False,2", Execute(nativeProducer, nativeCaller))
            let projects = await CSharpProjectLoader.LoadProjectWithReferencesAsync(project)
            let producer = Assert.Single(
                projects,
                (candidate LoadedCSharpProject) -> candidate.Compilation.AssemblyName == "Issue4792Contracts"
            )
            Assert.True(producer.BoundWithoutErrors)
            let reference MetadataReference = if referenceKind == "metadata" {
                cast[MetadataReference](MetadataReference.CreateFromFile(nativeProducer))
            } else {
                cast[MetadataReference](producer.Compilation.ToMetadataReference())
            }
            let consumer = (
                if referenceKind == "source" {
                    Assert.Single(
                        projects,
                        (candidate LoadedCSharpProject) -> candidate.Compilation.AssemblyName == "Issue4792Caller"
                    )
                } else {
                    CSharpProjectLoader.LoadInMemory(
                        [](string, Consumer string){(Path.Combine(caller, "Consumer.cs"), Consumer)},
                        CSharpProjectLoader.RuntimeReferences().Append(reference).ToArray(),
                        "Issue4792Caller"
                    )
                }
            )
            Assert.True(consumer.BoundWithoutErrors)
            Assert.Equal(referenceKind != "metadata", reference is CompilationReference)
            if referenceKind == "source" {
                Assert.Contains(
                    consumer.Compilation.References,
                    (candidate MetadataReference) -> candidate is CompilationReference
                )
            }
            let siblings IReadOnlyList[CSharpCompilation]? = if referenceKind == "source" {
                default([]?CSharpCompilation)
            } else {
                []CSharpCompilation{producer.Compilation, consumer.Compilation}
            }
            var producerGs = Translate(producer, siblings)
            var consumerGs string
            if referenceKind == "current" {
                let combined = CSharpProjectLoader.LoadInMemory(
                    [](string, string){
                        (Path.Combine(library, "Producer.cs"), Producer),
                        (
                            Path.Combine(caller, "Consumer.cs"),
                            Consumer.Replace(
                                "[assembly: System.Reflection.AssemblyVersion(\"1.0.0.0\")]",
                                string.Empty,
                                StringComparison.Ordinal
                            )
                        )
                    },
                    CSharpProjectLoader.RuntimeReferences(),
                    "Issue4792Contracts"
                )
                Assert.True(combined.BoundWithoutErrors)
                consumerGs = TranslateDocument(combined, combined.Documents[1], nil)
                producerGs = TranslateDocument(combined, combined.Documents[0], nil)
            } else {
                consumerGs = Translate(consumer, siblings)
            }
            File.WriteAllText(Path.Combine(workspace, "Producer.gs"), producerGs)
            File.WriteAllText(Path.Combine(workspace, "Consumer.gs"), consumerGs)
            let emittedProducer = Path.Combine(workspace, "Issue4792Contracts.dll")
            let emittedCaller = if referenceKind == "current" {
                emittedProducer
            } else {
                Path.Combine(workspace, "Issue4792Caller.dll")
            }
            let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
            Assert.NotNull(compiler)
            let framework = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
            Assert.NotEmpty(framework)
            var arguments = []string{
                compiler!!,
                "/target:library",
                "/out:" + emittedProducer,
                "/assemblyname:Issue4792Contracts"
            }
                .Concat(framework.Select((path string) -> ("/reference:" + path)))
                .Concat(
                if referenceKind == "current" {
                    []string{Path.Combine(workspace, "Producer.gs"), Path.Combine(workspace, "Consumer.gs")}
                } else {
                    []string{Path.Combine(workspace, "Producer.gs")}
                }
            )
                .ToArray()
            Run(workspace, "gsc-producer", "dotnet", arguments)
            if referenceKind != "current" {
                arguments = []string{
                    compiler!!,
                    "/target:library",
                    "/out:" + emittedCaller,
                    "/assemblyname:Issue4792Caller",
                    "/reference:" + emittedProducer
                }
                    .Concat(framework.Select((path string) -> ("/reference:" + path)))
                    .Append(Path.Combine(workspace, "Consumer.gs"))
                    .ToArray()
                Run(workspace, "gsc-caller", "dotnet", arguments)
            }
            let preservedConsumer string? = Execute(emittedProducer, nativeCaller)
            let actual string? = Execute(emittedProducer, emittedCaller)
            File.WriteAllText(
                Path.Combine(workspace, "runtime.json"),
                JsonSerializer.Serialize(
                    AnonymousType4_C10354D3EABFCC03(
                        "11,11,99,11,ok,4,True,False,2",
                        preservedConsumer,
                        actual,
                        referenceKind
                    )
                )
            )
            File.WriteAllText(
                Path.Combine(workspace, "products.json"),
                JsonSerializer.Serialize(
                    AnonymousType8_11AF4E7CD5CA693D(
                        nativeProducer,
                        nativeCaller,
                        emittedProducer,
                        emittedCaller,
                        AnonymousType2_EF761F1D4BC46F08(compiler, Hash(compiler)),
                        AnonymousType2_EF761F1D4BC46F08(
                            typeof(CSharpToGSharpTranslator).Assembly.Location,
                            Hash(typeof(CSharpToGSharpTranslator).Assembly.Location)
                        ),
                        AnonymousType2_EF761F1D4BC46F08(
                            typeof(Issue4792ProjectReferencedStaticHolderTests).Assembly.Location,
                            Hash(typeof(Issue4792ProjectReferencedStaticHolderTests).Assembly.Location)
                        ),
                        framework.Select((path string) -> AnonymousType2_EF761F1D4BC46F08(path, Hash(path)))
                    ),
                    JsonSerializerOptions{WriteIndented: true}
                )
            )
            AssertTargets(workspace, nativeProducer, nativeCaller, "native")
            AssertTargets(workspace, emittedProducer, emittedCaller, "gs")
            Assert.Equal("11,11,99,11,ok,4,True,False,2", preservedConsumer)
            Assert.Equal("11,11,99,11,ok,4,True,False,2", actual)
        } finally {
            try {
                if Environment.GetEnvironmentVariable("CS2GS_ISSUE4792_ARTIFACTS_DIR") is string artifacts {
                    let destination = Path.Combine(artifacts, referenceKind + "-" + Path.GetFileName(workspace))
                    for file in Directory.GetFiles(workspace, "*", SearchOption.AllDirectories) {
                        let target = Path.Combine(destination, Path.GetRelativePath(workspace, file))
                        Directory.CreateDirectory(Path.GetDirectoryName(target)!!)
                        File.Copy(file, target)
                    }
                }
            } finally {
                Directory.Delete(workspace, recursive: true)
            }
        }
    }

    shared {
        private const Producer string = `#nullable enable
using System.Threading.Tasks;
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace Issue4792.Contracts;
public class Node
{
    public int Value = 4;
    public Task<int> Gate = Task.FromResult(17);
}
public sealed class DerivedNode : Node
{
    public int Read() => 99;
    public Task<int> Wait() => Task.FromResult(99);
}
public static class Holder
{
    public static int Read(this Node node) => node.Value + 7;
    public static T Echo<T>(this Node node, T value) where T : class => value;
    public static Task<int> Envelope(this Node node) => node.Gate;
    public static async Task<int> Wait(this Node node)
    {
        await Task.CompletedTask;
        return node.Value;
    }
}`

        private const Consumer string = `#nullable enable
using System;
using System.Threading.Tasks;
using Issue4792.Contracts;
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace Issue4792.Consumer;
public static class Caller
{
    public static int Explicit(DerivedNode node) => Holder.Read(node);
    public static int Qualified(DerivedNode node) => Issue4792.Contracts.Holder.Read(node);
    public static int Instance(DerivedNode node) => node.Read();
    public static int Canonical(Node node) => node.Read();
    public static string Generic(DerivedNode node) => Holder.Echo(node, "ok");
    public static Task<int> Async(DerivedNode node) => Holder.Wait(node);
    public static Task<int> Envelope(Node node) => Holder.Envelope(node);
    public static Task<int> ReducedEnvelope(Node node) => node.Envelope();
    public static string Run()
    {
        var node = new DerivedNode();
        var pending = new TaskCompletionSource<int>();
        node.Gate = pending.Task;
        int hits = 0;
        DerivedNode Next() { hits++; return node; }
        return string.Join(",", new object[] {
            Explicit(Next()), Qualified(Next()), Instance(node), Canonical(node),
            Generic(node), Async(node).GetAwaiter().GetResult(),
            ReferenceEquals(Envelope(node), pending.Task)
                && ReferenceEquals(ReducedEnvelope(node), pending.Task),
            pending.Task.IsCompleted, hits });
    }
}`

        private func Project(assembly string, reference string? = nil) string -> (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <AssemblyName>` + "$assembly" + `</AssemblyName>
    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
    <Nullable>enable</Nullable>
    <DebugType>portable</DebugType>
  </PropertyGroup>
  ` + "${(if reference == nil { string.Empty } else { "<ItemGroup><ProjectReference Include=\"$reference\" /></ItemGroup>" })}" + `
</Project>`)

        private func Translate(
            project LoadedCSharpProject,
            siblings IReadOnlyList[CSharpCompilation]?
        ) string -> TranslateDocument(project, Assert.Single(project.Documents), siblings)

        private func TranslateDocument(
            project LoadedCSharpProject,
            document LoadedDocument,
            siblings IReadOnlyList[CSharpCompilation]?
        ) string {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath, siblings)
            let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return rendered
        }

        private func Run(workspace string, label string, executable string, arguments[]string) {
            let result = ProcessRunner.Run(executable, arguments)
            File.WriteAllText(
                Path.Combine(workspace, label + ".json"),
                JsonSerializer.Serialize(AnonymousType3_BB16DC1909CBBC88(executable, arguments, result.ExitCode))
            )
            File.WriteAllText(Path.Combine(workspace, label + ".stdout"), result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }

        private func Execute(producer string, caller string) string? {
            let images = if producer == caller {
                []Assembly{EmittedFixture.Load(File.ReadAllBytes(producer), Path.GetDirectoryName(producer))}
            } else {
                EmittedFixture.LoadTogether(
                    Path.GetDirectoryName(producer),
                    File.ReadAllBytes(producer),
                    File.ReadAllBytes(caller)
                )
            }
            return cast[string](
                images.Last().GetType("Issue4792.Consumer.Caller", throwOnError: true)!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
        }

        private func AssertTargets(workspace string, producer string, caller string, label string) {
            let images = if producer == caller {
                []Assembly{EmittedFixture.Load(File.ReadAllBytes(producer), Path.GetDirectoryName(producer))}
            } else {
                EmittedFixture.LoadTogether(
                    Path.GetDirectoryName(producer),
                    File.ReadAllBytes(producer),
                    File.ReadAllBytes(caller)
                )
            }
            let callerType Type? = images.Last().GetType("Issue4792.Consumer.Caller", throwOnError: true)
            let targets = []string{"Explicit", "Qualified", "Generic", "Async", "Envelope", "Instance"}.Select(
                (name string) -> (Caller: name, Target: Assert.Single(Calls(callerType!!.GetMethod(name))))
            )
                .ToList()
            let constructor ConstructorInfo? = images[0].GetType("Issue4792.Contracts.DerivedNode")!!.GetConstructor(
                Type.EmptyTypes
            )
            targets.Add(("DerivedNode..ctor", Assert.Single(Calls(constructor))))
            File.WriteAllText(
                Path.Combine(workspace, label + "-targets.json"),
                JsonSerializer.Serialize(
                    targets.Select(
                        (target(Caller string, Target MethodBase)) -> AnonymousType10_F7541DD5ABDB8942(
                            target.Item1,
                            target.Item2.DeclaringType!!.FullName,
                            target.Item2.IsStatic,
                            target.Item2.Name,
                            target.Item2.Module.Name,
                            target.Item2.Module.ModuleVersionId,
                            target.Item2.DeclaringType!!.Assembly.FullName,
                            target.Item2.MetadataToken,
                            target.Item2.Attributes.ToString(),
                            target
                                .Item2
                                .GetParameters()
                                .Select(
                                (parameter ParameterInfo) -> AnonymousType3_0A6ED820ECE6A41A(
                                    parameter.Name,
                                    parameter.ParameterType.ToString(),
                                    parameter.Attributes.ToString()
                                )
                            )
                        )
                    ),
                    JsonSerializerOptions{WriteIndented: true}
                )
            )
            for target in targets.Take(5) {
                Assert.Equal("Issue4792.Contracts.Holder", target.Item2!!.DeclaringType!!.FullName)
                Assert.True(target.Item2!!.IsStatic)
                Assert.Equal(images[0].ManifestModule.ModuleVersionId, target.Item2!!.Module.ModuleVersionId)
            }
            let instance = targets[5].Item2!!
            Assert.Equal("Issue4792.Contracts.DerivedNode", instance.DeclaringType!!.FullName)
            Assert.False(instance.IsStatic)
            let parent = targets[6].Item2!!
            Assert.Equal("Issue4792.Contracts.Node", parent.DeclaringType!!.FullName)
            Assert.Equal(images[0].ManifestModule.ModuleVersionId, parent.Module.ModuleVersionId)
        }

        private func Calls(method MethodBase?) sequence[MethodBase?] {
            let bytes[]?uint8 = method!!.GetMethodBody()!!.GetILAsByteArray()
            let opcodes = typeof(OpCodes)
                .GetFields(BindingFlags.Public | BindingFlags.Static)
                .Where((field FieldInfo) -> field.FieldType == typeof(OpCode))
                .Select((field FieldInfo) -> OpCode(field.GetValue(nil)))
                .ToDictionary((opcode OpCode) -> unchecked(uint16(opcode.Value)))
            for var index = 0; index < bytes!!.Length; {
                var value uint16 = bytes!![index++]
                if value == uint16(0xfe) {
                    value = uint16((0xfe00 | int32(bytes!![index])))
                    index++
                }
                let opcode = opcodes[value]
                if opcode.OperandType == OperandType.InlineMethod {
                    let token = BitConverter.ToInt32(bytes!!, index)
                    yield method!!.Module.ResolveMethod(token)
                }
                index += switch opcode.OperandType {
                    case OperandType.InlineNone: 0
                    case OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar: 1
                    case OperandType.InlineVar: 2
                    case OperandType.InlineI8 or OperandType.InlineR: 8
                    case OperandType.InlineSwitch: 4 + 4 * BitConverter.ToInt32(bytes!!, index)
                    default: 4
                }
            }
        }

        private func Hash(path string?) string -> Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path!!)))
            .ToLowerInvariant()
    }
}

internal data class AnonymousType4_C10354D3EABFCC03(
    Native string,
    PreservedNativeConsumer string?,
    Emitted string?,
    ReferenceKind string
) { }

internal data class AnonymousType8_11AF4E7CD5CA693D(
    NativeProducer string,
    NativeCaller string,
    EmittedProducer string,
    EmittedCaller string,
    Compiler AnonymousType2_EF761F1D4BC46F08,
    Translator AnonymousType2_EF761F1D4BC46F08,
    Test AnonymousType2_EF761F1D4BC46F08,
    FrameworkReferences IEnumerable[AnonymousType2_EF761F1D4BC46F08?]
) { }

internal data class AnonymousType3_BB16DC1909CBBC88(Executable string, Argv[]string?, ExitCode int32) { }

internal data class AnonymousType3_0A6ED820ECE6A41A(Name string?, Type string, Attributes string) { }

internal data class AnonymousType10_F7541DD5ABDB8942(
    Caller string,
    Owner string?,
    IsStatic bool?,
    Member string,
    Module string,
    ModuleVersionId Guid,
    AssemblyIdentity string?,
    MetadataToken int32,
    Attributes string,
    Parameters IEnumerable[AnonymousType3_0A6ED820ECE6A41A?]
) { }
