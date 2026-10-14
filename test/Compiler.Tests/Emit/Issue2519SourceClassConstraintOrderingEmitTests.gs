// <copyright file="Issue2519SourceClassConstraintOrderingEmitTests.cs" company="GSharp">
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

/// Runtime and metadata regressions for issue #2519.
class Issue2519SourceClassConstraintOrderingEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceClassConstraint_InEitherFileOrder_PreservesMetadataDispatchAndMembers(reverse bool) {
        let directory = Directory.CreateTempSubdirectory("gs_issue2519_").FullName
        try {
            let sources = WriteSources(directory)
            if reverse {
                sources.Reverse()
            }
            let assemblyPath = Path.Combine(directory, "Issue2519.dll")
            let args = List[string]{"/out:" + assemblyPath, "/target:library", "/targetframework:net10.0"}
            args.AddRange(sources)
            Assert.Equal(0, Program.Main(args.ToArray()))
            IlVerifier.Verify(assemblyPath, additionalReferences: TrustedPlatformAssemblies())
            VerifyCSharpConsumer(assemblyPath)
            let loadContext = AssemblyLoadContext("Issue2519", isCollectible: true)
            try {
                let assembly = loadContext.LoadFromAssemblyPath(assemblyPath)
                let holderDefinition = assembly.GetType("P.Audio.Holder2519`1", throwOnError: true)!!
                let entryType = assembly.GetType("P.Entry2519", throwOnError: true)!!
                let concreteType = assembly.GetType("P.Concrete2519", throwOnError: true)!!
                let typeParameter = Assert.Single(holderDefinition.GetGenericArguments())
                Assert.Equal(entryType, Assert.Single(typeParameter.GetGenericParameterConstraints()))
                let holderType = holderDefinition.MakeGenericType(concreteType)
                let holder object? = Activator.CreateInstance(holderType)
                let concrete object? = Activator.CreateInstance(concreteType)
                var subscriptions = 0
                let handler() -> void = () -> subscriptions++
                holderType.GetMethod("Subscribe")!!.Invoke(holder, []object{concrete, handler})
                concreteType.GetMethod("Raise")!!.Invoke(concrete, nil)
                Assert.Equal(10, holderType.GetMethod("Read")!!.Invoke(holder, []object{concrete}))
                Assert.Same(concrete, holderType.GetMethod("Upcast")!!.Invoke(holder, []object{concrete}))
                Assert.Equal(1, subscriptions)
            } finally {
                loadContext.Unload()
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func WriteSources(directory string) List[string] {
            let sources = [](string, string){("AHolder.gs", `package P.Audio
import P
import System
public class Holder2519[T Entry2519] {
    public func Read(value T) int32 ->
        value.Count + value.SamplesInFrame + value.Inherited() + value.VirtualValue()
    public func Upcast(value T) Entry2519 -> value
    public func Subscribe(value T, handler Action) {
        value.Changed += handler
    }
}`), ("ZEntry.gs", `package P
import System
public open class Root2519 {
    public var SamplesInFrame int32
    public func Inherited() int32 -> 3
    public event Changed Action
    public func Raise() {
        Changed()
    }
}
public open class Entry2519 : Root2519 {
    public prop Count int32 -> 2
    public open func VirtualValue() int32 -> 4
}
public class Concrete2519 : Entry2519 {
    public override func VirtualValue() int32 -> 5
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
            const source = `using P;
using P.Audio;

public static class Consumer2519
{
    public static int Run()
    {
        var value = new Concrete2519();
        var holder = new Holder2519<Concrete2519>();
        holder.Subscribe(value, () => { });
        Entry2519 upcast = holder.Upcast(value);
        return holder.Read(value) + (ReferenceEquals(value, upcast) ? 0 : 100);
    }
}`
            let compilation = CSharpCompilation.Create(
                "Issue2519.Consumer",
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
