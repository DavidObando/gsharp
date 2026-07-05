// <copyright file="Issue2118ConstrainedCallLambdaEmitTests.cs" company="GSharp">
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
/// Issue #2118 — a non-capturing lambda whose body performs a constrained
/// interface call on a value of an enclosing type parameter (<c>T</c>
/// constrained to an interface) must emit verifiable IL. Before the fix the
/// lambda was hosted as a plain (non-generic) static method that still
/// referenced the enclosing parameter <c>T</c> in its signature, so its
/// <c>constrained. !!T</c> call left a bare type-parameter value where the
/// interface was expected (ilverify <c>StackUnexpected</c>), and the
/// delegate <c>ldftn</c> referenced an ill-formed method (<c>DelegateCtor</c>).
/// The fix promotes such lambdas into genuine generic methods that clone the
/// referenced enclosing parameters — with their constraints — as their own
/// method type parameters, so the emitted body is identical to the equivalent
/// direct method and JIT-executes correctly. These tests JIT-run the promoted
/// lambdas end-to-end (an invalid method body would throw at invoke time) and
/// assert the structural shape of the promotion.
/// </summary>
public class Issue2118ConstrainedCallLambdaEmitTests
{
    [Fact]
    public void MethodTypeParam_ConstrainedInterfaceCall_InLambda_Int_Executes()
    {
        const string Source = @"package P
import System

func Build[T IComparable[T]]() (T, T) -> int32 {
    let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
    return f
}

func RunLess() int32 {
    let g = Build[int32]()
    return g(3, 7)
}

func RunGreater() int32 {
    let g = Build[int32]()
    return g(7, 3)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(MethodTypeParam_ConstrainedInterfaceCall_InLambda_Int_Executes));
        try
        {
            Assert.True((int)GetProgramMethod(asm, "RunLess").Invoke(null, null)! < 0);
            Assert.True((int)GetProgramMethod(asm, "RunGreater").Invoke(null, null)! > 0);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void MethodTypeParam_ConstrainedInterfaceCall_InLambda_String_Executes()
    {
        // Generalization: the same shape over a different type argument
        // (System.String, also IComparable[String]) must work too.
        const string Source = @"package P
import System

func Build[T IComparable[T]]() (T, T) -> int32 {
    let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
    return f
}

func Run() int32 {
    let g = Build[string]()
    return g(""apple"", ""banana"")
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(MethodTypeParam_ConstrainedInterfaceCall_InLambda_String_Executes));
        try
        {
            Assert.True((int)GetProgramMethod(asm, "Run").Invoke(null, null)! < 0);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ClassTypeParam_ConstrainedInterfaceCall_InLambda_Executes()
    {
        // The doubly-broken case before the fix: the enclosing parameter is a
        // *class* type parameter. The promoted lambda must clone it as its own
        // method type parameter and encode the constraint as `!!0`, not the
        // (non-existent, on the top-level host) class slot `!0`.
        const string Source = @"package P
import System

open class C[T IComparable[T]] {
    func Make() (T, T) -> int32 {
        let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
        return f
    }
}

func Run() int32 {
    let c = C[int32]()
    let g = c.Make()
    return g(7, 3)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ClassTypeParam_ConstrainedInterfaceCall_InLambda_Executes));
        try
        {
            Assert.True((int)GetProgramMethod(asm, "Run").Invoke(null, null)! > 0);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void UserInterfaceMethod_ConstrainedCall_InLambda_Executes()
    {
        // Generalization to ANY interface method (not only IComparable.CompareTo)
        // and a user-declared G# interface rather than an imported CLR one.
        const string Source = @"package P

interface IShout {
    func Shout() int32;
}

class Loud : IShout {
    func Shout() int32 -> 42
}

func Build[T IShout]() (T) -> int32 {
    let f (T) -> int32 = (x T) -> x.Shout()
    return f
}

func Run() int32 {
    let g = Build[Loud]()
    return g(Loud())
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(UserInterfaceMethod_ConstrainedCall_InLambda_Executes));
        try
        {
            Assert.Equal(42, GetProgramMethod(asm, "Run").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void MultiTypeParamEnclosingMethod_LambdaUsesSubset_Executes()
    {
        // Only the referenced enclosing parameter (T) is cloned onto the
        // promoted lambda; the unused U is not, so the lambda is a single-arity
        // generic method and still JIT-runs.
        const string Source = @"package P
import System

func Build[T IComparable[T], U]() (T, T) -> int32 {
    let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
    return f
}

func Run() int32 {
    let g = Build[int32, string]()
    return g(3, 7)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(MultiTypeParamEnclosingMethod_LambdaUsesSubset_Executes));
        try
        {
            Assert.True((int)GetProgramMethod(asm, "Run").Invoke(null, null)! < 0);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ConcreteInterfaceReceiver_InLambda_Executes_NoRegression()
    {
        // Control: a lambda whose receiver is a *concrete* interface type
        // legitimately does NOT need a `constrained.` prefix. Promotion must not
        // fire (there is no enclosing type parameter) and the call must run.
        const string Source = @"package P
import System

func Build() (IComparable[int32]) -> int32 {
    let f (IComparable[int32]) -> int32 = (x IComparable[int32]) -> x.CompareTo(0)
    return f
}

func Run() int32 {
    let g = Build()
    return g(5)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ConcreteInterfaceReceiver_InLambda_Executes_NoRegression));
        try
        {
            Assert.True((int)GetProgramMethod(asm, "Run").Invoke(null, null)! > 0);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void DirectMethod_ConstrainedInterfaceCall_Executes_NoRegression()
    {
        // Control: the equivalent direct (non-lambda) method already emitted the
        // correct constrained call and must keep working unchanged.
        const string Source = @"package P
import System

open class C[T IComparable[T]] {
    func Cmp(x T, y T) int32 -> x.CompareTo(y)
}

func Run() int32 {
    let c = C[int32]()
    return c.Cmp(3, 7)
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(DirectMethod_ConstrainedInterfaceCall_Executes_NoRegression));
        try
        {
            Assert.True((int)GetProgramMethod(asm, "Run").Invoke(null, null)! < 0);
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void PromotedLambda_IsGenericMethodDefinition_WithConstrainedTypeParameter()
    {
        // Structural assertion of the fix: the synthesized lambda host is a
        // proper generic method definition whose (cloned) type parameter carries
        // the interface constraint — the missing GenericParamConstraint that made
        // the pre-fix IL unverifiable.
        const string Source = @"package P
import System

func Build[T IComparable[T]]() (T, T) -> int32 {
    let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
    return f
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(PromotedLambda_IsGenericMethodDefinition_WithConstrainedTypeParameter));
        try
        {
            var programType = asm.GetTypes().First(t => t.Name == "<Program>");
            var promoted = programType
                .GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .Where(m => m.IsGenericMethodDefinition)
                .Where(m => m.GetGenericArguments()[0].GetGenericParameterConstraints().Length > 0)
                .ToList();

            Assert.NotEmpty(promoted);
            var lambda = promoted.First(m => m.Name.Contains("lambda", StringComparison.Ordinal));
            var typeParam = lambda.GetGenericArguments()[0];
            var constraint = typeParam.GetGenericParameterConstraints().Single();
            Assert.Equal(typeof(IComparable<>).Name, constraint.Name);
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static MethodInfo GetProgramMethod(Assembly asm, string name)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
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
}
