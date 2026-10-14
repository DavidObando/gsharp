// <copyright file="Issue2119DeconstructGenericErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import System.Runtime.Loader
import Xunit

/// Regression test for issue #2119: a tuple deconstruction whose source tuple
/// has an element typed as a CONSTRUCTED generic over an in-scope type
/// parameter (e.g. `IEnumerator[T]`) erased the type argument to
/// `object`. The synthetic `ValueTuple` temp emitted for
/// `let (a, b) = (i, ei)` was built from
/// (cref:TypeSymbol.ClrType), but a constructed generic over a type
/// parameter carries a NON-null but type-erased CLR type
/// (`IEnumerator<object>`), so the tuple local/field became
/// `ValueTuple<int32, IEnumerator<object>>` while the value on
/// the stack was `IEnumerator<!T>` — ilverify
/// `StackUnexpected [found IEnumerator`1<T0>][expected
/// IEnumerator`1<object>]`. The fix nulls
/// `TupleTypeSymbol.ClrType` whenever any element structurally contains a
/// type parameter, routing emit through the symbolic TypeSpec path
/// (`GetTupleTypeSpec` -> `EncodeTypeSymbol`) which preserves the
/// real `G<T>` shape. Distinct from the constrained-call bug #2118
/// and the `default(T?)` bug #2117.
open class Issue2119DeconstructGenericErasureEmitTests {
    @Fact
    func Deconstruct_ConstructedGenericOverTypeParam_JitRunsConcreteInstantiation() {
        // Before the fix, this assembly failed ilverify and the JIT rejected
        // the body (StackUnexpected: IEnumerator`1<T0> vs IEnumerator`1<object>
        // on the ValueTuple ctor/ldfld). A successful JIT run proves the
        // emitted tuple local/field preserves the constructed `IEnumerator<T>`.
        let output = CompileAndRun("Issue2119Deconstruct", MetadataLoadContextResolver(), Source)
        Assert.Contains("Current=10", output)
    }

    @Fact
    func Deconstruct_ConstructedGenericOverTypeParam_ControlCase_DefaultResolver() {
        let output = CompileAndRun("Issue2119DeconstructDefault", ReferenceResolver.Default(), Source)
        Assert.Contains("Current=10", output)
    }

    @Fact
    func Deconstruct_TupleLocal_PreservesTypeArgument_NotErasedToObject() {
        // Reflect the emitted `Holder`1::Pick` body: the synthetic ValueTuple
        // deconstruction local's `IEnumerator<...>` element MUST be the class
        // type parameter `T` (an open generic parameter), NOT the erased
        // `System.Object` that the pre-fix closed CLR tuple produced.
        let asm = CompileToAssembly("Issue2119Shape", MetadataLoadContextResolver(), Source)
        let holder = asm.GetTypes().Single((t Type) -> t.Name == "Holder`1")
        let pick MethodInfo? = holder.GetMethod(
            "Pick",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        )
        Assert.NotNull(pick)
        let body MethodBody? = pick!!.GetMethodBody()
        Assert.NotNull(body)
        let tupleLocals = body!!
            .LocalVariables
            .Select((l LocalVariableInfo) -> l.LocalType)
            .Where(
            (t Type) -> t.IsGenericType &&
                t
                .GetGenericTypeDefinition()
                .Name
                .StartsWith("ValueTuple", StringComparison.Ordinal)
        )
            .ToList()
        Assert.NotEmpty(tupleLocals)
        for tuple in tupleLocals {
            let args = tuple.GetGenericArguments()
            let enumeratorArg Type? = args.FirstOrDefault(
                (a Type) -> a.IsGenericType &&
                    a
                    .GetGenericTypeDefinition()
                    .Name
                    .StartsWith("IEnumerator", StringComparison.Ordinal)
            )
            Assert.NotNull(enumeratorArg)
            let innerArg = enumeratorArg!!.GetGenericArguments().Single()
            Assert.True(
                innerArg.IsGenericParameter,
                "IEnumerator element type argument must be the open type parameter T, not the erased '${innerArg.FullName}'."
            )
            Assert.NotEqual(typeof(object).FullName, innerArg.FullName)
        }
    }

    @Fact
    func Deconstruct_ConcreteAndObjectAndOtherGenericElements_StillVerifiableAndRun() {
        // The fix must not regress deconstruction of concrete-typed tuples,
        // value-type elements, genuinely `object`-typed elements, or other
        // generics over the type parameter (`List[T]`, user `Box[T]`).
        let output = CompileAndRun("Issue2119Control", MetadataLoadContextResolver(), ControlSource)
        Assert.Contains("ok", output)
    }

