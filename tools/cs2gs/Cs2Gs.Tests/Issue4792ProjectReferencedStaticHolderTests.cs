// <copyright file="Issue4792ProjectReferencedStaticHolderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue4792ProjectReferencedStaticHolderTests
{
    private const string Producer = """
        #nullable enable
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
        }
        """;

    private const string Consumer = """
        #nullable enable
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
        }
        """;

    [Theory]
    [InlineData("source")]
    [InlineData("metadata")]
    [InlineData("current")]
    public async Task ExplicitCalls_KeepOriginalHolderAndInstanceDispatch(string referenceKind)
    {
        string workspace = Path.Combine(AppContext.BaseDirectory, "issue4792-fixtures", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workspace);
        try
        {
            File.WriteAllText(Path.Combine(workspace, "Directory.Build.props"), "<Project />");
            File.WriteAllText(Path.Combine(workspace, "Directory.Build.targets"), "<Project />");
            string library = Path.Combine(workspace, "Lib");
            string caller = Path.Combine(workspace, "Caller");
            Directory.CreateDirectory(library);
            Directory.CreateDirectory(caller);
            File.WriteAllText(Path.Combine(library, "Producer.cs"), Producer);
            File.WriteAllText(Path.Combine(caller, "Consumer.cs"), Consumer);
            File.WriteAllText(Path.Combine(library, "Lib.csproj"), Project("Issue4792Contracts"));
            File.WriteAllText(Path.Combine(caller, "Caller.csproj"), Project("Issue4792Caller", "../Lib/Lib.csproj"));
            string project = Path.Combine(caller, "Caller.csproj");
            Run(workspace, "sdk-restore", "dotnet", new[] { "restore", project, "--locked-mode", "-nr:false" });
            Run(workspace, "sdk-native-build", "dotnet", new[] {
                "build", project, "--configuration", "Release", "--no-restore",
                "-graph", "-nr:false", "-p:UseSharedCompilation=false", "-warnaserror",
                "-bl:" + Path.Combine(workspace, "native.binlog"),
            });
            string nativeProducer = Path.Combine(library, "bin", "Release", "net10.0", "Issue4792Contracts.dll");
            string nativeCaller = Path.Combine(caller, "bin", "Release", "net10.0", "Issue4792Caller.dll");
            Assert.True(File.Exists(Path.ChangeExtension(nativeProducer, ".pdb")));
            Assert.True(File.Exists(Path.ChangeExtension(nativeCaller, ".pdb")));
            Assert.Equal("11,11,99,11,ok,4,True,False,2", Execute(nativeProducer, nativeCaller));

            IReadOnlyList<LoadedCSharpProject> projects =
                await CSharpProjectLoader.LoadProjectWithReferencesAsync(project);
            LoadedCSharpProject producer = Assert.Single(projects,
                candidate => candidate.Compilation.AssemblyName == "Issue4792Contracts");
            Assert.True(producer.BoundWithoutErrors);
            MetadataReference reference = referenceKind == "metadata"
                ? MetadataReference.CreateFromFile(nativeProducer)
                : producer.Compilation.ToMetadataReference();
            LoadedCSharpProject consumer = referenceKind == "source"
                ? Assert.Single(projects,
                    candidate => candidate.Compilation.AssemblyName == "Issue4792Caller")
                : CSharpProjectLoader.LoadInMemory(
                    new[] { (Path.Combine(caller, "Consumer.cs"), Consumer) },
                    CSharpProjectLoader.RuntimeReferences().Append(reference).ToArray(), "Issue4792Caller");
            Assert.True(consumer.BoundWithoutErrors);
            Assert.Equal(referenceKind != "metadata", reference is CompilationReference);
            if (referenceKind == "source")
            {
                Assert.Contains(consumer.Compilation.References, candidate => candidate is CompilationReference);
            }
            IReadOnlyList<CSharpCompilation> siblings = referenceKind == "source"
                ? null
                : new[] { producer.Compilation, consumer.Compilation };
            string producerGs = Translate(producer, siblings);
            string consumerGs;
            if (referenceKind == "current")
            {
                LoadedCSharpProject combined = CSharpProjectLoader.LoadInMemory(
                    new[] {
                        (Path.Combine(library, "Producer.cs"), Producer),
                        (Path.Combine(caller, "Consumer.cs"), Consumer.Replace(
                            "[assembly: System.Reflection.AssemblyVersion(\"1.0.0.0\")]",
                            string.Empty, StringComparison.Ordinal)),
                    }, CSharpProjectLoader.RuntimeReferences(), "Issue4792Contracts");
                Assert.True(combined.BoundWithoutErrors);
                consumerGs = TranslateDocument(combined, combined.Documents[1], null);
                producerGs = TranslateDocument(combined, combined.Documents[0], null);
            }
            else
            {
                consumerGs = Translate(consumer, siblings);
            }

            File.WriteAllText(Path.Combine(workspace, "Producer.gs"), producerGs);
            File.WriteAllText(Path.Combine(workspace, "Consumer.gs"), consumerGs);
            string emittedProducer = Path.Combine(workspace, "Issue4792Contracts.dll");
            string emittedCaller = referenceKind == "current" ? emittedProducer : Path.Combine(workspace, "Issue4792Caller.dll");
            string compiler = GscInvoker.Resolve(null, "Release", AppContext.BaseDirectory);
            Assert.NotNull(compiler);
            string[] framework = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll");
            Assert.NotEmpty(framework);
            string[] arguments = new[] {
                compiler, "/target:library", "/out:" + emittedProducer,
                "/assemblyname:Issue4792Contracts",
            }.Concat(framework.Select(path => "/reference:" + path))
                .Concat(referenceKind == "current"
                    ? new[] { Path.Combine(workspace, "Producer.gs"), Path.Combine(workspace, "Consumer.gs") }
                    : new[] { Path.Combine(workspace, "Producer.gs") }).ToArray();
            Run(workspace, "gsc-producer", "dotnet", arguments);
            if (referenceKind != "current")
            {
                arguments = new[] {
                    compiler, "/target:library", "/out:" + emittedCaller,
                    "/assemblyname:Issue4792Caller", "/reference:" + emittedProducer,
                }.Concat(framework.Select(path => "/reference:" + path))
                    .Append(Path.Combine(workspace, "Consumer.gs")).ToArray();
                Run(workspace, "gsc-caller", "dotnet", arguments);
            }

            string preservedConsumer = Execute(emittedProducer, nativeCaller);
            string actual = Execute(emittedProducer, emittedCaller);
            File.WriteAllText(Path.Combine(workspace, "runtime.json"), JsonSerializer.Serialize(new {
                Native = "11,11,99,11,ok,4,True,False,2", PreservedNativeConsumer = preservedConsumer,
                Emitted = actual, ReferenceKind = referenceKind,
            }));
            File.WriteAllText(Path.Combine(workspace, "products.json"), JsonSerializer.Serialize(new {
                NativeProducer = nativeProducer, NativeCaller = nativeCaller,
                EmittedProducer = emittedProducer, EmittedCaller = emittedCaller,
                Compiler = new { Path = compiler, Sha256 = Hash(compiler) },
                Translator = new { Path = typeof(CSharpToGSharpTranslator).Assembly.Location,
                    Sha256 = Hash(typeof(CSharpToGSharpTranslator).Assembly.Location) },
                Test = new { Path = typeof(Issue4792ProjectReferencedStaticHolderTests).Assembly.Location,
                    Sha256 = Hash(typeof(Issue4792ProjectReferencedStaticHolderTests).Assembly.Location) },
                FrameworkReferences = framework.Select(path => new { Path = path, Sha256 = Hash(path) }),
            }, new JsonSerializerOptions { WriteIndented = true }));
            AssertTargets(workspace, nativeProducer, nativeCaller, "native");
            AssertTargets(workspace, emittedProducer, emittedCaller, "gs");
            Assert.Equal("11,11,99,11,ok,4,True,False,2", preservedConsumer);
            Assert.Equal("11,11,99,11,ok,4,True,False,2", actual);
        }
        finally
        {
            try
            {
                if (Environment.GetEnvironmentVariable("CS2GS_ISSUE4792_ARTIFACTS_DIR") is string artifacts)
                {
                    string destination = Path.Combine(artifacts, referenceKind + "-" + Path.GetFileName(workspace));
                    foreach (string file in Directory.GetFiles(workspace, "*", SearchOption.AllDirectories))
                    {
                        string target = Path.Combine(destination, Path.GetRelativePath(workspace, file));
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        File.Copy(file, target);
                    }
                }
            }
            finally
            {
                Directory.Delete(workspace, recursive: true);
            }
        }
    }

    private static string Project(string assembly, string reference = null) => $$"""
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <AssemblyName>{{assembly}}</AssemblyName>
            <GenerateAssemblyInfo>false</GenerateAssemblyInfo>
            <Nullable>enable</Nullable>
            <DebugType>portable</DebugType>
          </PropertyGroup>
          {{(reference == null ? string.Empty : $"<ItemGroup><ProjectReference Include=\"{reference}\" /></ItemGroup>")}}
        </Project>
        """;

    private static string Translate(LoadedCSharpProject project, IReadOnlyList<CSharpCompilation> siblings) =>
        TranslateDocument(project, Assert.Single(project.Documents), siblings);

    private static string TranslateDocument(
        LoadedCSharpProject project, LoadedDocument document, IReadOnlyList<CSharpCompilation> siblings)
    {
        var context = new TranslationContext(
            project.Compilation, document.SemanticModel, document.FilePath, siblings);
        string rendered = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return rendered;
    }

    private static void Run(string workspace, string label, string executable, string[] arguments)
    {
        ProcessRunResult result = ProcessRunner.Run(executable, arguments);
        File.WriteAllText(Path.Combine(workspace, label + ".json"),
            JsonSerializer.Serialize(new { Executable = executable, Argv = arguments, result.ExitCode }));
        File.WriteAllText(Path.Combine(workspace, label + ".stdout"), result.Output);
        Assert.True(result.ExitCode == 0, result.Output);
    }

    private static string Execute(string producer, string caller)
    {
        Assembly[] images = producer == caller
            ? new[] { EmittedFixture.Load(File.ReadAllBytes(producer), Path.GetDirectoryName(producer)) }
            : EmittedFixture.LoadTogether(Path.GetDirectoryName(producer),
                File.ReadAllBytes(producer), File.ReadAllBytes(caller));
        return (string)images.Last().GetType("Issue4792.Consumer.Caller", throwOnError: true)
            .GetMethod("Run").Invoke(null, null);
    }

    private static void AssertTargets(string workspace, string producer, string caller, string label)
    {
        Assembly[] images = producer == caller
            ? new[] { EmittedFixture.Load(File.ReadAllBytes(producer), Path.GetDirectoryName(producer)) }
            : EmittedFixture.LoadTogether(Path.GetDirectoryName(producer),
                File.ReadAllBytes(producer), File.ReadAllBytes(caller));
        Type callerType = images.Last().GetType("Issue4792.Consumer.Caller", throwOnError: true);
        var targets = new[] { "Explicit", "Qualified", "Generic", "Async", "Envelope", "Instance" }
            .Select(name => (Caller: name, Target: Assert.Single(Calls(callerType.GetMethod(name)))))
            .ToList();
        ConstructorInfo constructor = images[0].GetType("Issue4792.Contracts.DerivedNode").GetConstructor(Type.EmptyTypes);
        targets.Add(("DerivedNode..ctor", Assert.Single(Calls(constructor))));
        File.WriteAllText(Path.Combine(workspace, label + "-targets.json"),
            JsonSerializer.Serialize(targets.Select(target => new {
                target.Caller, Owner = target.Target.DeclaringType.FullName, target.Target.IsStatic,
                Member = target.Target.Name, Module = target.Target.Module.Name,
                target.Target.Module.ModuleVersionId,
                AssemblyIdentity = target.Target.DeclaringType.Assembly.FullName,
                target.Target.MetadataToken, Attributes = target.Target.Attributes.ToString(),
                Parameters = target.Target.GetParameters().Select(parameter => new {
                    parameter.Name, Type = parameter.ParameterType.ToString(),
                    Attributes = parameter.Attributes.ToString(),
                }),
            }), new JsonSerializerOptions { WriteIndented = true }));
        foreach (var target in targets.Take(5))
        {
            Assert.Equal("Issue4792.Contracts.Holder", target.Target.DeclaringType.FullName);
            Assert.True(target.Target.IsStatic);
            Assert.Equal(images[0].ManifestModule.ModuleVersionId, target.Target.Module.ModuleVersionId);
        }

        MethodBase instance = targets[5].Target;
        Assert.Equal("Issue4792.Contracts.DerivedNode", instance.DeclaringType.FullName);
        Assert.False(instance.IsStatic);
        MethodBase parent = targets[6].Target;
        Assert.Equal("Issue4792.Contracts.Node", parent.DeclaringType.FullName);
        Assert.Equal(images[0].ManifestModule.ModuleVersionId, parent.Module.ModuleVersionId);
    }

    private static IEnumerable<MethodBase> Calls(MethodBase method)
    {
        byte[] bytes = method.GetMethodBody().GetILAsByteArray();
        var opcodes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.FieldType == typeof(OpCode))
            .Select(field => (OpCode)field.GetValue(null))
            .ToDictionary(opcode => unchecked((ushort)opcode.Value));
        for (int index = 0; index < bytes.Length;)
        {
            ushort value = bytes[index++];
            if (value == 0xfe) value = (ushort)(0xfe00 | bytes[index++]);
            OpCode opcode = opcodes[value];
            if (opcode.OperandType == OperandType.InlineMethod)
            {
                int token = BitConverter.ToInt32(bytes, index);
                yield return method.Module.ResolveMethod(token);
            }

            index += opcode.OperandType switch {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => 4 + 4 * BitConverter.ToInt32(bytes, index),
                _ => 4,
            };
        }
    }

    private static string Hash(string path) => Convert.ToHexString(
        SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
}
