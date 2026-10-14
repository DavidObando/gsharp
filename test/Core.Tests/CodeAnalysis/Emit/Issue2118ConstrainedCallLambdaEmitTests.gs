// <copyright file="Issue2118ConstrainedCallLambdaEmitTests.cs" company="GSharp">
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
import System.Runtime.Loader
import Xunit

/// Issue #2118 — a non-capturing lambda whose body performs a constrained
/// interface call on a value of an enclosing type parameter (`T`
/// constrained to an interface) must emit verifiable IL. Before the fix the
/// lambda was hosted as a plain (non-generic) static method that still
/// referenced the enclosing parameter `T` in its signature, so its
/// `constrained. !!T` call left a bare type-parameter value where the
/// interface was expected (ilverify `StackUnexpected`), and the
/// delegate `ldftn` referenced an ill-formed method (`DelegateCtor`).
/// The fix promotes such lambdas into genuine generic methods that clone the
/// referenced enclosing parameters — with their constraints — as their own
/// method type parameters, so the emitted body is identical to the equivalent
/// direct method and JIT-executes correctly. These tests JIT-run the promoted
/// lambdas end-to-end (an invalid method body would throw at invoke time) and
/// assert the structural shape of the promotion.
open class Issue2118ConstrainedCallLambdaEmitTests {
    @Fact
    func MethodTypeParam_ConstrainedInterfaceCall_InLambda_Int_Executes() {
        const Source = `package P
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
`
        let (asm, ctx) = CompileToAssembly(Source, "MethodTypeParam_ConstrainedInterfaceCall_InLambda_Int_Executes")
        try {
            Assert.True(int32(GetProgramMethod(asm, "RunLess").Invoke(nil, nil)!!) < 0)
            Assert.True(int32(GetProgramMethod(asm, "RunGreater").Invoke(nil, nil)!!) > 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func MethodTypeParam_ConstrainedInterfaceCall_InLambda_String_Executes() {
        // Generalization: the same shape over a different type argument
        // (System.String, also IComparable[String]) must work too.
        const Source = `package P
import System

func Build[T IComparable[T]]() (T, T) -> int32 {
    let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
    return f
}

func Run() int32 {
    let g = Build[string]()
    return g("apple", "banana")
}
`
        let (asm, ctx) = CompileToAssembly(Source, "MethodTypeParam_ConstrainedInterfaceCall_InLambda_String_Executes")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) < 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ClassTypeParam_ConstrainedInterfaceCall_InLambda_Executes() {
        // The doubly-broken case before the fix: the enclosing parameter is a
        // *class* type parameter. The promoted lambda must clone it as its own
        // method type parameter and encode the constraint as `!!0`, not the
        // (non-existent, on the top-level host) class slot `!0`.
        const Source = `package P
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
`
        let (asm, ctx) = CompileToAssembly(Source, "ClassTypeParam_ConstrainedInterfaceCall_InLambda_Executes")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) > 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func UserInterfaceMethod_ConstrainedCall_InLambda_Executes() {
        // Generalization to ANY interface method (not only IComparable.CompareTo)
        // and a user-declared G# interface rather than an imported CLR one.
        const Source = `package P

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
`
        let (asm, ctx) = CompileToAssembly(Source, "UserInterfaceMethod_ConstrainedCall_InLambda_Executes")
        try {
            Assert.Equal(42, GetProgramMethod(asm, "Run").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func MultiTypeParamEnclosingMethod_LambdaUsesSubset_Executes() {
        // Only the referenced enclosing parameter (T) is cloned onto the
        // promoted lambda; the unused U is not, so the lambda is a single-arity
        // generic method and still JIT-runs.
        const Source = `package P
import System

func Build[T IComparable[T], U]() (T, T) -> int32 {
    let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
    return f
}

func Run() int32 {
    let g = Build[int32, string]()
    return g(3, 7)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "MultiTypeParamEnclosingMethod_LambdaUsesSubset_Executes")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) < 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ConcreteInterfaceReceiver_InLambda_Executes_NoRegression() {
        // Control: a lambda whose receiver is a *concrete* interface type
        // legitimately does NOT need a `constrained.` prefix. Promotion must not
        // fire (there is no enclosing type parameter) and the call must run.
        const Source = `package P
import System

func Build() (IComparable[int32]) -> int32 {
    let f (IComparable[int32]) -> int32 = (x IComparable[int32]) -> x.CompareTo(0)
    return f
}

func Run() int32 {
    let g = Build()
    return g(5)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ConcreteInterfaceReceiver_InLambda_Executes_NoRegression")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) > 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DirectMethod_ConstrainedInterfaceCall_Executes_NoRegression() {
        // Control: the equivalent direct (non-lambda) method already emitted the
        // correct constrained call and must keep working unchanged.
        const Source = `package P
import System

open class C[T IComparable[T]] {
    func Cmp(x T, y T) int32 -> x.CompareTo(y)
}

func Run() int32 {
    let c = C[int32]()
    return c.Cmp(3, 7)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DirectMethod_ConstrainedInterfaceCall_Executes_NoRegression")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) < 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func PromotedLambda_IsGenericMethodDefinition_WithConstrainedTypeParameter() {
        // Structural assertion of the fix: the synthesized lambda host is a
        // proper generic method definition whose (cloned) type parameter carries
        // the interface constraint — the missing GenericParamConstraint that made
        // the pre-fix IL unverifiable.
        const Source = `package P
import System

func Build[T IComparable[T]]() (T, T) -> int32 {
    let f (T, T) -> int32 = (x T, y T) -> x.CompareTo(y)
    return f
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "PromotedLambda_IsGenericMethodDefinition_WithConstrainedTypeParameter"
        )
        try {
            let programType = asm.GetTypes().First((t Type) -> t.Name == "<Program>")
            let promoted = programType
                .GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
                .Where((m MethodInfo) -> m.IsGenericMethodDefinition)
                .Where((m MethodInfo) -> m.GetGenericArguments()[0].GetGenericParameterConstraints().Length > 0)
                .ToList()
            Assert.NotEmpty(promoted)
            let lambda = promoted.First((m MethodInfo) -> m.Name.Contains("lambda", StringComparison.Ordinal))
            let typeParam = lambda.GetGenericArguments()[0]
            let constraint = typeParam.GetGenericParameterConstraints().Single()
            Assert.Equal(typeof(IComparable[_]).Name, constraint.Name)
        } finally {
            ctx.Unload()
        }
    }

    shared {
        private func GetProgramMethod(asm Assembly, name string) MethodInfo {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                name,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }

        private func CompileToAssembly(source string, contextName string)(Asm Assembly, Ctx AssemblyLoadContext) {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            let asm = loadContext.LoadFromStream(peStream)
            return (asm, loadContext)
        }
    }
}
