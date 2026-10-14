// <copyright file="Issue792ExtensionAttributeEmitTests.cs" company="GSharp">
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
import System.Runtime.CompilerServices
import System.Runtime.Loader
import Xunit

/// Issue #792 / ADR-0084 (Known limitation L4): G# extension functions —
/// `func (self T) Name(...) ...` — must emit with
/// (cref:ExtensionAttribute) stamped on both the MethodDef row and
/// its containing TypeDef row so the C#/F# compiler's call-site lookup
/// (ECMA-334 §13.6.9) recognises them as extension methods. Without
/// these markers the same `.Name(args)` call from C# would fail to
/// resolve, which is the cycle this issue exists to break.
open class Issue792ExtensionAttributeEmitTests {
    @Fact
    func ExtensionFunction_StampsExtensionAttribute_OnMethodDef() {
        const Source = `package Issue792.MethodMarker

import System

func (self string) Shout() string {
    return self + "!"
}
`
        let asm = CompileToAssembly(Source, "Issue792.MethodMarker")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let shout MethodInfo? = programType.GetMethod(
            "Shout",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(shout)
        Assert.True(
            shout!!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the extension MethodDef."
        )
    }

    @Fact
    func ExtensionFunction_StampsExtensionAttribute_OnHostingTypeDef() {
        const Source = `package Issue792.TypeMarker

import System

func (self string) Echo() string {
    return self
}
`
        let asm = CompileToAssembly(Source, "Issue792.TypeMarker")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        Assert.True(
            programType.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the <Program> TypeDef hosting the extension methods."
        )
    }

    @Fact
    func NonExtensionFunction_DoesNotStampExtensionAttribute() {
        const Source = `package Issue792.NoMarker

import System

func Plain(x int32) int32 {
    return x
}
`
        let asm = CompileToAssembly(Source, "Issue792.NoMarker")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let plain MethodInfo? = programType.GetMethod(
            "Plain",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(plain)
        Assert.Empty(plain!!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false))
        Assert.Empty(programType.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false))
    }

    @Fact
    func GenericExtensionFunction_StampsExtensionAttribute() {
        const Source = `package Issue792.GenericMarker

import System

func (self T) Identity[T]() T {
    return self
}
`
        let asm = CompileToAssembly(Source, "Issue792.GenericMarker")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let identity MethodInfo? = programType.GetMethod(
            "Identity",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(identity)
        Assert.True(
            identity!!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on generic extension methods too."
        )
        Assert.True(
            programType.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the host TypeDef once even with multiple generic extensions."
        )
    }

    shared {
        private func CompileToAssembly(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: false)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
