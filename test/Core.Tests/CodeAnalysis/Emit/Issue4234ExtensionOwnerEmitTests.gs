// <copyright file="Issue4234ExtensionOwnerEmitTests.cs" company="GSharp">
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

/// Issue #4234: a migrated (self-hosted) C# static extension class — e.g.
/// `Gsharp.Concurrency.ChannelExtensions` — loses its CLR owner-type
/// identity when cs2gs lifts its extension methods to top-level G# funcs,
/// because a top-level extension function is always hosted on the package's
/// synthesized `<Program>` TypeDef (ADR-0084). That broke
/// reflection tests (`typeof(ChannelExtensions).GetMethods()`) and
/// analyzer owner-specific recognition in the migrated runtime, which both
/// key off the exact declaring type.
///
/// `@ExtensionOwner(typeof(T))` lets a top-level extension function name
/// a same-package, non-generic class/struct to host its MethodDef on
/// instead — reusing the same `StaticOwnerType` + owner-registered-
/// methods machinery ADR-0053 already uses for ordinary shared-block static
/// methods (and the receiver-clause-operator path already uses to route a
/// TOP-LEVEL declaration onto a same-package receiver's TypeDef).
open class Issue4234ExtensionOwnerEmitTests {
    @Fact
    func ExtensionOwner_HostsMethodDef_OnNamedOwnerType_NotProgram() {
        const Source = `package Issue4234.OwnerRouting

import System
import System.Text

class ChannelExtensions {
}

@ExtensionOwner(typeof(ChannelExtensions))
func (sb StringBuilder) Shout() string {
    return sb.ToString()
}
`
        let asm = CompileToAssembly(Source, "Issue4234.OwnerRouting")
        let owner = asm.GetTypes().Single((t Type) -> t.Name == "ChannelExtensions")
        let program = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        // The method lands on the named owner, not <Program> — matching the
        // native C# `static class ChannelExtensions { public static void
        // Close(...) }` shape byte-for-byte in the metadata it observes.
        let shout MethodInfo? = owner.GetMethod(
            "Shout",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(shout)
        Assert.Null(program.GetMethod("Shout", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic))
        // ECMA-334 §13.6.9: a C#/F# consumer only recognises an extension
        // method when its container is non-generic, abstract, AND sealed
        // (the CLR encoding of a C# `static class`) — MemberLookup.IsStaticClass
        // in gsc's own metadata importer applies the identical check when a
        // second G# project references this one.
        Assert.True(owner.IsAbstract, "owner TypeDef should be Abstract (static-class shape).")
        Assert.True(owner.IsSealed, "owner TypeDef should be Sealed (static-class shape).")
        Assert.True(
            owner.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the owner TypeDef."
        )
        Assert.True(
            shout!!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the routed MethodDef."
        )
    }

    @Fact
    func ExtensionOwner_MissingTypeofArgument_ReportsGS9306() {
        const Source = `package Issue4234.BadArgument

import System.Text

@ExtensionOwner("not-a-type")
func (sb StringBuilder) Shout() string {
    return sb.ToString()
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9306")
    }

    @Fact
    func ExtensionOwner_TargetingGenericType_ReportsGS9306() {
        const Source = `package Issue4234.GenericOwner

import System.Text

class Holder[T] {
}

@ExtensionOwner(typeof(Holder))
func (sb StringBuilder) Shout() string {
    return sb.ToString()
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9306")
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
