// <copyright file="Issue1624SymbolCacheKeyingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Emit
import System.Runtime.InteropServices
import Xunit

/// Issue #1624 regression coverage: (cref:TupleTypeSymbol) and
/// (cref:FunctionPointerTypeSymbol) used to key their process-wide
/// caches by display name alone (or, for tuples, validated identity on
/// lookup but then raced a plain-write replace on mismatch). Two distinct
/// (cref:TypeParameterSymbol) instances that share a name (as happens
/// across separate compilations reusing a letter like `T`) must never
/// alias to the same cached tuple / function-pointer instance.
open class Issue1624SymbolCacheKeyingTests {
    @Fact
    func TupleTypeSymbol_Get_WithDistinctSameNamedElementTypes_NeverAliases() {
        let t1 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let t2 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let tupleA = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](t1, TypeSymbol.String))
        let tupleB = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](t2, TypeSymbol.String))
        let tupleAAgain = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](t1, TypeSymbol.String))
        Assert.NotSame(tupleA, tupleB)
        Assert.Same(tupleA, tupleAAgain)
    }

    @Fact
    func FunctionPointerTypeSymbol_GetUnmanaged_WithDistinctSameNamedParameterTypes_NeverAliases() {
        let t1 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let t2 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let fpA = FunctionPointerTypeSymbol.Get(
            CallingConvention.Cdecl,
            ImmutableArray.Create[TypeSymbol](t1),
            TypeSymbol.Void
        )
        let fpB = FunctionPointerTypeSymbol.Get(
            CallingConvention.Cdecl,
            ImmutableArray.Create[TypeSymbol](t2),
            TypeSymbol.Void
        )
        let fpAAgain = FunctionPointerTypeSymbol.Get(
            CallingConvention.Cdecl,
            ImmutableArray.Create[TypeSymbol](t1),
            TypeSymbol.Void
        )
        Assert.NotSame(fpA, fpB)
        Assert.Same(fpA, fpAAgain)
    }

    @Fact
    func FunctionPointerTypeSymbol_GetManaged_WithDistinctSameNamedParameterTypes_NeverAliases() {
        let t1 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let t2 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let fpA = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](t1), TypeSymbol.Void)
        let fpB = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](t2), TypeSymbol.Void)
        let fpAAgain = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](t1), TypeSymbol.Void)
        Assert.NotSame(fpA, fpB)
        Assert.Same(fpA, fpAAgain)
    }

    @Fact
    func AnyTypeParameter_DescendsThroughPointerAndFunctionPointer() {
        let parameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let pointer = PointerTypeSymbol.Get(parameter)
        let functionPointer = FunctionPointerTypeSymbol.GetManaged(
            ImmutableArray.Create[TypeSymbol](MapTypeSymbol.Get(TypeSymbol.String, pointer)),
            pointer
        )
        Assert.True(
            TypeSymbol.AnyTypeParameter(
                pointer,
                (candidate TypeParameterSymbol) -> object.ReferenceEquals(candidate, parameter)
            )
        )
        Assert.True(
            TypeSymbol.AnyTypeParameter(
                functionPointer,
                (candidate TypeParameterSymbol) -> object.ReferenceEquals(candidate, parameter)
            )
        )
        Assert.True(TypeSymbol.ContainsTypeParameter(functionPointer))
    }

    @Fact
    func StructuralCaches_DistinguishNestedPointerGenericOwners() {
        let t1 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let t2 = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let pointer1 = PointerTypeSymbol.Get(t1)
        let pointer2 = PointerTypeSymbol.Get(t2)
        let function1 = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](pointer1), TypeSymbol.Void)
        let function2 = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](pointer2), TypeSymbol.Void)
        let function1Again = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](pointer1), TypeSymbol.Void)
        let outer1 = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](pointer1), TypeSymbol.Void)
        let outer2 = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](pointer2), TypeSymbol.Void)
        Assert.NotSame(function1, function2)
        Assert.Same(function1, function1Again)
        Assert.NotSame(outer1, outer2)
    }

    @Fact
    func StructuralCaches_DistinguishNestedFunctionPointerAbiAndRefShapes() {
        let valueParameter = ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        let managed = FunctionPointerTypeSymbol.GetManaged(valueParameter, TypeSymbol.Int32)
        let cdecl = FunctionPointerTypeSymbol.Get(CallingConvention.Cdecl, valueParameter, TypeSymbol.Int32)
        let stdcall = FunctionPointerTypeSymbol.Get(CallingConvention.StdCall, valueParameter, TypeSymbol.Int32)
        let byRef = FunctionPointerTypeSymbol.GetManaged(
            ImmutableArray.Create[TypeSymbol](ByRefTypeSymbol.Get(TypeSymbol.Int32)),
            TypeSymbol.Int32
        )
        let stringReturn = FunctionPointerTypeSymbol.GetManaged(valueParameter, TypeSymbol.String)
        let managedContainer = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](managed), TypeSymbol.Void)
        let cdeclContainer = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](cdecl), TypeSymbol.Void)
        let stdcallContainer = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](stdcall), TypeSymbol.Void)
        let byRefContainer = FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](byRef), TypeSymbol.Void)
        let stringReturnContainer = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](stringReturn),
            TypeSymbol.Void
        )
        Assert.NotSame(managedContainer, cdeclContainer)
        Assert.NotSame(cdeclContainer, stdcallContainer)
        Assert.NotSame(managedContainer, byRefContainer)
        Assert.NotSame(managedContainer, stringReturnContainer)
        Assert.NotSame(
            TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](managed, TypeSymbol.String)),
            TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](cdecl, TypeSymbol.String))
        )
        Assert.NotSame(
            FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](managed), TypeSymbol.Void),
            FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create[TypeSymbol](cdecl), TypeSymbol.Void)
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StructuralCaches_DistinguishNestedFixedAndVariadicFunctions(variadicFirst bool) {
        let element = TypeParameterSymbol(
            if variadicFirst {
                "TVariadicFirst"
            } else {
                "TFixedFirst"
            },
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
        let slice = SliceTypeSymbol.Get(element)
        let fixedFunction = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](slice),
            ImmutableArray.Create(false),
            TypeSymbol.Void
        )
        let variadicFunction = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](slice),
            ImmutableArray.Create(true),
            TypeSymbol.Void
        )
        let first TypeSymbol = if variadicFirst {
            variadicFunction
        } else {
            fixedFunction
        }
        let second TypeSymbol = if variadicFirst {
            fixedFunction
        } else {
            variadicFunction
        }
        let firstPointer = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create(first), TypeSymbol.Void)
        let secondPointer = FunctionPointerTypeSymbol.GetManaged(ImmutableArray.Create(second), TypeSymbol.Void)
        let firstTuple = TupleTypeSymbol.Get(ImmutableArray.Create(first, TypeSymbol.String))
        let secondTuple = TupleTypeSymbol.Get(ImmutableArray.Create(second, TypeSymbol.String))
        let firstOuterFunction = FunctionTypeSymbol.Get(ImmutableArray.Create(first), TypeSymbol.Int32)
        let secondOuterFunction = FunctionTypeSymbol.Get(ImmutableArray.Create(second), TypeSymbol.Int32)
        Assert.NotSame(fixedFunction, variadicFunction)
        Assert.NotSame(firstPointer, secondPointer)
        Assert.NotSame(firstTuple, secondTuple)
        Assert.NotSame(firstOuterFunction, secondOuterFunction)
        Assert.Same(first, firstPointer.ParameterTypes[0])
        Assert.Same(second, secondPointer.ParameterTypes[0])
        Assert.False(fixedFunction.IsVariadic[0])
        Assert.True(variadicFunction.IsVariadic[0])
    }

    /// Regression for the fix-up in this same PR: the original #1624 patch
    /// keyed a plain imported CLR reference-type element (one with a
    /// non-null `ClrType`, e.g. a class from a project reference) by
    /// name alone, so two *distinct* same-named CLR types (as happens across
    /// separate compilations, each loading their own copy of a same-named
    /// class) aliased to a single cached (cref:TupleTypeSymbol) —
    /// which broke `Tuple2_OneClrRefType_ReturnsAndDestructures` and
    /// `Tuple_AsParameterType` in Compiler.Tests. This builds two
    /// dynamic assemblies that each define an unrelated "Holder" class (same
    /// simple name, different (cref:System.Type) identity) and
    /// asserts they never alias, while confirming the same CLR type used
    /// twice still interns to one shared instance.
    @Fact
    func TupleTypeSymbol_Get_WithDistinctSameNamedClrRefTypeElements_NeverAliases() {
        let holderA = ImportedTypeSymbol.Get(DefineHolderType("HolderAsm.A"))
        let holderB = ImportedTypeSymbol.Get(DefineHolderType("HolderAsm.B"))
        let tupleA = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](holderA, TypeSymbol.String))
        let tupleB = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](holderB, TypeSymbol.String))
        let tupleAAgain = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](holderA, TypeSymbol.String))
        Assert.NotSame(tupleA, tupleB)
        Assert.Same(tupleA, tupleAAgain)
    }

    /// #1777 follow-up regression: (cref:SliceTypeSymbol) and
    /// (cref:ArrayTypeSymbol) both build their `ClrType` as
    /// `elementType.ClrType.MakeArrayType()` (the fixed length is
    /// symbol-only metadata, absent from the CLR shape), so
    /// `[]int32`, `[3]int32`, and `[5]int32` all share the
    /// identical `typeof(int[])` instance. Neither carries a type
    /// parameter or same-compilation user type, so the ClrType-identity
    /// fallback introduced by #1777 would alias all three as tuple
    /// elements -- the same failure mode as #1624.
    @Fact
    func TupleTypeSymbol_Get_WithSliceVsFixedArrayElements_NeverAliases() {
        let slice = SliceTypeSymbol.Get(TypeSymbol.Int32)
        let array3 = ArrayTypeSymbol.Get(TypeSymbol.Int32, 3)
        let array5 = ArrayTypeSymbol.Get(TypeSymbol.Int32, 5)
        let array3Again = ArrayTypeSymbol.Get(TypeSymbol.Int32, 3)
        let tupleSlice = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](slice, TypeSymbol.String))
        let tupleArray3 = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](array3, TypeSymbol.String))
        let tupleArray5 = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](array5, TypeSymbol.String))
        let tupleArray3Again = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](array3Again, TypeSymbol.String))
        Assert.NotSame(tupleSlice, tupleArray3)
        Assert.NotSame(tupleArray3, tupleArray5)
        Assert.NotSame(tupleSlice, tupleArray5)
        // Positive interning check: the same shape used twice still resolves
        // to the same cached symbol -- the fix must not over-fragment.
        Assert.Same(tupleArray3, tupleArray3Again)
    }

    /// #1777 follow-up regression: (cref:PinnedTypeSymbol) copies its
    /// underlying type's `ClrType` verbatim, so a pinned wrapper and its
    /// bare underlying type would alias as tuple elements under the
    /// ClrType-identity fallback.
    @Fact
    func TupleTypeSymbol_Get_WithPinnedVsUnpinnedUnderlying_NeverAliases() {
        let pinned = PinnedTypeSymbol(TypeSymbol.String)
        let tuplePinned = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](pinned, TypeSymbol.Int32))
        let tupleBare = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.String, TypeSymbol.Int32))
        Assert.NotSame(tuplePinned, tupleBare)
    }

    /// #1777 follow-up regression: (cref:NullabilityAnnotatedTypeSymbol)
    /// inherits both `Name` and `ClrType` from its `BaseType`
    /// unchanged, so an annotated element (e.g. carrying a nullable inner
    /// generic argument byte) would alias its bare base type as a tuple
    /// element -- and two annotated wrappers of the same base with different
    /// nullability flags (key vs. value nullable) would alias each other too.
    @Fact
    func TupleTypeSymbol_Get_WithNullabilityAnnotatedVsBareElements_NeverAliases() {
        let annotatedA = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.String,
            ImmutableArray.Create[uint8](uint8(1), uint8(2))
        )
        let annotatedB = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.String,
            ImmutableArray.Create[uint8](uint8(1), uint8(1))
        )
        let annotatedAAgain = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.String,
            ImmutableArray.Create[uint8](uint8(1), uint8(2))
        )
        let tupleAnnotatedA = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](annotatedA, TypeSymbol.Int32))
        let tupleAnnotatedB = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](annotatedB, TypeSymbol.Int32))
        let tupleBare = TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.String, TypeSymbol.Int32))
        let tupleAnnotatedAAgain = TupleTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](annotatedAAgain, TypeSymbol.Int32)
        )
        Assert.NotSame(tupleAnnotatedA, tupleBare)
        Assert.NotSame(tupleAnnotatedA, tupleAnnotatedB)
        // Positive interning check: same shape (same base + same flags) still
        // resolves to the same cached symbol.
        Assert.Same(tupleAnnotatedA, tupleAnnotatedAAgain)
    }

    shared {
        private func DefineHolderType(assemblyName string) Type {
            let asm = AssemblyBuilder.DefineDynamicAssembly(AssemblyName(assemblyName), AssemblyBuilderAccess.Run)
            let module = asm.DefineDynamicModule(assemblyName)
            let type = module.DefineType("Holder", TypeAttributes.Public | TypeAttributes.Class)
            return type.CreateType()
        }
    }
}
