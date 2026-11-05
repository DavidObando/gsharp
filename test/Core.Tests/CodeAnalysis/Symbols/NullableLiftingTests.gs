// <copyright file="NullableLiftingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Emit
import Xunit

/// PR N-1 / bug-overview §6.1: the (cref:NullableLifting) facade
/// collects every `Nullable<T>` probe / constructor-projection
/// helper that the binder and emitter rely on. These tests pin the
/// behavioural contract of the facade so subsequent PRs (N-2/N-3/N-4) that
/// plug new logic into the same seam cannot regress the pre-existing
/// callers silently.
open class NullableLiftingTests {
    @Fact
    func IsValueTypeNullable_Returns_True_For_Value_Type_Nullable() {
        let sym = NullableTypeSymbol.Get(TypeSymbol.Int32)
        Assert.True(NullableLifting.IsValueTypeNullable(sym))
    }

    @Fact
    func IsValueTypeNullable_Returns_False_For_Reference_Type_Nullable() {
        let sym = NullableTypeSymbol.Get(TypeSymbol.String)
        Assert.False(NullableLifting.IsValueTypeNullable(sym))
    }

    @Fact
    func IsValueTypeNullable_Returns_False_For_Null_Argument() {
        Assert.False(NullableLifting.IsValueTypeNullable(nil))
    }

    @Fact
    func IsValueTypeNullableClr_Returns_True_For_Constructed_Nullable_Of_Int() {
        Assert.True(NullableLifting.IsValueTypeNullableClr(typeof(int32?)))
    }

    @Fact
    func IsValueTypeNullableClr_Returns_False_For_Open_Nullable_Definition() {
        Assert.False(NullableLifting.IsValueTypeNullableClr(typeof(Nullable[_])))
    }

    @Fact
    func IsValueTypeNullableClr_Returns_False_For_Non_Generic_Type() {
        Assert.False(NullableLifting.IsValueTypeNullableClr(typeof(int32)))
        Assert.False(NullableLifting.IsValueTypeNullableClr(typeof(string)))
    }

    @Fact
    func IsValueTypeNullableClr_Returns_False_For_Null_Argument() {
        Assert.False(NullableLifting.IsValueTypeNullableClr(nil))
    }

    /// Imported types come from a MetadataLoadContext. The probe must use metadata only (#5768).
    /// A runtime Nullable probe gives null for these types on .NET 10 and throws on .NET 11.
    @Fact
    func GetValueTypeNullableUnderlyingClr_Uses_Metadata_For_MetadataLoadContext_Types() {
        using let context = MetadataLoadContext(
            PathAssemblyResolver(ReferenceResolver.HostTrustedPlatformAssemblyPaths())
        )
        let core = context.CoreAssembly!!
        let int32Type = core.GetType("System.Int32", true)!!
        let nullableDefinition = core.GetType("System.Nullable`1", true)!!
        let listDefinition = core.GetType("System.Collections.Generic.List`1", true)!!
        Assert.Same(
            int32Type,
            NullableLifting.GetValueTypeNullableUnderlyingClr(nullableDefinition.MakeGenericType(int32Type))
        )
        Assert.Null(NullableLifting.GetValueTypeNullableUnderlyingClr(int32Type))
        Assert.Null(NullableLifting.GetValueTypeNullableUnderlyingClr(nullableDefinition))
        Assert.Null(NullableLifting.GetValueTypeNullableUnderlyingClr(listDefinition.MakeGenericType(int32Type)))
    }

    /// A same-compilation value type is a TypeBuilder while binding runs (#4184, #5768).
    @Fact
    func GetValueTypeNullableUnderlyingClr_Returns_TypeBuilder_Argument_Of_Nullable() {
        let module = AssemblyBuilder.DefineDynamicAssembly(
            AssemblyName("NullableLifting5768"),
            AssemblyBuilderAccess.Run
        )
            .DefineDynamicModule("NullableLifting5768")
        let builder = module.DefineType("Value5768", TypeAttributes.Public | TypeAttributes.Sealed, typeof(ValueType))
        Assert.Same(
            builder,
            NullableLifting.GetValueTypeNullableUnderlyingClr(typeof(Nullable[_]).MakeGenericType(builder))
        )
        Assert.Null(NullableLifting.GetValueTypeNullableUnderlyingClr(builder))
    }

