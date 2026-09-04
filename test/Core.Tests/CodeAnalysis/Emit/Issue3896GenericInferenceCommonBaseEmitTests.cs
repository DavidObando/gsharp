// <copyright file="Issue3896GenericInferenceCommonBaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
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
/// Issue #3896: inferring an imported generic method's type argument from
/// several SAME-COMPILATION class arguments fixed the parameter at whichever
/// bound arrived first instead of at their common base.
/// <c>ImmutableArray.Create(derived, base)</c> therefore inferred
/// <c>ImmutableArray[Derived]</c> and failed to convert (GS0154), while the
/// argument-swapped <c>Create(base, derived)</c> inferred
/// <c>ImmutableArray[Base]</c> and compiled — an argument-order dependence C#
/// does not have. Imported types were already widened by the CLR-side
/// unification; a same-compilation class is erased to <c>object</c> in the
/// closed CLR method, so its bounds only ever meet on the symbolic path.
/// <para>These run the emitted code: fixing the parameter at the wrong bound
/// can also produce a silently mistyped array rather than an error.</para>
/// </summary>
public class Issue3896GenericInferenceCommonBaseEmitTests
{
    [Fact]
    public void DerivedArgumentBeforeBaseArgument_InfersCommonBase()
    {
        const string Source = @"package P
import System.Collections.Immutable

open class Base {
    func tag() int32 { return 1 }
}

class Derived : Base {
}

func count(items ImmutableArray[Base]) int32 {
    return items.Length
}

func run(b Base) int32 {
    return count(ImmutableArray.Create(Derived(), b))
}

func main() int32 {
    return run(Base())
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DerivedArgumentBeforeBaseArgument_InfersCommonBase));
        try
        {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void InferredElementTypeIsTheBase_NotTheFirstArgumentsType()
    {
        // The count above would also pass if T were fixed at `Derived` and the
        // conversion silently accepted, so assert the RUNTIME element type of
        // the array the call actually built.
        const string Source = @"package P
import System.Collections.Immutable

open class Base {
}

class Derived : Base {
}

func build(b Base) ImmutableArray[Base] {
    return ImmutableArray.Create(Derived(), b)
}

func elementTypeName() string {
    let built = build(Base())
    return built.GetType().GetGenericArguments()[0].Name
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(InferredElementTypeIsTheBase_NotTheFirstArgumentsType));
        try
        {
            Assert.Equal("Base", GetProgramMethod(asm, "elementTypeName").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ThreeLevelHierarchy_InfersTheSharedBase()
    {
        const string Source = @"package P
import System.Collections.Immutable

open class Root {
}

open class Middle : Root {
}

class Leaf : Middle {
}

func count(items ImmutableArray[Root]) int32 {
    return items.Length
}

func main() int32 {
    return count(ImmutableArray.Create(Leaf(), Middle(), Root()))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ThreeLevelHierarchy_InfersTheSharedBase));
        try
        {
            Assert.Equal(3, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DelegateParameterBound_DoesNotWidenTheReceiverBound()
    {
        // Precision guard, and the first thing the widening got wrong: a
        // DELEGATE PARAMETER constrains the type argument from above, so it is
        // not a candidate to widen to. `ImmutableArray[Derived].Where(pred)`
        // with `pred : func(Base) bool` must stay `Where[Derived]`. Widening it
        // to `Base` binds cleanly and emits a MethodSpec whose receiver no
        // longer matches it — IL that gsc accepts and ILVerify rejects
        // (StackUnexpected in ReflectionMetadataEmitter, observed on the real
        // corpus). This runs the code, so a mistyped instantiation shows up as
        // a runtime failure rather than only as a verifier complaint.
        const string Source = @"package P
import System.Collections.Immutable
import System.Linq

open class Base {
}

class Derived : Base {
}

func countKept(items ImmutableArray[Derived]) int32 {
    let keep = func (b Base) bool { return b != nil }
    return items.Where(keep).ToList().Count
}

func main() int32 {
    return countKept(ImmutableArray.Create(Derived(), Derived()))
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DelegateParameterBound_DoesNotWidenTheReceiverBound));
        try
        {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void UnrelatedClassArguments_StillFailToInfer()
    {
        // Precision guard: widening must follow a real base-class chain, not
        // collapse any two class bounds onto something that compiles.
        const string Source = @"package P
import System.Collections.Immutable

class Left {
}

class Right {
}

func count(items ImmutableArray[Left]) int32 {
    return items.Length
}

func main() int32 {
    return count(ImmutableArray.Create(Left(), Right()))
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.False(result.Success);
    }

    private static (Assembly Asm, AssemblyLoadContext Ctx) CompileToAssembly(string source, string contextName)
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
