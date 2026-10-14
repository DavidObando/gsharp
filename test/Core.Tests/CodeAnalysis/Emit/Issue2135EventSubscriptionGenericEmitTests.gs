// <copyright file="Issue2135EventSubscriptionGenericEmitTests.cs" company="GSharp">
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
import Xunit

/// Issue #2135: an event subscription (`+=`) whose delegate/handler type
/// involves a same-compilation generic user type — which is a
/// (cref:System.Reflection.Emit.TypeBuilderInstantiation) at emit — must
/// compile all the way to a real PE without the
/// `GS9998 NotSupportedException` that previously escaped from
/// `ClrTypeUtilities.IsAssignableByName` (see
/// `Issue2135TypeBuilderInstantiationTests` for the direct root-cause
/// guard). These end-to-end tests compile generic user types that declare an
/// event whose delegate references the type parameter and subscribe to it,
/// asserting emit succeeds and produces no GS9998.
open class Issue2135EventSubscriptionGenericEmitTests {
    @Fact
    func MethodGroupHandler_OnGenericTypeEvent_EmitsWithoutCrash() {
        const Source = `package Issue2135MethodGroup
class Bus[T] {
    event OnMsg (T) -> void
    func Handle(v T) { }
    func Wire() {
        OnMsg += Handle
    }
}
`
        let asm = CompileToAssembly(Source, "MethodGroupHandler_OnGenericTypeEvent_EmitsWithoutCrash")
        Assert.Contains(asm.GetTypes(), (t Type) -> t.Name == "Bus`1")
    }

    @Fact
    func LambdaHandler_OnGenericTypeEvent_EmitsWithoutCrash() {
        const Source = `package Issue2135Lambda
class Bus[T] {
    event OnMsg (T) -> void
    func Wire(x T) {
        OnMsg += func(y T) { }
    }
}
`
        let asm = CompileToAssembly(Source, "LambdaHandler_OnGenericTypeEvent_EmitsWithoutCrash")
        Assert.Contains(asm.GetTypes(), (t Type) -> t.Name == "Bus`1")
    }

    @Fact
    func DelegateParamHandler_OnGenericUserDelegateEvent_EmitsWithoutCrash() {
        const Source = `package Issue2135UserDelegate
delegate Handler[T](v T);
class Bus[T] {
    event OnMsg Handler[T]
    func Wire(h Handler[T]) {
        OnMsg += h
    }
}
`
        let asm = CompileToAssembly(Source, "DelegateParamHandler_OnGenericUserDelegateEvent_EmitsWithoutCrash")
        Assert.Contains(asm.GetTypes(), (t Type) -> t.Name == "Bus`1")
    }

    shared {
        private func CompileToAssembly(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
