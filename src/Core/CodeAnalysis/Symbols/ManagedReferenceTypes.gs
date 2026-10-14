// <copyright file="ManagedReferenceTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Runtime.InteropServices
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis

internal shared class ManagedReferenceTypes {
    private let Contracts ConditionalWeakTable[Assembly, StrongBox[bool]] = ConditionalWeakTable[
        Assembly,
        StrongBox[bool]
    ]()

    internal func IsDefinition(@NotNullWhen(true) type Type?, out readOnly bool) bool {
        readOnly = false
        if type == nil || !type.IsGenericType {
            return false
        }
        let definition = type.GetGenericTypeDefinition()
        if definition.Assembly.GetName().Name != NativeSliceTypes.AssemblyName {
            return false
        }
        readOnly = definition.FullName == "Gsharp.Values.ReadOnlyManagedRef`1"
        return (readOnly || definition.FullName == "Gsharp.Values.ManagedRef`1") && !definition.IsValueType
    }

    internal func TryGetElement(type TypeSymbol, @NotNullWhen(true) out element TypeSymbol?, out readOnly bool) bool {
        element = nil
        readOnly = false
        if type is NullableTypeSymbol || !IsDefinition(type.ClrType, out readOnly) {
            return false
        }
        element = if type is NullabilityAnnotatedTypeSymbol annotated {
            annotated.GetTypeArgumentSymbol(0)
        } else {
            (
                if type.ConstructedTypeArguments is {Length: 1} arguments {
                    arguments[0]
                } else {
                    TypeSymbol.FromClrTypeWithoutNullability(
                        type.ClrType!!.GetGenericArguments()[0],
                        NullabilityFreeReason.TypeStructure
                    )
                }
            )
        }
        return true
    }

    internal func TryResolveDefinition(
        references ReferenceResolver,
        readOnly bool,
        @NotNullWhen(true) out type Type?
    ) bool {
        if references.TryResolveType(
            if readOnly {
                "Gsharp.Values.ReadOnlyManagedRef`1"
            } else {
                "Gsharp.Values.ManagedRef`1"
            },
            out type
        ) &&
            IsCompatible(type) {
            return true
        }
        type = nil
        return false
    }

    internal func IsCompatible(@NotNullWhen(true) type Type?) bool -> IsDefinition(type, out _) && Contracts.GetValue(
        type!!.GetGenericTypeDefinition().Assembly,
        (assembly Assembly) -> StrongBox[bool](ValidateContract(assembly))
    )
        .Value

    internal func Construct(
        definition Type,
        element TypeSymbol,
        references ReferenceResolver
    ) TypeSymbol -> ImportedTypeSymbol
        .GetConstructed(
        definition.MakeGenericType(references.MapClrTypeToReferences(element.ClrType ?? typeof(object))!!),
        definition,
        ImmutableArray.Create(element)
    )

    internal func Borrow(handle BoundExpression) BoundExpression {
        TryGetElement(handle.Type, out var element, out _)
        let pointee = Invariant.Required(
            element,
            "Borrow is only constructed for a recognized non-null managed handle",
            expression: "element"
        )
        let method = Invariant
            .Required(handle.Type.ClrType, "managed handles have a runtime type", expression: "handle.Type.ClrType")
            .GetMethods()
            .Single((m MethodInfo) -> m.Name == "Borrow" && m.GetParameters().Length == 0)
        return BoundImportedInstanceCallExpression(
            handle.Syntax,
            handle,
            method,
            ByRefTypeSymbol.Get(pointee),
            ImmutableArray[BoundExpression].Empty
        )
    }

    internal func HaveIncompatibleElements(from TypeSymbol, to TypeSymbol) bool {
        var from = from
        var to = to
        from = if from is NullableTypeSymbol nf {
            nf.UnderlyingType
        } else {
            from
        }
        to = if to is NullableTypeSymbol nt {
            nt.UnderlyingType
        } else {
            to
        }
        return TryGetElement(from, out var left, out _) &&
            TryGetElement(to, out var right, out _) &&
            (
            !Conversion.ClassifyNonStructural(left!!, right!!).IsIdentity || !NullableFlagsBuilder.Build(left!!)
                .SequenceEqual(NullableFlagsBuilder.Build(right!!))
        )
    }

    private func ValidateContract(assembly Assembly) bool {
        // Only the nominal SDK declarations are inspected. The weak,
        // assembly-keyed cache keeps LSP lookups bounded without retaining MLCs.
        try {
            let writable = assembly.GetType("Gsharp.Values.ManagedRef`1")
            let readOnly = assembly.GetType("Gsharp.Values.ReadOnlyManagedRef`1")
            let location = assembly.GetType("Gsharp.Values.ManagedLocation`1")
            let key Type? = assembly.GetType("Gsharp.Values.ManagedLocationKey")
            if !IsHandleClass(writable) ||
                !IsHandleClass(readOnly) ||
                !IsHandleClass(location) ||
                key == nil ||
                !key.IsPublic ||
                !key.IsClass ||
                key.IsAbstract ||
                !key.IsSealed ||
                key.IsGenericType {
                return false
            }
            let objectFactory = UniqueMethod(key, "Object")
            let fieldPath = UniqueMethod(key, "Field")
            let sameLocation = UniqueMethod(location!!, "SameLocation")
            let locationSelf = location!!.MakeGenericType(location!!.GetGenericArguments())
            return Matches(objectFactory, isStatic: true, key, typeof(object)) &&
                Matches(fieldPath, isStatic: false, key, typeof(RuntimeFieldHandle), typeof(RuntimeTypeHandle)) &&
                Matches(sameLocation, false, typeof(bool), locationSelf) &&
                ValidateHandle(writable!!, readOnly!!, location!!, key, readOnlyBorrow: false) &&
                ValidateHandle(readOnly!!, readOnly!!, location!!, key, readOnlyBorrow: true) &&
                ValidateSliceFactories(
                assembly.GetType("Gsharp.Values.Slice`1"),
                writable!!,
                readOnly!!,
                readOnlySlice: false
            ) &&
                ValidateSliceFactories(
                assembly.GetType("Gsharp.Values.ReadOnlySlice`1"),
                writable!!,
                readOnly!!,
                readOnlySlice: true
            )
        } catch (FileNotFoundException) {
            return false // A required signature's referenced assembly is missing.

        } catch (FileLoadException) {
            return false // A required signature's referenced assembly cannot load.

        } catch (TypeLoadException) {
            return false // A required ABI type cannot be resolved.

        }
    }

    private func IsHandleClass(@NotNullWhen(true) type Type?) bool {
        if type == nil ||
            !type.IsPublic ||
            !type.IsClass ||
            !type.IsAbstract ||
            type.IsSealed ||
            !type.IsGenericTypeDefinition ||
            type
            .GetGenericArguments().Length != 1 {
            return false
        }
        let parameter = type.GetGenericArguments()[0]
        let constructor ConstructorInfo? = type.GetConstructor(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            nil,
            Type.EmptyTypes,
            nil
        )
        return parameter.GenericParameterAttributes == GenericParameterAttributes.None &&
            parameter
            .GetGenericParameterConstraints()
            .Length == 0 &&
            constructor != nil &&
            (constructor.CallingConvention & CallingConventions.VarArgs) == 0 &&
            (constructor.IsPublic || constructor.IsFamily || constructor.IsFamilyOrAssembly)
    }

    private func ValidateHandle(type Type, readOnly Type, location Type, key Type, readOnlyBorrow bool) bool {
        let element = type.GetGenericArguments()[0]
        let borrow MethodInfo? = UniqueMethod(type, "Borrow")
        let getLocation MethodInfo? = UniqueMethod(type, "GetLocation")
        let fromArray MethodInfo? = UniqueMethod(type, "FromArray")
        let fromNativeArray MethodInfo? = UniqueMethod(type, "FromArrayNative")
        if !IsConstruction(type.BaseType, location, element) ||
            borrow == nil ||
            borrow.IsStatic ||
            !borrow.IsAbstract ||
            !borrow.IsVirtual ||
            borrow.IsFinal ||
            !IsOrdinaryMethod(borrow) ||
            !ClrTypeUtilities.AreSame(borrow.DeclaringType, type) ||
            !ParametersMatch(borrow) ||
            !borrow
            .ReturnType
            .IsByRef ||
            !ClrTypeUtilities.AreSame(borrow.ReturnType.GetElementType(), element) ||
            borrow
            .ReturnParameter
            .GetOptionalCustomModifiers()
            .Length != 0 ||
            getLocation == nil ||
            !getLocation.IsAbstract ||
            !getLocation.IsVirtual ||
            getLocation.IsFinal ||
            !IsConstruction(getLocation.DeclaringType, location, element) ||
            !Matches(getLocation, false, key) ||
            fromArray == nil ||
            !fromArray.IsStatic ||
            !IsOrdinaryMethod(fromArray) ||
            fromArray.IsAbstract ||
            !HasUnmodifiedReturn(fromArray) ||
            !ParametersMatch(fromArray, element.MakeArrayType(), typeof(int32)) ||
            !IsConstruction(fromArray.ReturnType, type, element) ||
            fromNativeArray == nil ||
            !fromNativeArray.IsStatic ||
            !IsOrdinaryMethod(fromNativeArray) ||
            !HasUnmodifiedReturn(fromNativeArray) ||
            !ParametersMatch(fromNativeArray, element.MakeArrayType(), typeof(nint)) ||
            !IsConstruction(fromNativeArray.ReturnType, type, element) {
            return false
        }
        let modifiers = borrow.ReturnParameter.GetRequiredCustomModifiers()
        let readonlyAttribute = borrow
            .ReturnParameter
            .GetCustomAttributesData()
            .Any(
            (attribute CustomAttributeData) -> ClrTypeUtilities.AreSame(
                attribute.AttributeType,
                typeof(IsReadOnlyAttribute)
            )
        )
        if readonlyAttribute != readOnlyBorrow ||
            (
            if readOnlyBorrow {
                modifiers.Length != 1 || !ClrTypeUtilities.AreSame(modifiers[0], typeof(InAttribute))
            } else {
                modifiers.Length != 0
            }
        ) {
            return false
        }
        for name in[]string{"op_Equality", "op_Inequality"} {
            let operation MethodInfo? = UniqueMethod(type, name)
            let self = type.MakeGenericType(element)
            if operation == nil || !operation.IsSpecialName || !Matches(operation, true, typeof(bool), self, self) {
                return false
            }
        }
        let view MethodInfo? = UniqueMethod(type, "AsReadOnly")
        return readOnlyBorrow ||
            (
            view != nil &&
                !view.IsStatic &&
                !view.IsAbstract &&
                IsOrdinaryMethod(view) &&
                HasUnmodifiedReturn(view) &&
                ParametersMatch(view) &&
                IsConstruction(view.ReturnType, readOnly, element)
        )
    }

    private func IsConstruction(type Type?, definition Type, argument Type) bool -> type != nil &&
        type.IsGenericType == true &&
        ClrTypeUtilities.AreSame(type.GetGenericTypeDefinition(), definition) && type.GetGenericArguments()
        .Length == 1 &&
        ClrTypeUtilities.AreSame(type.GetGenericArguments()[0], argument)

    private func ValidateSliceFactories(slice Type?, writable Type, readOnly Type, readOnlySlice bool) bool {
        if slice == nil {
            return true // Array/object handles do not require native slice definitions.

        }
        if !NativeSliceTypes.IsDefinition(slice, out _) || !slice.IsGenericTypeDefinition {
            return false
        }
        let element = slice.GetGenericArguments()[0]
        for name in if readOnlySlice {
            []string{"GetReadOnlyManagedReference"}
        } else {
            []string{"GetManagedReference", "GetReadOnlyManagedReference"}
        } {
            let methods = slice.GetMethods().Where((method MethodInfo) -> method.Name == name).ToArray()
            let result = (
                if name == "GetManagedReference" {
                    writable
                } else {
                    readOnly
                }
            ).MakeGenericType(element)
            for parameters in[][]Type{
                []Type{typeof(int32)},
                []Type{typeof(Index)},
                []Type{typeof(int32), typeof(bool)}
            } {
                if methods.Count((method MethodInfo) -> Matches(method, false, result, parameters)) != 1 {
                    return false
                }
            }
        }
        return true
    }

    private func UniqueMethod(type Type, name string) MethodInfo? {
        let methods = type.GetMethods().Where((method MethodInfo) -> method.Name == name).ToArray()
        return if methods.Length == 1 {
            methods[0]
        } else {
            default(MethodInfo?)
        }
    }

    private func Matches(method MethodInfo?, isStatic bool, result Type, parameters ...Type) bool -> method != nil &&
        method.IsStatic == isStatic &&
        IsOrdinaryMethod(method) &&
        HasUnmodifiedReturn(method) &&
        ClrTypeUtilities.AreSame(method.ReturnType, result) && ParametersMatch(method, parameters)

    private func IsOrdinaryMethod(method MethodInfo) bool -> !method.IsGenericMethod &&
        (method.CallingConvention & CallingConventions.VarArgs) == 0

    private func HasUnmodifiedReturn(method MethodInfo) bool -> method
        .ReturnParameter
        .GetRequiredCustomModifiers()
        .Length == 0 &&
        method
        .ReturnParameter
        .GetOptionalCustomModifiers()
        .Length == 0

    private func ParametersMatch(method MethodInfo, types ...Type) bool {
        let parameters = method.GetParameters()
        return parameters.Length == types.Length && parameters.Select(
            (parameter ParameterInfo, i int32) -> ClrTypeUtilities.AreSame(parameter.ParameterType, types[i]) &&
                (!types[i].IsArray || parameter.ParameterType.IsSZArray == types[i].IsSZArray) &&
                parameter
                .GetRequiredCustomModifiers().Length == 0 && parameter.GetOptionalCustomModifiers().Length == 0
        )
            .All((match bool) -> match)
    }
}
