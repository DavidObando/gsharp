// <copyright file="Issue2119DeconstructGenericErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Regression test for issue #2119: a tuple deconstruction whose source tuple
/// has an element typed as a CONSTRUCTED generic over an in-scope type
/// parameter (e.g. <c>IEnumerator[T]</c>) erased the type argument to
/// <c>object</c>. The synthetic <c>ValueTuple</c> temp emitted for
/// <c>let (a, b) = (i, ei)</c> was built from
/// <see cref="TypeSymbol.ClrType"/>, but a constructed generic over a type
/// parameter carries a NON-null but type-erased CLR type
/// (<c>IEnumerator&lt;object&gt;</c>), so the tuple local/field became
/// <c>ValueTuple&lt;int32, IEnumerator&lt;object&gt;&gt;</c> while the value on
/// the stack was <c>IEnumerator&lt;!T&gt;</c> — ilverify
/// <c>StackUnexpected [found IEnumerator`1&lt;T0&gt;][expected
/// IEnumerator`1&lt;object&gt;]</c>. The fix nulls
/// <c>TupleTypeSymbol.ClrType</c> whenever any element structurally contains a
/// type parameter, routing emit through the symbolic TypeSpec path
/// (<c>GetTupleTypeSpec</c> -&gt; <c>EncodeTypeSymbol</c>) which preserves the
/// real <c>G&lt;T&gt;</c> shape. Distinct from the constrained-call bug #2118
/// and the <c>default(T?)</c> bug #2117.
/// </summary>
public class Issue2119DeconstructGenericErasureEmitTests
{
    // Reduced repro shape from the real Oahu.Decrypt InterleavedIterator<T>:
    // deconstruct a `(int32, IEnumerator[T])` tuple bound over the class's own
    // type parameter, then hand the constructed-generic element back out. The
    // driver closes `T = int32` and JIT-runs it end-to-end.
    private const string Source = """
        package Corpus.Issue2119

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
        Console.WriteLine("Current=" + picked.Current.ToString())
        """;

