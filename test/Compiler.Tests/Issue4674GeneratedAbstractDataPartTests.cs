// <copyright file="Issue4674GeneratedAbstractDataPartTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Gsgen.Cli;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>Generated data parts retain explicit abstractness through the real analyzer driver.</summary>
public class Issue4674GeneratedAbstractDataPartTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void Analyzer_GeneratedDataPart_PreservesAbstractnessAndRuns(
        bool classFallback,
        bool generatedAbstract)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        string workspace = Directory.CreateTempSubdirectory("gsc_generated_data_").FullName;
        try
        {
            string generatorPath = Path.Combine(workspace, "DataGenerator.dll");
            CompileGenerator(generatorPath, generatedAbstract);
            string sourcePath = Path.Combine(workspace, "Data.gs");
            string declaration = classFallback
                ? "open class Base {}\nopen partial data class Target : Base {}"
                : "open partial data class Target {}";
            File.WriteAllText(sourcePath, "package App\n" + declaration
                + "\ndata class Child : Target { func Read() int32 { return Answer } }\n");
            string assemblyPath = Path.Combine(workspace, "GeneratedData.dll");
            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            int exit;
            try
            {
                Console.SetOut(stdout);
                Console.SetError(stderr);
                exit = Program.Main(new[]
                {
                    sourcePath,
                    "/analyzer:" + generatorPath,
                    "/gsgentool:" + typeof(GsgenProgram).Assembly.Location,
                    "/target:library",
                    "/out:" + assemblyPath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exit == 0, $"gsc failed:\n{stdout}\n{stderr}");
            IlVerifier.Verify(assemblyPath);
            var context = new AssemblyLoadContext("GeneratedData-" + Guid.NewGuid().ToString("N"), isCollectible: true);
            try
            {
                using var image = new MemoryStream(File.ReadAllBytes(assemblyPath));
                var assembly = context.LoadFromStream(image);
                var target = assembly.GetType("App.Target");
                var child = assembly.GetType("App.Child");
                Assert.NotNull(target);
                Assert.NotNull(child);
                Assert.Equal(generatedAbstract, target.IsAbstract);
                Assert.False(target.IsSealed);
                var constructor = Assert.Single(
                    target.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                    candidate => candidate.GetParameters().Length == 0);
                Assert.Equal(
                    generatedAbstract ? MethodAttributes.Family : MethodAttributes.Public,
                    constructor.Attributes & MethodAttributes.MemberAccessMask);
                Assert.Equal(target, child.BaseType);
                Assert.False(child.IsAbstract);
                var instance = Activator.CreateInstance(child);
                Assert.NotNull(instance);
                var read = child.GetMethod("Read");
                Assert.NotNull(read);
                Assert.Equal(42, read.Invoke(instance, null));
                if (!generatedAbstract)
                {
                    Assert.NotNull(Activator.CreateInstance(target));
                }
            }
            finally
            {
                context.Unload();
            }
        }
        finally
        {
            Directory.Delete(workspace, recursive: true);
        }
    }

    private static void CompileGenerator(string path, bool generatedAbstract)
    {
        const string Source = """
            using Microsoft.CodeAnalysis;
            [Generator]
            public sealed class DataGenerator : IIncrementalGenerator
            {
                public void Initialize(IncrementalGeneratorInitializationContext context)
                {
                    context.RegisterSourceOutput(context.CompilationProvider, (output, compilation) =>
                    {
                        var target = compilation.GetTypeByMetadataName("App.Target");
                        if (target == null) throw new System.InvalidOperationException("Missing App.Target");
                        output.AddSource("Target.g.cs", "namespace App { public GENERATE_ABSTRACTpartial "
                            + (target.IsRecord ? "record " : "class ")
                            + "Target { public int Answer => 42; } }");
                    });
                }
            }
            """;
        var platformAssemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        Assert.False(string.IsNullOrEmpty(platformAssemblies));
        var references = platformAssemblies.Split(Path.PathSeparator)
            .Select(assembly => MetadataReference.CreateFromFile(assembly)).Concat(new[]
        {
            MetadataReference.CreateFromFile(typeof(IIncrementalGenerator).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(CSharpCompilation).Assembly.Location),
        }).GroupBy(reference => reference.Display).Select(group => group.First());
        var compilation = CSharpCompilation.Create(
            "DataGenerator_" + Guid.NewGuid().ToString("N"),
            new[] { CSharpSyntaxTree.ParseText(Source.Replace("GENERATE_ABSTRACT", generatedAbstract ? "abstract " : string.Empty, StringComparison.Ordinal)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var image = new MemoryStream();
        var result = compilation.Emit(image);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        File.WriteAllBytes(path, image.ToArray());
    }
}
