// <copyright file="Issue4674GeneratedAbstractDataPartTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Gsgen.Cli
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Generated data parts retain explicit abstractness through the real analyzer driver.
open class Issue4674GeneratedAbstractDataPartTests {
    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func Analyzer_GeneratedDataPart_PreservesAbstractnessAndRuns(classFallback bool, generatedAbstract bool) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        let workspace = Directory.CreateTempSubdirectory("gsc_generated_data_").FullName
        try {
            let generatorPath = Path.Combine(workspace, "DataGenerator.dll")
            CompileGenerator(generatorPath, generatedAbstract)
            let sourcePath = Path.Combine(workspace, "Data.gs")
            let declaration = if classFallback {
                "open class Base {}\nopen partial data class Target : Base {}"
            } else {
                "open partial data class Target {}"
            }
            File.WriteAllText(sourcePath, "package App\n" + declaration + `
data class Child : Target { func Read() int32 { return Answer } }
`)
            let assemblyPath = Path.Combine(workspace, "GeneratedData.dll")
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            var exit int32
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                exit = Program.Main(
                    []string{
                        sourcePath,
                        "/analyzer:" + generatorPath,
                        "/gsgentool:" + typeof(GsgenProgram).Assembly.Location,
                        "/target:library",
                        "/out:" + assemblyPath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exit == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
            IlVerifier.Verify(assemblyPath)
            let context = AssemblyLoadContext("GeneratedData-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                using let image = MemoryStream(File.ReadAllBytes(assemblyPath))
                let assembly = context.LoadFromStream(image)
                let target Type? = assembly.GetType("App.Target")
                let child Type? = assembly.GetType("App.Child")
                Assert.NotNull(target)
                Assert.NotNull(child)
                Assert.Equal(generatedAbstract, target!!.IsAbstract)
                Assert.False(target!!.IsSealed)
                let constructor = Assert.Single(
                    target!!.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                    (candidate ConstructorInfo) -> candidate.GetParameters().Length == 0
                )
                Assert.Equal(
                    if generatedAbstract {
                        MethodAttributes.Family
                    } else {
                        MethodAttributes.Public
                    },
                    constructor.Attributes & MethodAttributes.MemberAccessMask
                )
                Assert.Equal(target, child!!.BaseType)
                Assert.False(child!!.IsAbstract)
                let instance object? = Activator.CreateInstance(child!!)
                Assert.NotNull(instance)
                let read MethodInfo? = child!!.GetMethod("Read")
                Assert.NotNull(read)
                Assert.Equal(42, read!!.Invoke(instance, nil))
                if !generatedAbstract {
                    Assert.NotNull(Activator.CreateInstance(target!!))
                }
            } finally {
                context.Unload()
            }
        } finally {
            Directory.Delete(workspace, recursive: true)
        }
    }

    shared {
        private func CompileGenerator(path string, generatedAbstract bool) {
            const Source = `using Microsoft.CodeAnalysis;
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
}`
            let platformAssemblies string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            Assert.False(string.IsNullOrEmpty(platformAssemblies))
            let references = platformAssemblies!!
                .Split(Path.PathSeparator)
                .Select((assembly string) -> MetadataReference.CreateFromFile(assembly))
                .Concat(
                []PortableExecutableReference{
                    MetadataReference.CreateFromFile(typeof(IIncrementalGenerator).Assembly.Location),
                    MetadataReference.CreateFromFile(typeof(CSharpCompilation).Assembly.Location)
                }
            )
                .GroupBy((reference PortableExecutableReference) -> reference.Display!!)
                .Select((group IGrouping[string, PortableExecutableReference]) -> group.First())
            let compilation = CSharpCompilation.Create(
                "DataGenerator_" + Guid.NewGuid().ToString("N"),
                []SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        Source.Replace(
                            "GENERATE_ABSTRACT",
                            if generatedAbstract {
                                "abstract "
                            } else {
                                string.Empty
                            },
                            StringComparison.Ordinal
                        )
                    )
                },
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let image = MemoryStream()
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            File.WriteAllBytes(path, image.ToArray())
        }
    }
}
