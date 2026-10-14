// <copyright file="Issue2037StateMachineMlcProjectionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import System.Runtime.Loader
import Xunit

/// Follow-up regression test for issue #2037 (review follow-up of #2032 /
/// #1958): (cref:Emit.StateMachineEmitter)'s two
/// `StructSymbol.Construct` call sites (the `GetEnumerator`/kickoff
/// literal target and the async kickoff literal target) built the CONSTRUCTED
/// state-machine struct without threading a `mapClrType` projector, so a
/// hoisted parameter field typed as an imported constructed generic over the
/// enclosing async method's OWN type parameter (e.g. `IReadOnlyList[T]`
/// for an `async func Foo[T](items IReadOnlyList[T])`) would hit the
/// #1958 `MakeGenericType` cross-reflection-context
/// ((cref:System.Reflection.MetadataLoadContext) / cs2gs) erasure
/// fallback instead of correctly substituting the type argument.
open class Issue2037StateMachineMlcProjectionEmitTests {
    @Fact
    func GenericIterator_HoistsImportedGenericParameter_CompilesAndRunsUnderMetadataLoadContext() {
        // Before the fix: StateMachineEmitter's GetEnumerator/kickoff
        // Construct call site dropped mapClrType, so building the
        // constructed iterator state-machine type over the caller's closed
        // type argument (`int32`) risked the #1958 MakeGenericType
        // cross-reflection-context erasure for the hoisted `items` field
        // (typed `IReadOnlyList[T]`) under MLC. This end-to-end smoke test
        // exercises the exact call site (a generic iterator function whose
        // parameter is an imported constructed generic over its own type
        // parameter, read across a `yield` boundary so it is hoisted).
        let output = CompileAndRun("Issue2037StateMachine", MetadataLoadContextResolver(), Source)
        Assert.Contains("Count=14", output)
    }

    @Fact
    func GenericIterator_HoistsImportedGenericParameter_ControlCase_DefaultResolver() {
        // Control case: the identical source must already succeed under the
        // default (non-MLC, single reflection context) resolver, confirming
        // the fix does not regress the common host-mode compile path.
        let output = CompileAndRun("Issue2037StateMachineDefault", ReferenceResolver.Default(), Source)
        Assert.Contains("Count=14", output)
    }

    @Fact
    func StateMachineShapedStruct_Construct_WithMapClrType_ProjectsHoistedFieldAcrossReflectionContexts() {
        // Directly exercises the mechanism StateMachineEmitter's fixed
        // Construct call sites now rely on
        // (`this.emitCtx.References.MapClrTypeToReferences`): closing the
        // state-machine-shaped struct's own type parameter over `int32` must
        // substitute the hoisted `items` field's imported generic type
        // argument too, not just the struct's own type-argument list.
        let resolver = NarrowMetadataLoadContextResolver()
        let (definition, _) = BuildStateMachineLikeStruct(resolver)
        let constructed = StructSymbol.Construct(
            definition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32),
            resolver.MapClrTypeToReferences
        )
        let substitutedFieldType = Assert.IsType[ImportedTypeSymbol](constructed.Fields[0].Type)
        Assert.Same(TypeSymbol.Int32, Assert.Single(substitutedFieldType.TypeArguments))
    }

    @Fact
    func StateMachineShapedStruct_Construct_WithoutMapClrType_ErasesHoistedFieldUnderMetadataLoadContext() {
        // Control case proving the pre-#2037 failure mode: the (still
        // present, for same-compilation-only callers) `mapClrType: null`
        // default degrades gracefully via the #1958 catch/Debug.WriteLine
        // fallback rather than throwing, but silently leaves the hoisted
        // field's type argument un-substituted (`IReadOnlyList[T]` instead of
        // `IReadOnlyList[int32]`) — the exact regression #2037 closes for
        // StateMachineEmitter's two call sites by threading
        // `this.emitCtx.References.MapClrTypeToReferences` instead of `null`.
        let resolver = NarrowMetadataLoadContextResolver()
        let (definition, tp) = BuildStateMachineLikeStruct(resolver)
        let constructed = StructSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let unsubstitutedFieldType = Assert.IsType[ImportedTypeSymbol](constructed.Fields[0].Type)
        Assert.Same(tp, Assert.Single(unsubstitutedFieldType.TypeArguments))
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at the full shared-
        /// framework assembly set, forcing gsc into the
        /// (cref:System.Reflection.MetadataLoadContext) resolution path —
        /// the same path the cs2gs migration pipeline and the MSBuild task drive
        /// gsc through via `/reference:` — reproducing the cross-reflection-
        /// context scenario inside the unit-test process. Mirrors
        /// `Issue1919AsyncLambdaMlcEmitTests.MetadataLoadContextResolver`.
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

        // Repro shape from the issue: a generic ASYNC function whose parameter
        // is typed as the imported constructed generic CLR interface
        // `IReadOnlyList[T]`, parameterized by the function's OWN type parameter
        // `T`. The parameter is read only after an `await`, so the async
        // state-machine rewriter must hoist it into a state-machine field typed
        // `IReadOnlyList[T]`. Calling it with a `List[int32]` argument closes
        // `T` over `int32`, forcing `StateMachineEmitter` to construct the
        // state-machine struct via `StructSymbol.Construct(smClass, [int32])` —
        // substituting the hoisted field's imported generic type argument.
        private const Source string = `package Corpus.Issue2037

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
Console.WriteLine("Count=$total")`

        /// Build a (cref:ReferenceResolver) rooted at the BCL reference
        /// assemblies (narrower than (cref:MetadataLoadContextResolver)),
        /// mirroring the symbol-layer harness in
        /// `Issue1958StructMemberGenericSubstitutionTests`.
        private func NarrowMetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        /// Builds a (cref:StructSymbol) shaped like the synthesized
        /// state-machine struct (cref:Emit.StateMachineEmitter) passes to
        /// `StructSymbol.Construct` at its kickoff/`GetEnumerator` call
        /// sites: a single class-level type parameter (mirroring the enclosing
        /// method's own hoisted type parameter, e.g. `T`) and a single
        /// hoisted field typed as an imported constructed generic
        /// (`IReadOnlyList[T]`) parameterized by that class-level parameter
        /// — the exact shape a hoisted generic-typed parameter/local produces.
        private func BuildStateMachineLikeStruct(resolver ReferenceResolver)(
            Definition StructSymbol,
            Tp TypeParameterSymbol
        ) {
            let openListDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IReadOnlyList[_]))
            let mlcObject = resolver.MapClrTypeToReferences(typeof(object))
            let tp = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
            let hoistedFieldType = ImportedTypeSymbol.GetConstructed(
                openListDef.MakeGenericType(mlcObject),
                openListDef,
                ImmutableArray.Create[TypeSymbol](tp)
            )
            let fields = ImmutableArray.Create(FieldSymbol("items", hoistedFieldType, Accessibility.Public))
            let definition = StructSymbol(
                "<Repeat>d__0",
                fields,
                Accessibility.Public,
                declaration: nil,
                packageName: "Corpus.Issue2037"
            )
            definition.SetTypeParameters(ImmutableArray.Create(tp))
            return (definition, tp)
        }
    }
}
