// <copyright file="Issue5157FirstChanceExceptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.ExceptionServices
import Xunit

/// Issue #5157: after #5123 a Core compile still raised first-chance exceptions at sites that
/// used a thrown and caught exception as the answer (a `TypeBuilderInstantiation` bound,
/// a `MetadataLoadContext` method slot, member enumeration over an instantiation, an
/// unresolved transitive reference, a control flow graph over an unflattened body, and
/// `IsByRefLike` over an emit `SymbolType`). Each probe now asks the condition first.
///
/// Every test counts first-chance exceptions on the calling thread across the probe and
/// asserts none were raised, and also asserts the answer the probe gave before the change.
/// The types under test are created per test so no memoized result can hide a thrown
/// exception.
///
/// RED before the change: the probe throws and catches, so the count is not zero.
open class Issue5157FirstChanceExceptionTests : IDisposable {
    private let scratchDir string

    init() {
        scratchDir = Path.Combine(AppContext.BaseDirectory, "gs5157-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(scratchDir)
    }

    func Dispose() {
        try {
            if Directory.Exists(scratchDir) {
                Directory.Delete(scratchDir, recursive: true)
            }
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
        GC.SuppressFinalize(this)
    }

    @Fact
    func SafeEnumerate_TypeBuilderInstantiation_ReturnsEmptyWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        var methods = Array.Empty[MethodInfo]()
        var properties = Array.Empty[PropertyInfo]()
        var fields = Array.Empty[FieldInfo]()
        let all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        let thrown = CountFirstChanceExceptions(
            func () {
                methods = ClrTypeUtilities.SafeGetMethods(instantiation, all)
                properties = ClrTypeUtilities.SafeGetProperties(instantiation, all)
                fields = ClrTypeUtilities.SafeGetFields(instantiation, all)
            }
        )
        Assert.Empty(methods)
        Assert.Empty(properties)
        Assert.Empty(fields)
        Assert.Empty(thrown)
    }

    @Fact
    func SafeGetMember_TypeBuilderInstantiation_ReturnsNullWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        let all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        var property PropertyInfo? = ClrTypeUtilities.SafeGetProperty(typeof(string), "Length", all)
        var field FieldInfo? = ClrTypeUtilities.SafeGetField(typeof(string), "Empty", all)
        let thrown = CountFirstChanceExceptions(
            func () {
                property = ClrTypeUtilities.SafeGetProperty(instantiation, "Count", all)
                field = ClrTypeUtilities.SafeGetField(instantiation, "items", all)
            }
        )
        Assert.Null(property)
        Assert.Null(field)
        Assert.Empty(thrown)
    }

    @Fact
    func IsByRefLike_UnfinishedEmitTypes_ReturnFalseWithoutThrowing() {
        let definition = DefineOpenType()
        let symbolType = definition.MakeArrayType()
        Assert.Equal("SymbolType", symbolType.GetType().Name)
        var onBuilder = true
        var onSymbol = true
        let thrown = CountFirstChanceExceptions(
            func () {
                onBuilder = ClrTypeUtilities.IsByRefLike(definition)
                onSymbol = ClrTypeUtilities.IsByRefLike(symbolType)
            }
        )
        Assert.False(onBuilder)
        Assert.False(onSymbol)
        Assert.Empty(thrown)
    }

    @Fact
    func IsByRefLike_FinishedAndHostTypes_StillAnswerFromTheType() {
        Assert.True(ClrTypeUtilities.IsByRefLike(typeof(Span[int32])))
        Assert.False(ClrTypeUtilities.IsByRefLike(typeof(string)))
        Assert.False(ClrTypeUtilities.IsByRefLike(typeof([]int32)))
    }

