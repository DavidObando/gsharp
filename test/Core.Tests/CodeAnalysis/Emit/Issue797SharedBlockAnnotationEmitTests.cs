// <copyright file="Issue797SharedBlockAnnotationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
/// Issue #797: end-to-end emit verification that a Kotlin-style annotation
/// on a static method declared inside a <c>shared { … }</c> block
/// (ADR-0053) survives the parser → binder → emitter pipeline and lands as
/// a real <c>CustomAttribute</c> row on the emitted MethodDef.
/// </summary>
public class Issue797SharedBlockAnnotationEmitTests
{
    [Fact]
    public void AnnotationOnSharedStaticMethod_IsEmittedOnMethodDef()
    {
        const string Source = @"package Issue797.SharedAttrEmit

import System

class Sequences {
    shared {
        @Obsolete(""issue-797 marker"")
        func Range(start int32, count int32) int32 {
            return start + count
        }
    }
}
";
        var asm = CompileToAssembly(Source, "Issue797.SharedAttrEmit");

        var seqType = asm.GetTypes().Single(t => t.Name == "Sequences");
        var range = seqType.GetMethod(
            "Range",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance);
        Assert.NotNull(range);
        Assert.True(range!.IsStatic, "Range should be emitted as a static method (shared { } block).");

        var obsolete = range.GetCustomAttributes(typeof(ObsoleteAttribute), inherit: false)
            .Cast<ObsoleteAttribute>()
            .SingleOrDefault();
        Assert.NotNull(obsolete);
        Assert.Equal("issue-797 marker", obsolete!.Message);
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
