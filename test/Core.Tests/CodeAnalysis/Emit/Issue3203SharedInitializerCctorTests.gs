// <copyright file="Issue3203SharedInitializerCctorTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// Issue #3203 / ADR-0140 §4: the emitted `beforefieldinit` contract for
/// shared (static) initialization, exactly aligned with C#.
///
/// The metadata contract is the primary witness (deterministic and
/// JIT-independent): a type with an explicit `shared { init { … } }`
/// block emits a real `.cctor` and does NOT carry
/// (cref:System.Reflection.TypeAttributes.BeforeFieldInit) — C#
/// static-constructor timing. A type with only shared field initializers (no
/// explicit block) also emits a `.cctor` but KEEPS
/// `beforefieldinit`, so the runtime may run it at an unspecified point
/// no later than the first static-field access — exactly like a C# type with
/// only static field initializers.
///
/// The behavioral tests are the secondary witness and assert only the
/// C#-guaranteed direction — the initializer has executed by the time the
/// first static member access completes. They use direct console writes (not
/// a main-initialized global) so they stay correct even where the runtime
/// legally runs a type initializer earlier than the precise trigger point
/// (observed on CoreCLR for assemblies in collectible
/// (cref:AssemblyLoadContext)s).
open class Issue3203SharedInitializerCctorTests {
    @Fact
    func ClassWithInitBlock_EmitsCctor_AndClearsBeforeFieldInit() {
        let source = `package InitBlockClass
import System

class Ordered {
    shared {
        var Count int32 = 1
        init {
            Count = 2
        }
    }
}

Console.WriteLine(Ordered.Count)
`
        let (attrs, hasCctor) = CompileAndInspectType(source, "Ordered")
        Assert.True(hasCctor, "a class with a shared init block must emit a .cctor")
        Assert.False(
            (attrs & TypeAttributes.BeforeFieldInit) != 0,
            "a class with a shared init block must not be beforefieldinit"
        )
    }

    @Fact
    func StructWithInitBlock_EmitsCctor_AndClearsBeforeFieldInit() {
        let source = `package InitBlockStruct
import System

struct Counter {
    shared {
        var Count int32 = 0
        init {
            Count = 7
        }
    }
}

Console.WriteLine(Counter.Count)
`
        let (attrs, hasCctor) = CompileAndInspectType(source, "Counter")
        Assert.True(hasCctor, "a struct with a shared init block must emit a .cctor")
        Assert.False(
            (attrs & TypeAttributes.BeforeFieldInit) != 0,
            "a struct with a shared init block must not be beforefieldinit"
        )
    }

    @Fact
    func ClassWithOnlyFieldInitializers_KeepsBeforeFieldInit() {
        // The C#-aligned other half of the #3203 decision: shared FIELD
        // initializers alone do not declare an explicit type-initializer body,
        // so the type keeps beforefieldinit (initialization runs at an
        // unspecified time no later than first static-field access — the CLR
        // may even skip it entirely when no static field is ever touched).
        let source = `package FieldInitOnlyClass
import System

class Eager {
    shared {
        let Value int32 = 41 + 1
    }
}

Console.WriteLine(Eager.Value)
`
        let (attrs, hasCctor) = CompileAndInspectType(source, "Eager")
        Assert.True(hasCctor, "shared field initializers still emit a .cctor")
        Assert.True(
            (attrs & TypeAttributes.BeforeFieldInit) != 0,
            "a class with only shared field initializers keeps beforefieldinit, like C#"
        )
    }

    @Fact
    func StructWithOnlyFieldInitializers_KeepsBeforeFieldInit() {
        let source = `package FieldInitOnlyStruct
import System

struct Lazy {
    shared {
        let Value int32 = 5 * 5
    }
}

Console.WriteLine(Lazy.Value)
`
        let (attrs, hasCctor) = CompileAndInspectType(source, "Lazy")
        Assert.True(hasCctor, "shared field initializers still emit a .cctor")
        Assert.True(
            (attrs & TypeAttributes.BeforeFieldInit) != 0,
            "a struct with only shared field initializers keeps beforefieldinit, like C#"
        )
    }