    @Fact
    func SameClrMethodSlot_MetadataLoadContextMethods_CompareIdentityWithoutThrowing() {
        let trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator)
            .Where((p string) -> !string.IsNullOrEmpty(p))
            .ToArray()
        let mlc = MetadataLoadContext(PathAssemblyResolver(trusted), coreAssemblyName: "System.Private.CoreLib")
        try {
            let core = mlc.CoreAssembly!!
            let introduced = core.GetType("System.Object", true)!!.GetMethod("ToString", Type.EmptyTypes)!!
            let overridden = core.GetType("System.Int32", true)!!.GetMethod("ToString", Type.EmptyTypes)!!
            // The context cannot expose override chains: the call this probe replaces throws.
            Assert.Throws[NotSupportedException](
                func () {
                    overridden.GetBaseDefinition()
                }
            )
            var same = false
            var different = true
            var host = false
            let thrown = CountFirstChanceExceptions(
                func () {
                    same = ExpressionBinder.SameClrMethodSlot(introduced, introduced)
                    different = ExpressionBinder.SameClrMethodSlot(introduced, overridden)
                    host = ExpressionBinder.SameClrMethodSlot(
                        typeof(int32).GetMethod("ToString", Type.EmptyTypes)!!,
                        typeof(object).GetMethod("ToString", Type.EmptyTypes)!!
                    )
                }
            )
            Assert.True(same)
            Assert.False(different)
            // Host methods still collapse an override onto its base definition.
            Assert.True(host)
            Assert.Empty(thrown)
        } finally {
            mlc.Dispose()
        }
    }

    @Fact
    func TryInferTypeArguments_BoundIsTypeBuilderInstantiation_ComparesByNameWithoutThrowing() {
        let instantiation = BuildTypeBuilderInstantiation()
        let openMethod = typeof(Issue5157Probe).GetMethod("Pair")!!
        var typeArgs[]?Type = nil
        var inferred = false
        let thrown = CountFirstChanceExceptions(
            func () {
                inferred = ClrOverloadResolution.TryInferTypeArguments(
                    openMethod,
                    List[Type?]{instantiation, typeof(object)},
                    out typeArgs
                )
            }
        )
        Assert.Empty(thrown)
        // `object` is the common bound: the instantiation converts to it by reference.
        Assert.True(inferred)
        Assert.Equal(typeof(object), typeArgs!![0])
    }

    @Fact
    func WithReferences_MissingTransitiveDependency_DoesNotRaiseFileNotFound() {
        let libPath = BuildLibraryWithMissingDependency()
        var resolver ReferenceResolver? = nil
        let thrown = CountFirstChanceExceptions(
            func () {
                resolver = ReferenceResolver.WithReferences([]string{libPath})
            }
        )
        Assert.Contains("DepAsmB", resolver!!.MissingTransitiveReferences)
        Assert.Empty(thrown)
    }

    @Fact
    func ControlFlowGraphCanCreate_NestedBlock_IsFalse_AndFlatBodyIsTrue() {
        let flat = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](
                BoundExpressionStatement(nil, BoundLiteralExpression(nil, 1)),
                BoundLabelStatement(nil, BoundLabel("L"))
            )
        )
        let nested = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](flat))
        Assert.True(ControlFlowGraph.CanCreate(flat))
        Assert.False(ControlFlowGraph.CanCreate(nested))
        // The graph builder rejects the nested form: `CanCreate` mirrors that.
        Assert.ThrowsAny[Exception](
            func () {
                ControlFlowGraph.Create(nested)
            }
        )
    }

    @Fact
    func DefiniteAssignment_UnflattenedBody_TakesFailSafePathWithoutThrowing() {
        let flat = BoundBlockStatement(
            nil,
            ImmutableArray.Create[BoundStatement](BoundExpressionStatement(nil, BoundLiteralExpression(nil, 1)))
        )
        let nested = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](flat))
        let outParameter = ParameterSymbol("result", TypeSymbol.Int32, refKind: RefKind.Out)
        let function = FunctionSymbol("F", ImmutableArray.Create(outParameter), TypeSymbol.Void)
        let diagnostics = DiagnosticBag()
        let thrown = CountFirstChanceExceptions(
            func () {
                DefiniteAssignmentAnalyzer.Analyze(nested, function, diagnostics)
            }
        )
        Assert.Empty(thrown)
        // The fail-safe path reports the out parameter as unassigned, as the catch always did.
        Assert.Single(diagnostics.ToList())
    }

    /// Synthesizes `LibAsmA`, whose `Lib.Widget.M` takes a `Dep.Marker` from `DepAsmB`, and
    /// returns only the `LibAsmA` path so the dependency is a missing transitive reference.
    private func BuildLibraryWithMissingDependency() string {
        let coreAssembly = typeof(object).Assembly
        let depName = AssemblyName("DepAsmB"){Version = Version(1, 0, 0, 0)}
        let depBuilder = PersistedAssemblyBuilder(depName, coreAssembly)
        let depModule = depBuilder.DefineDynamicModule("DepAsmB")
        let marker = depModule.DefineType("Dep.Marker", TypeAttributes.Public | TypeAttributes.Class)
        marker.CreateType()
        depBuilder.Save(Path.Combine(scratchDir, "DepAsmB.dll"))
        let libName = AssemblyName("LibAsmA"){Version = Version(1, 0, 0, 0)}
        let libBuilder = PersistedAssemblyBuilder(libName, coreAssembly)
        let libModule = libBuilder.DefineDynamicModule("LibAsmA")
        let widget = libModule.DefineType("Lib.Widget", TypeAttributes.Public | TypeAttributes.Class)
        let method = widget.DefineMethod(
            "M",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(Void),
            cast[[]Type]([]TypeBuilder{marker})
        )
        method.GetILGenerator().Emit(OpCodes.Ret)
        widget.CreateType()
        let libPath = Path.Combine(scratchDir, "LibAsmA.dll")
        libBuilder.Save(libPath)
        return libPath
    }

    shared {
        /// Runs [`probe`](paramref) and returns the type name of every first-chance
        /// exception raised on the calling thread while it ran.
        private func CountFirstChanceExceptions(probe Action) List[string] {
            let thrown = List[string]()
            let thread = Environment.CurrentManagedThreadId
            let handler = func (sender object?, args FirstChanceExceptionEventArgs) {
                if Environment.CurrentManagedThreadId == thread {
                    thrown.Add(args.Exception.GetType().Name)
                }
            }
            AppDomain.CurrentDomain.FirstChanceException += handler
            try {
                probe()
            } finally {
                AppDomain.CurrentDomain.FirstChanceException -= handler
            }
            return thrown
        }

        private func DefineOpenType() TypeBuilder {
            let assemblyBuilder = AssemblyBuilder.DefineDynamicAssembly(
                AssemblyName("Issue5157DynamicAssembly" + Guid.NewGuid().ToString("N")),
                AssemblyBuilderAccess.Run
            )
            let moduleBuilder = assemblyBuilder.DefineDynamicModule("Issue5157Module")
            return moduleBuilder.DefineType("Bus`1", TypeAttributes.Public | TypeAttributes.Class)
        }

        /// Builds a fresh `Bus<int>` instantiation of a generic type still being defined.
        private func BuildTypeBuilderInstantiation() Type {
            let definition = DefineOpenType()
            definition.DefineGenericParameters("T")
            let instantiation = definition.MakeGenericType(typeof(int32))
            Assert.Equal("TypeBuilderInstantiation", instantiation.GetType().Name)
            return instantiation
        }
    }
}

/// Holder of the generic method the inference test reflects over.
internal class Issue5157Probe {
    shared {
        func Pair[T](first T, second T) T -> first
    }
}