    @Fact
    func GetEffectiveClrType_Returns_Nullable_For_ValueType_Wrapper() {
        let sym = NullableTypeSymbol.Get(TypeSymbol.Int32)
        let clr = NullableLifting.GetEffectiveClrType(sym)
        Assert.Equal(typeof(int32?), clr)
    }

    @Fact
    func GetEffectiveClrType_Returns_Underlying_For_ReferenceType_Wrapper() {
        let sym = NullableTypeSymbol.Get(TypeSymbol.String)
        let clr = NullableLifting.GetEffectiveClrType(sym)
        Assert.Equal(typeof(string), clr)
    }

    @Fact
    func GetEffectiveClrType_Returns_Underlying_For_NonNullable() {
        let clr = NullableLifting.GetEffectiveClrType(TypeSymbol.Int32)
        Assert.Equal(typeof(int32), clr)
    }

    @Fact
    func GetEffectiveClrType_Returns_Null_For_Null_Argument() {
        Assert.Null(NullableLifting.GetEffectiveClrType(nil))
    }

    @Fact
    func TryConstructNullable_Succeeds_With_Default_References() {
        let refs = ReferenceResolver.Default()
        let ok = NullableLifting.TryConstructNullable(refs, typeof(int32), out var constructed)
        Assert.True(ok)
        Assert.Equal(typeof(int32?), constructed)
    }

    @Fact
    func TryConstructNullable_Returns_False_For_Null_Underlying() {
        let refs = ReferenceResolver.Default()
        let ok = NullableLifting.TryConstructNullable(refs, nil, out var constructed)
        Assert.False(ok)
        Assert.Null(constructed)
    }

    @Fact
    func TryConstructNullable_Returns_Nullable_For_TimeSpan() {
        let refs = ReferenceResolver.Default()
        let ok = NullableLifting.TryConstructNullable(refs, typeof(TimeSpan), out var constructed)
        Assert.True(ok)
        Assert.Equal(typeof(TimeSpan?), constructed)
    }

    @Fact
    func ResolveClrTypeForGenericArg_Returns_Nullable_For_ValueType_NullableTypeSymbol() {
        let refs = ReferenceResolver.Default()
        let sym = NullableTypeSymbol.Get(TypeSymbol.Int32)
        let clr = NullableLifting.ResolveClrTypeForGenericArg(refs, sym)
        Assert.Equal(typeof(int32?), clr)
    }

    @Fact
    func ResolveClrTypeForGenericArg_Returns_Underlying_For_ReferenceType_NullableTypeSymbol() {
        let refs = ReferenceResolver.Default()
        let sym = NullableTypeSymbol.Get(TypeSymbol.String)
        let clr = NullableLifting.ResolveClrTypeForGenericArg(refs, sym)
        // Reference-type nullability has no CLR counterpart: contract documented
        // at Binder.cs:2387 says the result is the bare underlying reference type.
        Assert.Equal(typeof(string), clr)
    }

    @Fact
    func ResolveClrTypeForGenericArg_Returns_Mapped_Type_For_NonNullable_Imported_Type() {
        let refs = ReferenceResolver.Default()
        let clr = NullableLifting.ResolveClrTypeForGenericArg(refs, TypeSymbol.Int32)
        Assert.Equal(typeof(int32), clr)
    }

    @Fact
    func ResolveClrTypeForGenericArg_Returns_Null_For_TypeSymbol_With_No_ClrType() {
        let refs = ReferenceResolver.Default()
        let userStruct = StructSymbol(
            "MyStruct",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: "test"
        )
        Assert.Null(userStruct.ClrType)
        let clr = NullableLifting.ResolveClrTypeForGenericArg(refs, userStruct)
        Assert.Null(clr)
    }
}
