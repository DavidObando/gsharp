// <copyright file="Issue1103ExtensionImportedReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #1103. End-to-end (compile → load → reflective invoke) proof that an
/// extension function on an imported/BCL or primitive receiver dispatches when
/// called with instance/member syntax <c>receiver.ExtMethod(args)</c> from
/// inside a method body. Prior to the fix these call sites reported GS0159.
/// </summary>
public class Issue1103ExtensionImportedReceiverEmitTests
{
    [Fact]
    public void PrimitiveReceiver_InstanceCall_InMethodBody_Executes()
    {
        const string source = @"package Issue1103.PrimEmit

import System

func (n int32) Doubled() int32 {
    return n * 2
}

class C {
    public func UseInt(x int32) int32 {
        return x.Doubled()
    }
}
";
        var asm = CompileToAssembly(source, "Issue1103.PrimEmit");

        var cType = asm.GetTypes().Single(t => t.Name == "C");
        var instance = System.Activator.CreateInstance(cType);
        var useInt = cType.GetMethod("UseInt", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(useInt);

        var result = useInt!.Invoke(instance, new object[] { 21 });
        Assert.Equal(42, result);
    }

    [Fact]
    public void ImportedBclReceiver_InstanceCall_InMethodBody_Executes()
    {
        const string source = @"package Issue1103.BclEmit

import System
import System.IO

func (stream Stream) ReadU32() int32 {
    return 5
}

class C {
    public func UseInstance(file Stream) int32 {
        return file.ReadU32()
    }
}
";
        var asm = CompileToAssembly(source, "Issue1103.BclEmit");

        var cType = asm.GetTypes().Single(t => t.Name == "C");
        var instance = System.Activator.CreateInstance(cType);
        var useInstance = cType.GetMethod("UseInstance", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(useInstance);

        using var ms = new MemoryStream();
        var result = useInstance!.Invoke(instance, new object[] { ms });
        Assert.Equal(5, result);
    }

    private static Assembly CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: false);
        return loadContext.LoadFromStream(peStream);
    }
}
