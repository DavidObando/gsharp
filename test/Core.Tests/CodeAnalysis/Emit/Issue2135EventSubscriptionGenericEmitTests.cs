// <copyright file="Issue2135EventSubscriptionGenericEmitTests.cs" company="GSharp">
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
/// Issue #2135: an event subscription (<c>+=</c>) whose delegate/handler type
/// involves a same-compilation generic user type — which is a
/// <see cref="System.Reflection.Emit.TypeBuilderInstantiation"/> at emit — must
/// compile all the way to a real PE without the
/// <c>GS9998 NotSupportedException</c> that previously escaped from
/// <c>ClrTypeUtilities.IsAssignableByName</c> (see
/// <c>Issue2135TypeBuilderInstantiationTests</c> for the direct root-cause
/// guard). These end-to-end tests compile generic user types that declare an
/// event whose delegate references the type parameter and subscribe to it,
/// asserting emit succeeds and produces no GS9998.
/// </summary>
public class Issue2135EventSubscriptionGenericEmitTests
{
    [Fact]
    public void MethodGroupHandler_OnGenericTypeEvent_EmitsWithoutCrash()
    {
        const string Source = @"package Issue2135MethodGroup
class Bus[T] {
    event OnMsg (T) -> void
    func Handle(v T) { }
    func Wire() {
        OnMsg += Handle
    }
}
";
        var asm = CompileToAssembly(Source, nameof(MethodGroupHandler_OnGenericTypeEvent_EmitsWithoutCrash));
        Assert.Contains(asm.GetTypes(), t => t.Name == "Bus`1");
    }

    [Fact]
    public void LambdaHandler_OnGenericTypeEvent_EmitsWithoutCrash()
    {
        const string Source = @"package Issue2135Lambda
class Bus[T] {
    event OnMsg (T) -> void
    func Wire(x T) {
        OnMsg += func(y T) { }
    }
}
";
        var asm = CompileToAssembly(Source, nameof(LambdaHandler_OnGenericTypeEvent_EmitsWithoutCrash));
        Assert.Contains(asm.GetTypes(), t => t.Name == "Bus`1");
    }

    [Fact]
    public void DelegateParamHandler_OnGenericUserDelegateEvent_EmitsWithoutCrash()
    {
        const string Source = @"package Issue2135UserDelegate
type Handler[T] = delegate func(v T)
class Bus[T] {
    event OnMsg Handler[T]
    func Wire(h Handler[T]) {
        OnMsg += h
    }
}
";
        var asm = CompileToAssembly(Source, nameof(DelegateParamHandler_OnGenericUserDelegateEvent_EmitsWithoutCrash));
        Assert.Contains(asm.GetTypes(), t => t.Name == "Bus`1");
    }

    private static Assembly CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        return loadContext.LoadFromStream(peStream);
    }
}
