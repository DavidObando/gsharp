// <copyright file="Issue1192GenericPrimaryCtorFunctionParamEmitTests.cs" company="GSharp">
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
/// Issue #1192: when a generic class has a primary constructor whose parameter
/// type is a function/delegate type mentioning the type parameter (e.g.
/// <c>(T) -&gt; void</c>), the type argument must be substituted at the
/// constructed type so both direct construction and a derived <c>: base(...)</c>
/// call type-check and emit. These end-to-end emit+run tests prove the
/// constructors actually execute at runtime over the substituted delegate type
/// (previously rejected with GS0214 / GS0154).
/// </summary>
public class Issue1192GenericPrimaryCtorFunctionParamEmitTests
{
    [Fact]
    public void DirectConstruction_WithSubstitutedFunctionParam_ConstructsAndRuns()
    {
        const string Source = @"package P
open class Base[T](report (T) -> void) {
}
func main() int32 {
    var captured = 0
    let b = Base[int32](func (x int32) { captured = x })
    return 42
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DirectConstruction_WithSubstitutedFunctionParam_ConstructsAndRuns));
        try
        {
            Assert.Equal(42, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DerivedBaseInitializer_WithSubstitutedFunctionParam_ConstructsAndRuns()
    {
        const string Source = @"package P
open class Base[T](report (T) -> void) {
}
open class Derived : Base[int32] {
    init(report (int32) -> void) : base(report) { }
}
func main() int32 {
    var captured = 0
    let d = Derived(func (x int32) { captured = x })
    return 7
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DerivedBaseInitializer_WithSubstitutedFunctionParam_ConstructsAndRuns));
        try
        {
            Assert.Equal(7, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static (Assembly asm, AssemblyLoadContext ctx) CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        var asm = loadContext.LoadFromStream(peStream);
        return (asm, loadContext);
    }

    private static MethodInfo GetProgramMethod(Assembly asm, string name)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
    }
}
