// <copyright file="Issue2037StateMachineMlcProjectionEmitTests.cs" company="GSharp">
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
/// Follow-up regression test for issue #2037 (review follow-up of #2032 /
/// #1958): <see cref="Emit.StateMachineEmitter"/>'s two
/// <c>StructSymbol.Construct</c> call sites (the <c>GetEnumerator</c>/kickoff
/// literal target and the async kickoff literal target) built the CONSTRUCTED
/// state-machine struct without threading a <c>mapClrType</c> projector, so a
/// hoisted parameter field typed as an imported constructed generic over the
/// enclosing async method's OWN type parameter (e.g. <c>IReadOnlyList[T]</c>
/// for an <c>async func Foo[T](items IReadOnlyList[T])</c>) would hit the
/// #1958 <c>MakeGenericType</c> cross-reflection-context
/// (<see cref="System.Reflection.MetadataLoadContext"/> / cs2gs) erasure
/// fallback instead of correctly substituting the type argument.
/// </summary>
public class Issue2037StateMachineMlcProjectionEmitTests
{
    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the full shared-
    /// framework assembly set, forcing gsc into the
    /// <see cref="System.Reflection.MetadataLoadContext"/> resolution path —
    /// the same path the cs2gs migration pipeline and the MSBuild task drive
    /// gsc through via <c>/reference:</c> — reproducing the cross-reflection-
    /// context scenario inside the unit-test process. Mirrors
    /// <c>Issue1919AsyncLambdaMlcEmitTests.MetadataLoadContextResolver</c>.
    /// </summary>
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var runtimeDir = System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory();
        var paths = Directory.GetFiles(runtimeDir, "*.dll");
        return ReferenceResolver.WithReferences(paths);
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

    // Repro shape from the issue: a generic ASYNC function whose parameter
    // is typed as the imported constructed generic CLR interface
    // `IReadOnlyList[T]`, parameterized by the function's OWN type parameter
    // `T`. The parameter is read only after an `await`, so the async
    // state-machine rewriter must hoist it into a state-machine field typed
    // `IReadOnlyList[T]`. Calling it with a `List[int32]` argument closes
    // `T` over `int32`, forcing `StateMachineEmitter` to construct the
    // state-machine struct via `StructSymbol.Construct(smClass, [int32])` —
    // substituting the hoisted field's imported generic type argument.
    private const string Source = """
        package Corpus.Issue2037

        import System
        import System.Collections.Generic
        import System.Threading.Tasks

        func RepeatCount[T](items IReadOnlyList[T]) IEnumerable[int32] {
            yield items.Count
            yield items.Count
        }

        var numbers = List[int32]{ 1, 2, 3, 4, 5, 6, 7 }
        var total = 0
        for value in RepeatCount(numbers) {
            total = total + value
        }
        Console.WriteLine("Count=$total")
        """;

    [Fact]
    public void GenericIterator_HoistsImportedGenericParameter_CompilesAndRunsUnderMetadataLoadContext()
    {
        // Before the fix: StateMachineEmitter's GetEnumerator/kickoff
        // Construct call site dropped mapClrType, so building the
        // constructed iterator state-machine type over the caller's closed
        // type argument (`int32`) risked the #1958 MakeGenericType
        // cross-reflection-context erasure for the hoisted `items` field
        // (typed `IReadOnlyList[T]`) under MLC. This end-to-end smoke test
        // exercises the exact call site (a generic iterator function whose
        // parameter is an imported constructed generic over its own type
        // parameter, read across a `yield` boundary so it is hoisted).
        var output = CompileAndRun("Issue2037StateMachine", MetadataLoadContextResolver(), Source);
        Assert.Contains("Count=14", output);
    }

    [Fact]
    public void GenericIterator_HoistsImportedGenericParameter_ControlCase_DefaultResolver()
    {
        // Control case: the identical source must already succeed under the
        // default (non-MLC, single reflection context) resolver, confirming
        // the fix does not regress the common host-mode compile path.
        var output = CompileAndRun("Issue2037StateMachineDefault", ReferenceResolver.Default(), Source);
        Assert.Contains("Count=14", output);
    }

