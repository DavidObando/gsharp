// <copyright file="Issue2123ConstrainedCallCapturingClosureEmitTests.cs" company="GSharp">
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

/// Issue #2123 (follow-up to #2118) — a <em>capturing</em> lambda whose body
/// performs a constrained interface call on a value of an enclosing type
/// parameter (`T` constrained to an interface) must emit verifiable IL.
/// Because the lambda captures a variable it is hosted on a synthesized generic
/// <em>display class</em> (its emitted method is
/// `<closure_<lambda…>_N>`K::Invoke`) rather than being
/// promoted to a static generic method (the #2118 path).
///
/// Before the fix the display class's cloned type parameter carried its
/// interface constraint encoded as a <em>method</em> type parameter
/// (`IComparable<!!0>`, MVar) instead of the class's own
/// <em>type</em> parameter (`IComparable<!0>`, Var):
/// (cref:GSharp.Core.CodeAnalysis.Symbols.SynthesizedClosureReifier)'s
/// clone-with-remapped-constraints leaves an imported constructed-generic
/// constraint (`IComparable[T]`) pointing at the original enclosing method
/// type parameter, and its deferred `GenericParamConstraint` row was
/// resolved after the class's outer-TP → own-Var remap was gone. The
/// unsatisfiable constraint made the `constrained.` interface call in the
/// display-class `Invoke` fail verification (`StackUnexpected`).
///
/// The fix eagerly resolves the reified class's generic-parameter constraint
/// handles while its remap is active, so the constraint encodes the class's own
/// `Var` slot. These tests JIT-run the capturing closures end-to-end (a
/// malformed display-class constraint throws `TypeLoadException` at load
/// time, and an unverifiable body throws at invoke time) and assert the
/// structural shape of the reified display class.
open class Issue2123ConstrainedCallCapturingClosureEmitTests {
    @Fact
    func CapturingLambda_MethodTypeParam_ConstrainedInterfaceCall_Int_Executes() {
        // Minimal repro: the lambda captures `seed`, so it is hosted on a
        // generic display class `<closure_<lambda1>_1>`1`. `x.CompareTo(seed)`
        // is a `constrained. !0 callvirt IComparable`1<!0>::CompareTo` in that
        // Invoke — which only verifies when the class type parameter's
        // constraint is encoded as `IComparable<!0>` (Var), not `<!!0>` (MVar).
        const Source = `package P
import System

func Build[T IComparable[T]](seed T) (T) -> int32 {
    let f (T) -> int32 = (x T) -> x.CompareTo(seed)
    return f
}

func RunGreater() int32 {
    let g = Build[int32](5)
    return g(8)
}

func RunLess() int32 {
    let g = Build[int32](5)
    return g(2)
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "CapturingLambda_MethodTypeParam_ConstrainedInterfaceCall_Int_Executes"
        )
        try {
            Assert.True(int32(GetProgramMethod(asm, "RunGreater").Invoke(nil, nil)!!) > 0)
            Assert.True(int32(GetProgramMethod(asm, "RunLess").Invoke(nil, nil)!!) < 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func CapturingLambda_MethodTypeParam_ConstrainedInterfaceCall_String_Executes() {
        // Generalization: the same capturing shape over System.String (also
        // IComparable[String]) must work too.
        const Source = `package P
import System

func Build[T IComparable[T]](seed T) (T) -> int32 {
    let f (T) -> int32 = (x T) -> x.CompareTo(seed)
    return f
}

func Run() int32 {
    let g = Build[string]("mango")
    return g("apple")
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "CapturingLambda_MethodTypeParam_ConstrainedInterfaceCall_String_Executes"
        )
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) < 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func CapturingLambda_ClassTypeParam_ConstrainedInterfaceCall_Executes() {
        // The enclosing parameter is a *class* type parameter and the lambda
        // captures a `T`-typed field value. Both the display class's own type
        // parameter constraint and the `constrained.` call must be sound.
        const Source = `package P
import System

open class C[T IComparable[T]] {
    func Make(seed T) (T) -> int32 {
        let f (T) -> int32 = (x T) -> x.CompareTo(seed)
        return f
    }
}

func Run() int32 {
    let c = C[int32]()
    let g = c.Make(5)
    return g(8)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "CapturingLambda_ClassTypeParam_ConstrainedInterfaceCall_Executes")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) > 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func CapturingLambda_UserInterfaceMethod_ConstrainedCall_Executes() {
        // Generalization to ANY interface method (not only IComparable.CompareTo)
        // and a user-declared G# interface, with the receiver being the lambda
        // parameter and the captured value supplying the argument.
        const Source = `package P

interface IWeigh {
    func Weigh(other int32) int32;
}

class Scale : IWeigh {
    func Weigh(other int32) int32 -> other + 1
}

func Build[T IWeigh](bias int32) (T) -> int32 {
    let f (T) -> int32 = (x T) -> x.Weigh(bias)
    return f
}

func Run() int32 {
    let g = Build[Scale](41)
    return g(Scale())
}
`
        let (asm, ctx) = CompileToAssembly(Source, "CapturingLambda_UserInterfaceMethod_ConstrainedCall_Executes")
        try {
            Assert.Equal(42, GetProgramMethod(asm, "Run").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func CapturingTwoTypeParamSelector_ConstrainedCallOnCapturedDelegateResult_Executes() {
        // The two-type-parameter shape of the Oahu.Decrypt failure
        // (`<closure_<lambda1>_11>`2::Invoke`): a two-type-parameter closure
        // that captures a delegate (`keySelector`) and performs a constrained
        // interface call on the RESULT of invoking that captured delegate
        // (`keySelector(x).CompareTo(...)`, TKey constrained to IComparable). The
        // display class must be generic over both enclosing type parameters and
        // encode TKey's constraint as its own Var slot.
        //
        // NOTE: the production Oahu shape wraps this in
        // `Comparer[TSource].Create(...)`; that exact form is verified
        // out-of-process (gsc + ilverify) because binding `Comparer[TSource]`'s
        // symbolic return depends on the SDK-supplied reference set, which the
        // in-process host-runtime harness does not reproduce (a pre-existing
        // limitation unrelated to this fix and independent of capture). The
        // captured-delegate-result call below exercises the same closure
        // display-class constrained-call code path end-to-end.
        const Source = `package P
import System

func Compare2[TSource, TKey IComparable[TKey]](a TSource, b TSource, keySelector (TSource) -> TKey) int32 {
    let f (TSource, TSource) -> int32 = (x TSource, y TSource) -> keySelector(x).CompareTo(keySelector(y))
    return f(a, b)
}

func Run() int32 -> Compare2[string, int32]("abc", "de", (s string) -> s.Length)
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "CapturingTwoTypeParamSelector_ConstrainedCallOnCapturedDelegateResult_Executes"
        )
        try {
            // "abc".Length (3) vs "de".Length (2) => positive.
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) > 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func NonCapturingLambda_ConstrainedCall_Executes_NoRegression() {
        // Control: the #2118 non-capturing path (lambda promoted to a static
        // generic method, captures nothing) must keep working.
        const Source = `package P
import System

func Build[T IComparable[T]]() (T, T) -> int32 -> ((x T, y T) -> x.CompareTo(y))

func Run() int32 {
    let g = Build[int32]()
    return g(3, 7)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "NonCapturingLambda_ConstrainedCall_Executes_NoRegression")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) < 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func CapturingLambda_ConcreteInterfaceReceiver_Executes_NoRegression() {
        // Control: a capturing lambda whose receiver is a *concrete* interface
        // type legitimately does NOT use a `constrained.` prefix; capturing a
        // value must not change that.
        const Source = `package P
import System

func Build(bias int32) (IComparable[int32]) -> int32 {
    let f (IComparable[int32]) -> int32 = (x IComparable[int32]) -> x.CompareTo(bias)
    return f
}

func Run() int32 {
    let g = Build(0)
    return g(5)
}
`
        let (asm, ctx) = CompileToAssembly(Source, "CapturingLambda_ConcreteInterfaceReceiver_Executes_NoRegression")
        try {
            Assert.True(int32(GetProgramMethod(asm, "Run").Invoke(nil, nil)!!) > 0)
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DisplayClass_TypeParameter_CarriesConstraint_EncodedAsTypeParameterNotMethod() {
        // Structural assertion of the fix: the synthesized display class is a
        // generic type whose (cloned) type parameter carries the IComparable
        // constraint, and that constraint's argument is the class's OWN type
        // parameter (a TYPE generic parameter, Var) rather than a method type
        // parameter (MVar) — the exact encoding error that made the pre-fix
        // display-class constraint unsatisfiable.
        const Source = `package P
import System

func Build[T IComparable[T]](seed T) (T) -> int32 {
    let f (T) -> int32 = (x T) -> x.CompareTo(seed)
    return f
}
`
        let (asm, ctx) = CompileToAssembly(
            Source,
            "DisplayClass_TypeParameter_CarriesConstraint_EncodedAsTypeParameterNotMethod"
        )
        try {
            let displayClass = asm.GetTypes().First(
                (t Type) -> t.Name.Contains("closure", StringComparison.Ordinal) && t.IsGenericTypeDefinition
            )
            let typeParam = Assert.Single(displayClass.GetGenericArguments())
            let constraint = Assert.Single(typeParam.GetGenericParameterConstraints())
            Assert.Equal(typeof(IComparable[_]).Name, constraint.Name)
            let constraintArg = Assert.Single(constraint.GetGenericArguments())
            Assert.True(constraintArg.IsGenericParameter, "constraint argument should be a generic parameter")
            // A TYPE generic parameter (Var) has no DeclaringMethod; a METHOD
            // generic parameter (MVar) does. The fix guarantees the former.
            Assert.Null(constraintArg.DeclaringMethod)
            Assert.Same(displayClass, constraintArg.DeclaringType)
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
