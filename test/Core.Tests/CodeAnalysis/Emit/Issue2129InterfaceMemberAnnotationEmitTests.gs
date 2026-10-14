// <copyright file="Issue2129InterfaceMemberAnnotationEmitTests.cs" company="GSharp">
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

/// Issue #2129: an attribute on an interface property (or event / method
/// signature) previously failed to parse (GS0005). Once parsing is fixed the
/// attribute must also be bound and emitted as a real CLR
/// `CustomAttribute` row on the generated interface member so that,
/// e.g., `[JsonPropertyName]` on an interface property survives to
/// metadata. These tests compile a self-contained interface carrying a
/// user-defined attribute on each member kind and read the emitted assembly's
/// real metadata via reflection — the same empirical technique used by the
/// param-attribute emit tests (issue #1913 / #2006).
open class Issue2129InterfaceMemberAnnotationEmitTests {
    @Fact
    func InterfaceProperty_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue2129Prop
import System
` + NoteAttributeDecl + `

interface IPerson {
    @Note("asin")
    prop Asin string
}
`
        let asm = CompileToAssembly(Source, "InterfaceProperty_UserAttribute_RoundTripsThroughReflection")
        let iface = asm.GetTypes().Single((t Type) -> t.Name == "IPerson")
        Assert.True(iface.IsInterface)
        let prop PropertyInfo? = iface.GetProperty("Asin", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(prop)
        let attrs = prop!!.GetCustomAttributesData()
        let note = Assert.Single(attrs)
        Assert.Equal("NoteAttribute", note.AttributeType.Name)
        Assert.Equal("asin", note.ConstructorArguments.Single().Value)
    }

    @Fact
    func InterfaceEvent_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue2129Event
import System
` + NoteAttributeDecl + `

interface IPerson {
    @Note("evt")
    event Changed Action
}
`
        let asm = CompileToAssembly(Source, "InterfaceEvent_UserAttribute_RoundTripsThroughReflection")
        let iface = asm.GetTypes().Single((t Type) -> t.Name == "IPerson")
        let ev EventInfo? = iface.GetEvent("Changed", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(ev)
        let attrs = ev!!.GetCustomAttributesData()
        let note = Assert.Single(attrs)
        Assert.Equal("NoteAttribute", note.AttributeType.Name)
        Assert.Equal("evt", note.ConstructorArguments.Single().Value)
    }

    @Fact
    func InterfaceMethodSignature_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue2129Method
import System
` + NoteAttributeDecl + `

interface IPerson {
    @Note("greet")
    func Greet() string;
}
`
        let asm = CompileToAssembly(Source, "InterfaceMethodSignature_UserAttribute_RoundTripsThroughReflection")
        let iface = asm.GetTypes().Single((t Type) -> t.Name == "IPerson")
        let method MethodInfo? = iface.GetMethod("Greet", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(method)
        let attrs = method!!.GetCustomAttributesData()
        let note = Assert.Single(attrs)
        Assert.Equal("NoteAttribute", note.AttributeType.Name)
        Assert.Equal("greet", note.ConstructorArguments.Single().Value)
    }

    shared {
        private const NoteAttributeDecl string = `
class NoteAttribute(Text string) : Attribute {
}
`

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
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