    @Fact
    func Deconstruct_GenuineObjectElement_StaysObject_NotAccidentallySymbolic() {
        // A tuple whose element is a genuine `object` value must keep its
        // closed CLR `ValueTuple<int32, object>` shape; the fix only nulls the
        // ClrType when an element structurally contains a type parameter.
        let asm = CompileToAssembly("Issue2119ObjectShape", MetadataLoadContextResolver(), ControlSource)
        let controls = asm.GetTypes().Single((t Type) -> t.Name == "Controls`1")
        let genuine MethodInfo? = controls.GetMethod(
            "GenuineObject",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
        )
        Assert.NotNull(genuine)
        let body MethodBody? = genuine!!.GetMethodBody()
        Assert.NotNull(body)
        let tuple = body!!
            .LocalVariables
            .Select((l LocalVariableInfo) -> l.LocalType)
            .Single(
            (t Type) -> t.IsGenericType &&
                t
                .GetGenericTypeDefinition()
                .Name
                .StartsWith("ValueTuple", StringComparison.Ordinal)
        )
        let objectArg = tuple.GetGenericArguments().Last()
        Assert.Equal(typeof(object).FullName, objectArg.FullName)
        Assert.False(objectArg.IsGenericParameter)
    }

    shared {
        // Reduced repro shape from the real Oahu.Decrypt InterleavedIterator<T>:
        // deconstruct a `(int32, IEnumerator[T])` tuple bound over the class's own
        // type parameter, then hand the constructed-generic element back out. The
        // driver closes `T = int32` and JIT-runs it end-to-end.
        private const Source string = `package Corpus.Issue2119

import System
import System.Collections.Generic

class Holder[T] {
    func Pick(a IEnumerator[T], b IEnumerator[T]) IEnumerator[T] {
        let (idx, chosen) = (1, b)
        return chosen
    }
}

var list = List[int32]{ 10, 20, 30 }
let seq = list as IEnumerable[int32]
let e1 = seq!!.GetEnumerator()
let e2 = seq!!.GetEnumerator()
let h = Holder[int32]()
let picked = h.Pick(e1, e2)
picked.MoveNext()
Console.WriteLine("Current=" + picked.Current.ToString())`

        // Controls: elements that are (a) a genuinely `object`-typed value, (b) a
        // value type, (c) a concrete reference type, and (d) a different generic
        // over the type parameter (`List[T]`) plus a user `data struct Box[T]`.
        // None of these must regress: the `object` element must STAY `object`, and
        // the concrete/value elements keep their closed CLR tuple.
        private const ControlSource string = `package Corpus.Issue2119Control

import System
import System.Collections.Generic

data struct Box[T] {
    var Value T
}

class Controls[T] {
    func GenericList(x List[T]) List[T] {
        let (a, b) = (5, x)
        return b
    }

    func UserBox(x Box[T]) Box[T] {
        let (a, b) = (5, x)
        return b
    }

    func GenuineObject(x object) object {
        let (a, b) = (5, x)
        return b
    }

    func Concrete(x string) string {
        let (a, b) = (5, x)
        return b
    }

    func ValueElem(x int32) int32 {
        let (a, b) = (5, x)
        return b
    }
}

Console.WriteLine("ok")`

        /// Build a (cref:ReferenceResolver) rooted at the full shared-
        /// framework assembly set, forcing gsc into the
        /// (cref:System.Reflection.MetadataLoadContext) resolution path —
        /// the same path the cs2gs migration pipeline drives gsc through via
        /// `/reference:`. Mirrors the sibling emit tests.
        private func MetadataLoadContextResolver() ReferenceResolver {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let paths = Directory.GetFiles(runtimeDir, "*.dll")
            return ReferenceResolver.WithReferences(paths)
        }

        /// Compiles and emits [`source`](paramref) under
        /// [`references`](paramref), loads the resulting PE, invokes its
        /// entry point, and returns captured console output.
        private func CompileAndRun(contextName string, references ReferenceResolver, source string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, tree)
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
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } catch (ex TargetInvocationException) when ex.InnerException is AggregateException agg {
                    throw agg.InnerException ?? agg
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        /// Compiles and emits [`source`](paramref), then loads the resulting
        /// PE for reflection-based IL-shape inspection.
        private func CompileToAssembly(contextName string, references ReferenceResolver, source string) Assembly {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: false)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