    /// <summary>
    /// Build a <see cref="ReferenceResolver"/> rooted at the BCL reference
    /// assemblies (narrower than <see cref="MetadataLoadContextResolver"/>),
    /// mirroring the symbol-layer harness in
    /// <c>Issue1958StructMemberGenericSubstitutionTests</c>.
    /// </summary>
    private static ReferenceResolver NarrowMetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    /// <summary>
    /// Builds a <see cref="StructSymbol"/> shaped like the synthesized
    /// state-machine struct <see cref="Emit.StateMachineEmitter"/> passes to
    /// <c>StructSymbol.Construct</c> at its kickoff/<c>GetEnumerator</c> call
    /// sites: a single class-level type parameter (mirroring the enclosing
    /// method's own hoisted type parameter, e.g. <c>T</c>) and a single
    /// hoisted field typed as an imported constructed generic
    /// (<c>IReadOnlyList[T]</c>) parameterized by that class-level parameter
    /// — the exact shape a hoisted generic-typed parameter/local produces.
    /// </summary>
    private static (StructSymbol Definition, TypeParameterSymbol Tp) BuildStateMachineLikeStruct(ReferenceResolver resolver)
    {
        var openListDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IReadOnlyList<>));
        var mlcObject = resolver.MapClrTypeToReferences(typeof(object));

        var tp = new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None);
        var hoistedFieldType = ImportedTypeSymbol.GetConstructed(
            openListDef.MakeGenericType(mlcObject),
            openListDef,
            System.Collections.Immutable.ImmutableArray.Create<TypeSymbol>(tp));

        var fields = System.Collections.Immutable.ImmutableArray.Create(
            new FieldSymbol("items", hoistedFieldType, Accessibility.Public));
        var definition = new StructSymbol("<Repeat>d__0", fields, Accessibility.Public, declaration: null, packageName: "Corpus.Issue2037");
        definition.SetTypeParameters(System.Collections.Immutable.ImmutableArray.Create(tp));

        return (definition, tp);
    }

    [Fact]
    public void StateMachineShapedStruct_Construct_WithMapClrType_ProjectsHoistedFieldAcrossReflectionContexts()
    {
        // Directly exercises the mechanism StateMachineEmitter's fixed
        // Construct call sites now rely on
        // (`this.emitCtx.References.MapClrTypeToReferences`): closing the
        // state-machine-shaped struct's own type parameter over `int32` must
        // substitute the hoisted `items` field's imported generic type
        // argument too, not just the struct's own type-argument list.
        var resolver = NarrowMetadataLoadContextResolver();
        var (definition, _) = BuildStateMachineLikeStruct(resolver);

        var constructed = StructSymbol.Construct(
            definition,
            System.Collections.Immutable.ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32),
            resolver.MapClrTypeToReferences);

        var substitutedFieldType = Assert.IsType<ImportedTypeSymbol>(constructed.Fields[0].Type);
        Assert.Same(TypeSymbol.Int32, Assert.Single(substitutedFieldType.TypeArguments));
    }

    [Fact]
    public void StateMachineShapedStruct_Construct_WithoutMapClrType_ErasesHoistedFieldUnderMetadataLoadContext()
    {
        // Control case proving the pre-#2037 failure mode: the (still
        // present, for same-compilation-only callers) `mapClrType: null`
        // default degrades gracefully via the #1958 catch/Debug.WriteLine
        // fallback rather than throwing, but silently leaves the hoisted
        // field's type argument un-substituted (`IReadOnlyList[T]` instead of
        // `IReadOnlyList[int32]`) — the exact regression #2037 closes for
        // StateMachineEmitter's two call sites by threading
        // `this.emitCtx.References.MapClrTypeToReferences` instead of `null`.
        var resolver = NarrowMetadataLoadContextResolver();
        var (definition, tp) = BuildStateMachineLikeStruct(resolver);

        var constructed = StructSymbol.Construct(
            definition,
            System.Collections.Immutable.ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        var unsubstitutedFieldType = Assert.IsType<ImportedTypeSymbol>(constructed.Fields[0].Type);
        Assert.Same(tp, Assert.Single(unsubstitutedFieldType.TypeArguments));
    }
}

