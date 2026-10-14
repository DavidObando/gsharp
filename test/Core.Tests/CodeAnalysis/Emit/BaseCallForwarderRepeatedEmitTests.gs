// <copyright file="BaseCallForwarderRepeatedEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Threading.Tasks
import Xunit

/// The base-call forwarder pass attaches its `<>n__N` methods to
/// the bound class symbol, which the compilation caches. A second
/// `Compilation.Emit` ran the pass again over the same class: it added a
/// second set of forwarders while the first set, still in the class's method
/// list, had no body in the new program. Repeated emit must produce the same
/// assembly, each with one forwarder per shape, that runs.
class BaseCallForwarderRepeatedEmitTests {
    @Fact
    async func RepeatedEmit_ProducesOneForwarderSetAndRunnableAssemblies() {
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(Source, "forwarders.gs"))){IsLibrary = true}
        using let first = MemoryStream()
        using let second = MemoryStream()
        let firstResult = compilation.Emit(first)
        let secondResult = compilation.Emit(second)
        Assert.True(firstResult.Success, string.Join("; ", firstResult.Diagnostics.Select((d Diagnostic) -> d.Message)))
        Assert.True(
            secondResult.Success,
            string.Join("; ", secondResult.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        Assert.Equal(first.ToArray(), second.ToArray())
        for image in[]MemoryStream{first, second} {
            image.Position = 0
            let context = AssemblyLoadContext(
                "RepeatedEmit_ProducesOneForwarderSetAndRunnableAssemblies",
                isCollectible: true
            )
            try {
                let assembly = context.LoadFromStream(image)
                let derived = assembly.GetTypes().Single((type Type) -> type.Name == "Derived")
                let forwarders = derived
                    .GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                    .Where((method MethodInfo) -> method.Name.StartsWith("<>n__", StringComparison.Ordinal))
                    .Select((method MethodInfo) -> method.Name)
                    .ToArray()
                Assert.Equal(forwarders.Distinct(StringComparer.Ordinal).Count(), forwarders.Length)
                Assert.Single(forwarders)
                let instance object? = Activator.CreateInstance(derived)
                Assert.Equal("base base", derived.GetMethod("Go")!!.Invoke(instance, nil))
                let task Task[string]? = cast[Task[string]](derived.GetMethod("GoAsync")!!.Invoke(instance, nil)!!)
                Assert.Equal("base", await task)
            } finally {
                context.Unload()
            }
        }
    }

    shared {
        private const Source string = `package ForwarderEmit
import System
import System.Threading.Tasks

open class Base {
    open func Name() string { return "base" }
}

public class Derived : Base {
    override func Name() string { return "derived" }

    public func Go() string {
        let call = () -> base.Name()
        let group = func () string {
            let h () -> string = base.Name
            return h()
        }
        return call() + " " + group()
    }

    public async func GoAsync() Task[string] {
        await Task.Yield()
        return base.Name()
    }
}`
    }
}