    // Controls: elements that are (a) a genuinely `object`-typed value, (b) a
    // value type, (c) a concrete reference type, and (d) a different generic
    // over the type parameter (`List[T]`) plus a user `data struct Box[T]`.
    // None of these must regress: the `object` element must STAY `object`, and
    // the concrete/value elements keep their closed CLR tuple.
    private const string ControlSource = """
        package Corpus.Issue2119Control

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

        Console.WriteLine("ok")
        """;

    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the full shared-
    /// framework assembly set, forcing gsc into the
    /// <see cref="System.Reflection.MetadataLoadContext"/> resolution path —
    /// the same path the cs2gs migration pipeline drives gsc through via
    /// <c>/reference:</c>. Mirrors the sibling emit tests.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var paths = Directory.GetFiles(runtimeDir, "*.dll");
        return ReferenceResolver.WithReferences(paths);
    }

    [Fact]
    public void Deconstruct_ConstructedGenericOverTypeParam_JitRunsConcreteInstantiation()
    {
        // Before the fix, this assembly failed ilverify and the JIT rejected
        // the body (StackUnexpected: IEnumerator`1<T0> vs IEnumerator`1<object>
        // on the ValueTuple ctor/ldfld). A successful JIT run proves the
        // emitted tuple local/field preserves the constructed `IEnumerator<T>`.
        var output = CompileAndRun("Issue2119Deconstruct", MetadataLoadContextResolver(), Source);
        Assert.Contains("Current=10", output);
    }

    [Fact]
    public void Deconstruct_ConstructedGenericOverTypeParam_ControlCase_DefaultResolver()
    {
        var output = CompileAndRun("Issue2119DeconstructDefault", ReferenceResolver.Default(), Source);
        Assert.Contains("Current=10", output);
    }

    [Fact]
    public void Deconstruct_TupleLocal_PreservesTypeArgument_NotErasedToObject()
    {
        // Reflect the emitted `Holder`1::Pick` body: the synthetic ValueTuple
        // deconstruction local's `IEnumerator<...>` element MUST be the class
        // type parameter `T` (an open generic parameter), NOT the erased
        // `System.Object` that the pre-fix closed CLR tuple produced.
        var asm = CompileToAssembly("Issue2119Shape", MetadataLoadContextResolver(), Source);
        var holder = asm.GetTypes().Single(t => t.Name == "Holder`1");
        var pick = holder.GetMethod("Pick", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(pick);

        var body = pick!.GetMethodBody();
        Assert.NotNull(body);

        var tupleLocals = body!.LocalVariables
            .Select(l => l.LocalType)
            .Where(t => t.IsGenericType && t.GetGenericTypeDefinition().Name.StartsWith("ValueTuple", StringComparison.Ordinal))
            .ToList();
        Assert.NotEmpty(tupleLocals);

        foreach (var tuple in tupleLocals)
        {
            var args = tuple.GetGenericArguments();
            var enumeratorArg = args.FirstOrDefault(a =>
                a.IsGenericType &&
                a.GetGenericTypeDefinition().Name.StartsWith("IEnumerator", StringComparison.Ordinal));
            Assert.NotNull(enumeratorArg);

            var innerArg = enumeratorArg!.GetGenericArguments().Single();
            Assert.True(
                innerArg.IsGenericParameter,
                $"IEnumerator element type argument must be the open type parameter T, not the erased '{innerArg.FullName}'.");
            Assert.NotEqual(typeof(object).FullName, innerArg.FullName);
        }
    }

    [Fact]
    public void Deconstruct_ConcreteAndObjectAndOtherGenericElements_StillVerifiableAndRun()
    {
        // The fix must not regress deconstruction of concrete-typed tuples,
        // value-type elements, genuinely `object`-typed elements, or other
        // generics over the type parameter (`List[T]`, user `Box[T]`).
        var output = CompileAndRun("Issue2119Control", MetadataLoadContextResolver(), ControlSource);
        Assert.Contains("ok", output);
    }

    [Fact]
    public void Deconstruct_GenuineObjectElement_StaysObject_NotAccidentallySymbolic()
    {
        // A tuple whose element is a genuine `object` value must keep its
        // closed CLR `ValueTuple<int32, object>` shape; the fix only nulls the
        // ClrType when an element structurally contains a type parameter.
        var asm = CompileToAssembly("Issue2119ObjectShape", MetadataLoadContextResolver(), ControlSource);
        var controls = asm.GetTypes().Single(t => t.Name == "Controls`1");
        var genuine = controls.GetMethod("GenuineObject", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(genuine);

        var body = genuine!.GetMethodBody();
        Assert.NotNull(body);

        var tuple = body!.LocalVariables
            .Select(l => l.LocalType)
            .Single(t => t.IsGenericType && t.GetGenericTypeDefinition().Name.StartsWith("ValueTuple", StringComparison.Ordinal));

        var objectArg = tuple.GetGenericArguments().Last();
        Assert.Equal(typeof(object).FullName, objectArg.FullName);
        Assert.False(objectArg.IsGenericParameter);
    }

    /// <summary>
    /// Compiles and emits <paramref name="source"/> under
    /// <paramref name="references"/>, loads the resulting PE, invokes its
    /// entry point, and returns captured console output.
    /// </summary>
    private static string CompileAndRun(string contextName, ReferenceResolver references, string source)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(references, tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            catch (TargetInvocationException ex) when (ex.InnerException is AggregateException agg)
            {
                throw agg.InnerException ?? agg;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// Compiles and emits <paramref name="source"/>, then loads the resulting
    /// PE for reflection-based IL-shape inspection.
    /// </summary>
    private static Assembly CompileToAssembly(string contextName, ReferenceResolver references, string source)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(references, tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: false);
        return loadContext.LoadFromStream(peStream);
    }
}
