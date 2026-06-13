// <copyright file="Issue792ExtensionAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #792 / ADR-0084 (Known limitation L4): G# extension functions —
/// `func (self T) Name(...) ...` — must emit with
/// <see cref="ExtensionAttribute"/> stamped on both the MethodDef row and
/// its containing TypeDef row so the C#/F# compiler's call-site lookup
/// (ECMA-334 §13.6.9) recognises them as extension methods. Without
/// these markers the same `.Name(args)` call from C# would fail to
/// resolve, which is the cycle this issue exists to break.
/// </summary>
public class Issue792ExtensionAttributeEmitTests
{
    [Fact]
    public void ExtensionFunction_StampsExtensionAttribute_OnMethodDef()
    {
        const string Source = @"package Issue792.MethodMarker

import System

func (self string) Shout() string {
    return self + ""!""
}
";
        var asm = CompileToAssembly(Source, "Issue792.MethodMarker");

        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var shout = programType.GetMethod("Shout", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(shout);
        Assert.True(
            shout!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the extension MethodDef.");
    }

    [Fact]
    public void ExtensionFunction_StampsExtensionAttribute_OnHostingTypeDef()
    {
        const string Source = @"package Issue792.TypeMarker

import System

func (self string) Echo() string {
    return self
}
";
        var asm = CompileToAssembly(Source, "Issue792.TypeMarker");

        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        Assert.True(
            programType.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the <Program> TypeDef hosting the extension methods.");
    }

    [Fact]
    public void NonExtensionFunction_DoesNotStampExtensionAttribute()
    {
        const string Source = @"package Issue792.NoMarker

import System

func Plain(x int32) int32 {
    return x
}
";
        var asm = CompileToAssembly(Source, "Issue792.NoMarker");

        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var plain = programType.GetMethod("Plain", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(plain);
        Assert.Empty(plain!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false));
        Assert.Empty(programType.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false));
    }

    [Fact]
    public void GenericExtensionFunction_StampsExtensionAttribute()
    {
        const string Source = @"package Issue792.GenericMarker

import System

func (self T) Identity[T]() T {
    return self
}
";
        var asm = CompileToAssembly(Source, "Issue792.GenericMarker");

        var programType = asm.GetTypes().Single(t => t.Name == "<Program>");
        var identity = programType.GetMethod("Identity", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(identity);
        Assert.True(
            identity!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on generic extension methods too.");
        Assert.True(
            programType.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the host TypeDef once even with multiple generic extensions.");
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
