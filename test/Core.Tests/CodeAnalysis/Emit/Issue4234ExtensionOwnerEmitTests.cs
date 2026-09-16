// <copyright file="Issue4234ExtensionOwnerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #4234: a migrated (self-hosted) C# static extension class — e.g.
/// <c>Gsharp.Concurrency.ChannelExtensions</c> — loses its CLR owner-type
/// identity when cs2gs lifts its extension methods to top-level G# funcs,
/// because a top-level extension function is always hosted on the package's
/// synthesized <c>&lt;Program&gt;</c> TypeDef (ADR-0084). That broke
/// reflection tests (<c>typeof(ChannelExtensions).GetMethods()</c>) and
/// analyzer owner-specific recognition in the migrated runtime, which both
/// key off the exact declaring type.
///
/// <c>@ExtensionOwner(typeof(T))</c> lets a top-level extension function name
/// a same-package, non-generic class/struct to host its MethodDef on
/// instead — reusing the same <c>StaticOwnerType</c> + owner-registered-
/// methods machinery ADR-0053 already uses for ordinary shared-block static
/// methods (and the receiver-clause-operator path already uses to route a
/// TOP-LEVEL declaration onto a same-package receiver's TypeDef).
/// </summary>
public class Issue4234ExtensionOwnerEmitTests
{
    [Fact]
    public void ExtensionOwner_HostsMethodDef_OnNamedOwnerType_NotProgram()
    {
        const string Source = @"package Issue4234.OwnerRouting

import System
import System.Text

class ChannelExtensions {
}

@ExtensionOwner(typeof(ChannelExtensions))
func (sb StringBuilder) Shout() string {
    return sb.ToString()
}
";
        var asm = CompileToAssembly(Source, "Issue4234.OwnerRouting");

        var owner = asm.GetTypes().Single(t => t.Name == "ChannelExtensions");
        var program = asm.GetTypes().Single(t => t.Name == "<Program>");

        // The method lands on the named owner, not <Program> — matching the
        // native C# `static class ChannelExtensions { public static void
        // Close(...) }` shape byte-for-byte in the metadata it observes.
        var shout = owner.GetMethod("Shout", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(shout);
        Assert.Null(program.GetMethod("Shout", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic));

        // ECMA-334 §13.6.9: a C#/F# consumer only recognises an extension
        // method when its container is non-generic, abstract, AND sealed
        // (the CLR encoding of a C# `static class`) — MemberLookup.IsStaticClass
        // in gsc's own metadata importer applies the identical check when a
        // second G# project references this one.
        Assert.True(owner.IsAbstract, "owner TypeDef should be Abstract (static-class shape).");
        Assert.True(owner.IsSealed, "owner TypeDef should be Sealed (static-class shape).");
        Assert.True(
            owner.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the owner TypeDef.");
        Assert.True(
            shout!.GetCustomAttributes(typeof(ExtensionAttribute), inherit: false).Length == 1,
            "ExtensionAttribute should be stamped on the routed MethodDef.");
    }

    [Fact]
    public void ExtensionOwner_MissingTypeofArgument_ReportsGS9306()
    {
        const string Source = @"package Issue4234.BadArgument

import System.Text

@ExtensionOwner(""not-a-type"")
func (sb StringBuilder) Shout() string {
    return sb.ToString()
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9306");
    }

    [Fact]
    public void ExtensionOwner_TargetingGenericType_ReportsGS9306()
    {
        const string Source = @"package Issue4234.GenericOwner

import System.Text

class Holder[T] {
}

@ExtensionOwner(typeof(Holder))
func (sb StringBuilder) Shout() string {
    return sb.ToString()
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9306");
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
