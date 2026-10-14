// <copyright file="Issue1913ParamAttributeEmitTests.cs" company="GSharp">
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

/// Issue #1913 follow-up (code-review bugs B1/B2): the original fix wired
/// parameter annotations from the binder onto `ParameterSymbol` for
/// constructors and interface methods, but three `TypeDefEmitter` emit
/// paths — `EmitClassConstructorWithBody`, `EmitAbstractMethod`,
/// and `EmitStaticVirtualMethod` — minted Parameter rows via
/// `AddRefKindAwareParameterRows` and never called
/// `EmitUserAttributes` on them, so the attribute silently never
/// reached the emitted metadata even though the binder attached it
/// correctly. These tests read the compiled assembly's real Parameter
/// metadata via reflection ((cref:ParameterInfo.GetCustomAttributes(bool)))
/// — the same empirical technique that caught the regression — rather than
/// just asserting the binder-level symbol, which is what let this slip
/// through undetected the first time.
open class Issue1913ParamAttributeEmitTests {
    @Fact
    func ConstructorParameter_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue1913Ctor
import System
` + NoteAttributeDecl + `

class Box {
    var Z int32 = 0
    init(@Note("c") z int32) {
        Z = z
    }
}
`
        let asm = CompileToAssembly(Source, "ConstructorParameter_UserAttribute_RoundTripsThroughReflection")
        let box = asm.GetTypes().Single((t Type) -> t.Name == "Box")
        let ctor = box.GetConstructors().Single((c ConstructorInfo) -> c.GetParameters().Length == 1)
        let param = ctor.GetParameters()[0]
        Assert.Equal("z", param.Name)
        let attrs = param.GetCustomAttributes(true)
        Assert.Single(attrs)
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name)
        let textProp MemberInfo? = attrs[0].GetType().GetField("Text") ??
            cast[MemberInfo](attrs[0].GetType().GetProperty("Text"))
        let textValue object? = switch textProp {
            case f is FieldInfo: f.GetValue(attrs[0])
            case p is PropertyInfo: p.GetValue(attrs[0])
            default: default(object?)
        }
        Assert.Equal("c", textValue)
    }

    @Fact
    func InterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue1913Iface
import System
` + NoteAttributeDecl + `

interface IWork {
    func Do(@Note("iface") a int32) int32;
}

class Worker : IWork {
    func Do(a int32) int32 {
        return a
    }
}
`
        let asm = CompileToAssembly(Source, "InterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection")
        let iface = asm.GetTypes().Single((t Type) -> t.Name == "IWork")
        let method MethodInfo? = iface.GetMethod("Do", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(method)
        let param = method!!.GetParameters()[0]
        Assert.Equal("a", param.Name)
        let attrs = param.GetCustomAttributes(true)
        Assert.Single(attrs)
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name)
    }

    @Fact
    func StaticVirtualInterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue1913SharedIface
import System
` + NoteAttributeDecl + `

interface IAdd {
    shared {
        func AddOne(@Note("shared") a int32) int32;
    }
}

class Adder : IAdd {
    shared {
        func AddOne(a int32) int32 {
            return a + 1
        }
    }
}
`
        let asm = CompileToAssembly(
            Source,
            "StaticVirtualInterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection"
        )
        let iface = asm.GetTypes().Single((t Type) -> t.Name == "IAdd")
        let method MethodInfo? = iface.GetMethod("AddOne", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(method)
        let param = method!!.GetParameters()[0]
        Assert.Equal("a", param.Name)
        let attrs = param.GetCustomAttributes(true)
        Assert.Single(attrs)
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name)
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
