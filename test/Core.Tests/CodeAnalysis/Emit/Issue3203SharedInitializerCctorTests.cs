// <copyright file="Issue3203SharedInitializerCctorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3203 / ADR-0140 §4: the emitted <c>beforefieldinit</c> contract for
/// shared (static) initialization, exactly aligned with C#.
/// <para>The metadata contract is the primary witness (deterministic and
/// JIT-independent): a type with an explicit <c>shared { init { … } }</c>
/// block emits a real <c>.cctor</c> and does NOT carry
/// <see cref="System.Reflection.TypeAttributes.BeforeFieldInit"/> — C#
/// static-constructor timing. A type with only shared field initializers (no
/// explicit block) also emits a <c>.cctor</c> but KEEPS
/// <c>beforefieldinit</c>, so the runtime may run it at an unspecified point
/// no later than the first static-field access — exactly like a C# type with
/// only static field initializers.</para>
/// <para>The behavioral tests are the secondary witness and assert only the
/// C#-guaranteed direction — the initializer has executed by the time the
/// first static member access completes. They use direct console writes (not
/// a main-initialized global) so they stay correct even where the runtime
/// legally runs a type initializer earlier than the precise trigger point
/// (observed on CoreCLR for assemblies in collectible
/// <see cref="AssemblyLoadContext"/>s).</para>
/// </summary>
public class Issue3203SharedInitializerCctorTests
{
    [Fact]
    public void ClassWithInitBlock_EmitsCctor_AndClearsBeforeFieldInit()
    {
        var source = @"package InitBlockClass
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
";
        var (attrs, hasCctor) = CompileAndInspectType(source, "Ordered");

        Assert.True(hasCctor, "a class with a shared init block must emit a .cctor");
        Assert.False(
            (attrs & System.Reflection.TypeAttributes.BeforeFieldInit) != 0,
            "a class with a shared init block must not be beforefieldinit");
    }

    [Fact]
    public void StructWithInitBlock_EmitsCctor_AndClearsBeforeFieldInit()
    {
        var source = @"package InitBlockStruct
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
";
        var (attrs, hasCctor) = CompileAndInspectType(source, "Counter");

        Assert.True(hasCctor, "a struct with a shared init block must emit a .cctor");
        Assert.False(
            (attrs & System.Reflection.TypeAttributes.BeforeFieldInit) != 0,
            "a struct with a shared init block must not be beforefieldinit");
    }

    [Fact]
    public void ClassWithOnlyFieldInitializers_KeepsBeforeFieldInit()
    {
        // The C#-aligned other half of the #3203 decision: shared FIELD
        // initializers alone do not declare an explicit type-initializer body,
        // so the type keeps beforefieldinit (initialization runs at an
        // unspecified time no later than first static-field access — the CLR
        // may even skip it entirely when no static field is ever touched).
        var source = @"package FieldInitOnlyClass
import System

class Eager {
    shared {
        let Value int32 = 41 + 1
    }
}

Console.WriteLine(Eager.Value)
";
        var (attrs, hasCctor) = CompileAndInspectType(source, "Eager");

        Assert.True(hasCctor, "shared field initializers still emit a .cctor");
        Assert.True(
            (attrs & System.Reflection.TypeAttributes.BeforeFieldInit) != 0,
            "a class with only shared field initializers keeps beforefieldinit, like C#");
    }

    [Fact]
    public void StructWithOnlyFieldInitializers_KeepsBeforeFieldInit()
    {
        var source = @"package FieldInitOnlyStruct
import System

struct Lazy {
    shared {
        let Value int32 = 5 * 5
    }
}

Console.WriteLine(Lazy.Value)
";
        var (attrs, hasCctor) = CompileAndInspectType(source, "Lazy");

        Assert.True(hasCctor, "shared field initializers still emit a .cctor");
        Assert.True(
            (attrs & System.Reflection.TypeAttributes.BeforeFieldInit) != 0,
            "a struct with only shared field initializers keeps beforefieldinit, like C#");
    }

    [Fact]
    public void GenericClassWithInitBlock_ClearsBeforeFieldInit_AndRunsCctor()
    {
        // Phase 4 emit parity: generic definitions are emitted type-erased as
        // a single CLR TypeDef, so the beforefieldinit contract lands on that
        // TypeDef and its .cctor covers every constructed use.
        var source = @"package InitBlockGeneric
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
";
        var (attrs, hasCctor) = CompileAndInspectType(source, "Box`1");
        Assert.True(hasCctor, "a generic class with a shared init block must emit a .cctor");
        Assert.False(
            (attrs & System.Reflection.TypeAttributes.BeforeFieldInit) != 0,
            "a generic class with a shared init block must not be beforefieldinit");

        var output = CompileLoadInvokeCaptureStdout(source, "Issue3203-Generic");
        Assert.Equal("11", output.Trim());
    }

    [Fact]
    public void InitBlock_RunsAfterCallArguments_BeforeFirstStaticMethodAccess()
    {
        // The #3203 divergence repro, in the decided explicit-block form: the
        // first static access is a method that touches NO static field, so
        // only the cleared beforefieldinit flag makes the runtime run the
        // .cctor at all. C#-guaranteed timing: call arguments evaluate first
        // ("A"), the .cctor runs at the invocation of Use ("I"), then the
        // method body ("M").
        var source = @"package InitBlockTiming
import System

func Argument() int32 {
    Console.Write(""A"")
    return 1
}

class Ordered {
    shared {
        init {
            Console.Write(""I"")
        }

        func Use(value int32) {
            Console.Write(""M"")
        }
    }
}

Ordered.Use(Argument())
";
        var output = CompileLoadInvokeCaptureStdout(source, "Issue3203-Timing").Trim();

        // The guaranteed direction: the init block has executed by the time
        // the first static member access runs its body ("I" strictly before
        // "M") — without the cleared flag the CLR never runs it here at all.
        var initIndex = output.IndexOf('I', StringComparison.Ordinal);
        var methodIndex = output.IndexOf('M', StringComparison.Ordinal);
        Assert.True(initIndex >= 0, $"init block never ran; output was '{output}'");
        Assert.True(initIndex < methodIndex, $"init block must run before the first static member body; output was '{output}'");
        Assert.Equal("AIM", output);
    }

    [Fact]
    public void BaseClassInitBlock_RunsBeforeFirstDerivedInstanceCreation()
    {
        // Creating a Derived instance invokes Base's instance constructor,
        // which (Base being non-beforefieldinit) triggers Base's .cctor no
        // later than that call — so "B" always precedes "D".
        var source = @"package InitBlockInheritance
import System

open class Base {
    shared {
        init {
            Console.Write(""B"")
        }
    }
}

class Derived : Base {
}

let d = Derived()
Console.Write(""D"")
";
        var output = CompileLoadInvokeCaptureStdout(source, "Issue3203-Inheritance").Trim();

        Assert.Equal("BD", output);
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static (System.Reflection.TypeAttributes Attributes, bool HasCctor) CompileAndInspectType(string source, string typeName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();
        var typeDef = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single(t => md.GetString(t.Name) == typeName);
        var hasCctor = typeDef.GetMethods()
            .Select(md.GetMethodDefinition)
            .Any(m => md.GetString(m.Name) == ".cctor");
        return (typeDef.Attributes, hasCctor);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