    @Fact
    func GenericClassWithInitBlock_ClearsBeforeFieldInit_AndRunsCctor() {
        // Phase 4 emit parity: generic definitions are emitted type-erased as
        // a single CLR TypeDef, so the beforefieldinit contract lands on that
        // TypeDef and its .cctor covers every constructed use.
        let source = `package InitBlockGeneric
import System

class Box[T] {
    shared {
        var Tag int32 = 1
        init {
            Tag = Tag + 10
        }
    }
}

Console.WriteLine(Box[int32].Tag)
`
        let (attrs, hasCctor) = CompileAndInspectType(source, "Box`1")
        Assert.True(hasCctor, "a generic class with a shared init block must emit a .cctor")
        Assert.False(
            (attrs & TypeAttributes.BeforeFieldInit) != 0,
            "a generic class with a shared init block must not be beforefieldinit"
        )
        let output = CompileLoadInvokeCaptureStdout(source, "Issue3203-Generic")
        Assert.Equal("11", output.Trim())
    }

    @Fact
    func InitBlock_RunsAfterCallArguments_BeforeFirstStaticMethodAccess() {
        // The #3203 divergence repro, in the decided explicit-block form: the
        // first static access is a method that touches NO static field, so
        // only the cleared beforefieldinit flag makes the runtime run the
        // .cctor at all. C#-guaranteed timing: call arguments evaluate first
        // ("A"), the .cctor runs at the invocation of Use ("I"), then the
        // method body ("M").
        let source = `package InitBlockTiming
import System

func Argument() int32 {
    Console.Write("A")
    return 1
}

class Ordered {
    shared {
        init {
            Console.Write("I")
        }

        func Use(value int32) {
            Console.Write("M")
        }
    }
}

Ordered.Use(Argument())
`
        let output = CompileLoadInvokeCaptureStdout(source, "Issue3203-Timing").Trim()
        // The guaranteed direction: the init block has executed by the time
        // the first static member access runs its body ("I" strictly before
        // "M") — without the cleared flag the CLR never runs it here at all.
        let initIndex = output.IndexOf('I', StringComparison.Ordinal)
        let methodIndex = output.IndexOf('M', StringComparison.Ordinal)
        Assert.True(initIndex >= 0, "init block never ran; output was '$output'")
        Assert.True(
            initIndex < methodIndex,
            "init block must run before the first static member body; output was '$output'"
        )
        Assert.Equal("AIM", output)
    }

    @Fact
    func BaseClassInitBlock_RunsBeforeFirstDerivedInstanceCreation() {
        // Creating a Derived instance invokes Base's instance constructor,
        // which (Base being non-beforefieldinit) triggers Base's .cctor no
        // later than that call — so "B" always precedes "D".
        let source = `package InitBlockInheritance
import System

open class Base {
    shared {
        init {
            Console.Write("B")
        }
    }
}

class Derived : Base {
}

let d = Derived()
Console.Write("D")
`
        let output = CompileLoadInvokeCaptureStdout(source, "Issue3203-Inheritance").Trim()
        Assert.Equal("BD", output)
    }

    shared {
        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileAndInspectType(source string, typeName string)(Attributes TypeAttributes, HasCctor bool) {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
            let md = peReader.GetMetadataReader()
            let typeDef = md
                .TypeDefinitions
                .Select(md.GetTypeDefinition)
                .Single((t TypeDefinition) -> md.GetString(t.Name) == typeName)
            let hasCctor = typeDef
                .GetMethods()
                .Select(md.GetMethodDefinition)
                .Any((m MethodDefinition) -> md.GetString(m.Name) == ".cctor")
            return (typeDef.Attributes, hasCctor)
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
