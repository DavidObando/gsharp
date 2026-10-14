// <copyright file="Issue2517ConstructedBaseOrderingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Runtime, reflection, C# consumer, and ILVerify coverage for issue #2517.
class Issue2517ConstructedBaseOrderingEmitTests {
    @Fact
    func EarlyCrossPackageSignature_PreservesConstructedBaseMetadataAndDispatch() {
        let directory = Directory.CreateTempSubdirectory("gs_issue2517_").FullName
        try {
            let sources = WriteSources(directory)
            let assemblyPath = Path.Combine(directory, "Issue2517.dll")
            let args = List[string]{"/out:" + assemblyPath, "/target:library", "/targetframework:net10.0"}
            args.AddRange(sources)
            let exitCode = Program.Main(args.ToArray())
            Assert.Equal(0, exitCode)
            IlVerifier.Verify(assemblyPath, additionalReferences: TrustedPlatformAssemblies())
            VerifyCSharpConsumer(assemblyPath)
            let loadContext = AssemblyLoadContext("Issue2517", isCollectible: true)
            try {
                let assembly = loadContext.LoadFromAssemblyPath(assemblyPath)
                let derived = assembly.GetType("P.Audio.Derived2517", throwOnError: true)!!
                let middle = assembly.GetType("P.Middle2517`2", throwOnError: true)!!
                let baseType = assembly.GetType("P.Base2517`1", throwOnError: true)!!
                Assert.Equal(middle, derived.BaseType!!.GetGenericTypeDefinition())
                Assert.Equal(baseType, derived.BaseType!!.BaseType!!.GetGenericTypeDefinition())
                Assert.Equal("P.Entry2517", Assert.Single(derived.BaseType!!.BaseType!!.GenericTypeArguments).FullName)
                let sizeGetter = derived.GetProperty(
                    "Size",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly
                )!!.GetMethod!!
                Assert.Equal(baseType, sizeGetter.GetBaseDefinition().DeclaringType!!.GetGenericTypeDefinition())
                let instance object? = Activator.CreateInstance(derived)
                let read = derived.GetMethod("Read", BindingFlags.Instance | BindingFlags.Public)!!
                Assert.Equal(101, read.Invoke(instance, nil))
            } finally {
                loadContext.Unload()
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func WriteSources(directory string) IReadOnlyList[string] {
            let sources = [](string, string){("0Early.gs", `package Other
import P
public class Early2517 {
    public func Get() Middle2517[Entry2517,Entry2517]? -> default(Middle2517[Entry2517,Entry2517]?)
}`), ("ADerived.gs", `package P.Audio
import P
public open class Derived2517 : Middle2517[Entry2517,Entry2517] {
    public open override prop Size int32 -> 100
    public func Read() int32 -> Size + Inherited()
}`), (
                    "Entry.gs",
                    "package P\npublic class Entry2517 { }"
                ), (
                    "YMiddle.gs",
                    "package P\npublic open class Middle2517[TInput,TOutput] : Base2517[TInput] { }"
                ), ("ZBase.gs", `package P
public open class Base2517[T] {
    public open prop Size int32 { get; }
    protected func Inherited() int32 -> 1
}`)}
            let paths = List[string](sources.Length)
            for (name, source) in sources {
                let path = Path.Combine(directory, name)
                File.WriteAllText(path, source)
                paths.Add(path)
            }
            return paths
        }

        private func VerifyCSharpConsumer(assemblyPath string) {
            const source = `using P.Audio;

public static class Consumer2517
{
    public static int Run() => new Derived2517().Read();
}`
            let compilation = CSharpCompilation.Create(
                "Issue2517.Consumer",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path)).Append(
                    MetadataReference.CreateFromFile(assemblyPath)
                ),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func TrustedPlatformAssemblies()[]string -> (
            cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
        ).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
    }
}
