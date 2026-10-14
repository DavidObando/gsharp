// <copyright file="Issue2410ImportedDelegateAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

open class Issue2410ImportedDelegateAssignmentEmitTests {
    @Fact
    func ImportedStaticDelegateFieldAndProperty_UntypedLambdas_RunAndVerify() {
        let output = CompileAndRun(`package App
import System
import Lib2410Emit

func Main() {
    Holder.StaticField = (x) -> x + 1
    Holder.StaticProperty = (x) -> x + 2
    Console.WriteLine(Holder.InvokeStaticField(10))
    Console.WriteLine(Holder.InvokeStaticProperty(10))
}`, "ImportedStaticDelegateFieldAndProperty_UntypedLambdas_RunAndVerify")
        Assert.Equal("11${Environment.NewLine}12${Environment.NewLine}", output)
    }

    @Fact
    func ImportedDelegateAssignment_SiblingMemberPaths_RunAndVerify() {
        let output = CompileAndRun(`package App
import System
import Lib2410Emit

func Same(h Holder) Holder -> h

func Main() {
    let h = Holder()
    h.InstanceField = (x) -> x + 3
    Same(h).InstanceProperty = (x) -> x + 4
    GenericHolder[int32].StaticField = (x) -> x + 5
    GenericHolder[int32].StaticProperty = (x) -> x + 6
    Console.WriteLine(h.InvokeInstanceField(10))
    Console.WriteLine(h.InvokeInstanceProperty(10))
    Console.WriteLine(GenericHolder[int32].InvokeStaticField(10))
    Console.WriteLine(GenericHolder[int32].InvokeStaticProperty(10))
}`, "ImportedDelegateAssignment_SiblingMemberPaths_RunAndVerify")
        Assert.Equal(
            "13${Environment.NewLine}14${Environment.NewLine}15${Environment.NewLine}16${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string, caseName string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2410Emit", caseName)
            Directory.CreateDirectory(directory)
            let libraryPath = EmitCSharpLibrary(directory)
            let consumerPath = Path.Combine(directory, "Consumer.dll")
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
            {
                using let stream = File.Create(consumerPath)
                let result = compilation.Emit(
                    stream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "Issue2410." + caseName
                )
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
            let context = AssemblyLoadContext("Issue2410." + caseName, isCollectible: true)
            try {
                context.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == "Lib2410Emit" {
                    context.LoadFromAssemblyPath(libraryPath)
                } else {
                    default(Assembly?)
                }
                let assembly = context.LoadFromAssemblyPath(consumerPath)
                let output = Console.Out
                using let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    assembly.EntryPoint!!.Invoke(nil, nil)
                } finally {
                    Console.SetOut(output)
                }
                return captured.ToString().ReplaceLineEndings(Environment.NewLine)
            } finally {
                context.Unload()
            }
        }

        private func EmitCSharpLibrary(directory string) string {
            let libraryPath = Path.Combine(directory, "Lib2410Emit.dll")
            const source = `namespace Lib2410Emit
{
    public delegate int Mapper(int value);

    public sealed class Holder
    {
        public static Mapper StaticField;
        public static Mapper StaticProperty { get; set; }
        public Mapper InstanceField;
        public Mapper InstanceProperty { get; set; }

        public static int InvokeStaticField(int value) => StaticField(value);
        public static int InvokeStaticProperty(int value) => StaticProperty(value);
        public int InvokeInstanceField(int value) => InstanceField(value);
        public int InvokeInstanceProperty(int value) => InstanceProperty(value);
    }

    public sealed class GenericHolder<T>
    {
        public static Mapper StaticField;
        public static Mapper StaticProperty { get; set; }
        public static int InvokeStaticField(int value) => StaticField(value);
        public static int InvokeStaticProperty(int value) => StaticProperty(value);
    }
}`
            let syntaxTree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Lib2410Emit",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(libraryPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
