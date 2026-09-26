// <copyright file="ManagedReferenceTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis.Symbols;

internal static class ManagedReferenceTypes
{
    private static readonly ConditionalWeakTable<Assembly, StrongBox<bool>> Contracts = new();

    internal static bool IsDefinition([NotNullWhen(true)] Type? type, out bool readOnly)
    {
        readOnly = false;
        if (type == null || !type.IsGenericType)
        {
            return false;
        }

        var definition = type.GetGenericTypeDefinition();
        if (definition.Assembly.GetName().Name != NativeSliceTypes.AssemblyName)
        {
            return false;
        }

        readOnly = definition.FullName == "Gsharp.Values.ReadOnlyManagedRef`1";
        return (readOnly || definition.FullName == "Gsharp.Values.ManagedRef`1") && !definition.IsValueType;
    }

    internal static bool TryGetElement(TypeSymbol type, [NotNullWhen(true)] out TypeSymbol? element, out bool readOnly)
    {
        element = null;
        readOnly = false;
        if (type is NullableTypeSymbol || !IsDefinition(type.ClrType, out readOnly))
        {
            return false;
        }

        element = type is NullabilityAnnotatedTypeSymbol annotated
            ? annotated.GetTypeArgumentSymbol(0)
            : type.ConstructedTypeArguments is { Length: 1 } arguments
                ? arguments[0]
                : TypeSymbol.FromClrTypeWithoutNullability(type.ClrType.GetGenericArguments()[0], NullabilityFreeReason.TypeStructure);
        return true;
    }

    internal static bool TryResolveDefinition(ReferenceResolver references, bool readOnly, [NotNullWhen(true)] out Type? type)
    {
        if (references.TryResolveType(readOnly ? "Gsharp.Values.ReadOnlyManagedRef`1" : "Gsharp.Values.ManagedRef`1", out type)
            && IsCompatible(type))
        {
            return true;
        }

        type = null;
        return false;
    }

    internal static bool IsCompatible([NotNullWhen(true)] Type? type)
        => IsDefinition(type, out _)
            && Contracts.GetValue(type.GetGenericTypeDefinition().Assembly, assembly => new StrongBox<bool>(ValidateContract(assembly))).Value;

    internal static TypeSymbol Construct(Type definition, TypeSymbol element, ReferenceResolver references)
        => ImportedTypeSymbol.GetConstructed(
            definition.MakeGenericType(references.MapClrTypeToReferences(element.ClrType ?? typeof(object))),
            definition,
            ImmutableArray.Create(element));

    internal static BoundExpression Borrow(BoundExpression handle)
    {
        TryGetElement(handle.Type, out var element, out _);
        var pointee = Invariant.Required(element, "Borrow is only constructed for a recognized non-null managed handle");
        var method = Invariant.Required(handle.Type.ClrType, "managed handles have a runtime type").GetMethods()
            .Single(m => m.Name == "Borrow" && m.GetParameters().Length == 0);
        return new BoundImportedInstanceCallExpression(
            handle.Syntax, handle, method, ByRefTypeSymbol.Get(pointee), ImmutableArray<BoundExpression>.Empty);
    }

    internal static bool HaveIncompatibleElements(TypeSymbol from, TypeSymbol to)
    {
        from = from is NullableTypeSymbol nf ? nf.UnderlyingType : from;
        to = to is NullableTypeSymbol nt ? nt.UnderlyingType : to;
        return TryGetElement(from, out var left, out _) && TryGetElement(to, out var right, out _)
            && (!Conversion.ClassifyNonStructural(left, right).IsIdentity
                || !NullableFlagsBuilder.Build(left).SequenceEqual(NullableFlagsBuilder.Build(right)));
    }

    private static bool ValidateContract(Assembly assembly)
    {
        // Only the nominal SDK declarations are inspected. The weak,
        // assembly-keyed cache keeps LSP lookups bounded without retaining MLCs.
        try
        {
            var writable = assembly.GetType("Gsharp.Values.ManagedRef`1");
            var readOnly = assembly.GetType("Gsharp.Values.ReadOnlyManagedRef`1");
            var location = assembly.GetType("Gsharp.Values.ManagedLocation`1");
            var key = assembly.GetType("Gsharp.Values.ManagedLocationKey");
            if (!IsHandleClass(writable) || !IsHandleClass(readOnly) || !IsHandleClass(location)
                || key == null || !key.IsPublic || !key.IsClass || key.IsAbstract || !key.IsSealed || key.IsGenericType)
            {
                return false;
            }

            var objectFactory = UniqueMethod(key, "Object");
            var fieldPath = UniqueMethod(key, "Field");
            var sameLocation = UniqueMethod(location, "SameLocation");
            var locationSelf = location.MakeGenericType(location.GetGenericArguments());
            return Matches(objectFactory, isStatic: true, key, typeof(object))
                && Matches(fieldPath, isStatic: false, key, typeof(RuntimeFieldHandle), typeof(RuntimeTypeHandle))
                && Matches(sameLocation, false, typeof(bool), locationSelf)
                && ValidateHandle(writable, readOnly, location, key, readOnlyBorrow: false)
                && ValidateHandle(readOnly, readOnly, location, key, readOnlyBorrow: true)
                && ValidateSliceFactories(assembly.GetType("Gsharp.Values.Slice`1"), writable, readOnly, readOnlySlice: false)
                && ValidateSliceFactories(assembly.GetType("Gsharp.Values.ReadOnlySlice`1"), writable, readOnly, readOnlySlice: true);
        }
        catch (FileNotFoundException)
        {
            return false; // A required signature's referenced assembly is missing.
        }
        catch (FileLoadException)
        {
            return false; // A required signature's referenced assembly cannot load.
        }
        catch (TypeLoadException)
        {
            return false; // A required ABI type cannot be resolved.
        }
    }

    private static bool IsHandleClass([NotNullWhen(true)] Type? type)
    {
        if (type == null || !type.IsPublic || !type.IsClass || !type.IsAbstract || type.IsSealed
            || !type.IsGenericTypeDefinition || type.GetGenericArguments().Length != 1)
        {
            return false;
        }

        var parameter = type.GetGenericArguments()[0];
        var constructor = type.GetConstructor(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
        return parameter.GenericParameterAttributes == GenericParameterAttributes.None
            && parameter.GetGenericParameterConstraints().Length == 0
            && constructor != null && (constructor.CallingConvention & CallingConventions.VarArgs) == 0
            && (constructor.IsPublic || constructor.IsFamily || constructor.IsFamilyOrAssembly);
    }

    private static bool ValidateHandle(Type type, Type readOnly, Type location, Type key, bool readOnlyBorrow)
    {
        var element = type.GetGenericArguments()[0];
        var borrow = UniqueMethod(type, "Borrow");
        var getLocation = UniqueMethod(type, "GetLocation");
        var fromArray = UniqueMethod(type, "FromArray");
        var fromNativeArray = UniqueMethod(type, "FromArrayNative");
        if (!IsConstruction(type.BaseType, location, element)
            || borrow == null || borrow.IsStatic || !borrow.IsAbstract || !borrow.IsVirtual || borrow.IsFinal || !IsOrdinaryMethod(borrow)
            || !ClrTypeUtilities.AreSame(borrow.DeclaringType, type) || !ParametersMatch(borrow)
            || !borrow.ReturnType.IsByRef || !ClrTypeUtilities.AreSame(borrow.ReturnType.GetElementType(), element)
            || borrow.ReturnParameter.GetOptionalCustomModifiers().Length != 0
            || getLocation == null || !getLocation.IsAbstract || !getLocation.IsVirtual || getLocation.IsFinal
            || !IsConstruction(getLocation.DeclaringType, location, element) || !Matches(getLocation, false, key)
            || fromArray == null || !fromArray.IsStatic || !IsOrdinaryMethod(fromArray) || fromArray.IsAbstract || !HasUnmodifiedReturn(fromArray)
            || !ParametersMatch(fromArray, element.MakeArrayType(), typeof(int)) || !IsConstruction(fromArray.ReturnType, type, element)
            || fromNativeArray == null || !fromNativeArray.IsStatic || !IsOrdinaryMethod(fromNativeArray) || !HasUnmodifiedReturn(fromNativeArray)
            || !ParametersMatch(fromNativeArray, element.MakeArrayType(), typeof(IntPtr)) || !IsConstruction(fromNativeArray.ReturnType, type, element))
        {
            return false;
        }

        var modifiers = borrow.ReturnParameter.GetRequiredCustomModifiers();
        var readonlyAttribute = borrow.ReturnParameter.GetCustomAttributesData()
            .Any(attribute => ClrTypeUtilities.AreSame(attribute.AttributeType, typeof(IsReadOnlyAttribute)));
        if (readonlyAttribute != readOnlyBorrow
            || (readOnlyBorrow ? modifiers.Length != 1 || !ClrTypeUtilities.AreSame(modifiers[0], typeof(InAttribute)) : modifiers.Length != 0))
        {
            return false;
        }

        foreach (var name in new[] { "op_Equality", "op_Inequality" })
        {
            var operation = UniqueMethod(type, name);
            var self = type.MakeGenericType(element);
            if (operation == null || !operation.IsSpecialName || !Matches(operation, true, typeof(bool), self, self))
            {
                return false;
            }
        }

        var view = UniqueMethod(type, "AsReadOnly");
        return readOnlyBorrow
            || (view != null && !view.IsStatic && !view.IsAbstract && IsOrdinaryMethod(view) && HasUnmodifiedReturn(view)
                && ParametersMatch(view) && IsConstruction(view.ReturnType, readOnly, element));
    }

    private static bool IsConstruction(Type? type, Type definition, Type argument)
        => type is { IsGenericType: true } && ClrTypeUtilities.AreSame(type.GetGenericTypeDefinition(), definition)
            && type.GetGenericArguments().Length == 1 && ClrTypeUtilities.AreSame(type.GetGenericArguments()[0], argument);

    private static bool ValidateSliceFactories(Type? slice, Type writable, Type readOnly, bool readOnlySlice)
    {
        if (slice == null)
        {
            return true; // Array/object handles do not require native slice definitions.
        }

        if (!NativeSliceTypes.IsDefinition(slice, out _) || !slice.IsGenericTypeDefinition)
        {
            return false;
        }

        var element = slice.GetGenericArguments()[0];
        foreach (var name in readOnlySlice
            ? new[] { "GetReadOnlyManagedReference" }
            : new[] { "GetManagedReference", "GetReadOnlyManagedReference" })
        {
            var methods = slice.GetMethods().Where(method => method.Name == name).ToArray();
            var result = (name == "GetManagedReference" ? writable : readOnly).MakeGenericType(element);
            foreach (var parameters in new[] { new[] { typeof(int) }, new[] { typeof(Index) }, new[] { typeof(int), typeof(bool) } })
            {
                if (methods.Count(method => Matches(method, false, result, parameters)) != 1)
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static MethodInfo? UniqueMethod(Type type, string name)
    {
        var methods = type.GetMethods().Where(method => method.Name == name).ToArray();
        return methods.Length == 1 ? methods[0] : null;
    }

    private static bool Matches(MethodInfo? method, bool isStatic, Type result, params Type[] parameters)
        => method != null && method.IsStatic == isStatic && IsOrdinaryMethod(method) && HasUnmodifiedReturn(method)
            && ClrTypeUtilities.AreSame(method.ReturnType, result) && ParametersMatch(method, parameters);

    private static bool IsOrdinaryMethod(MethodInfo method)
        => !method.IsGenericMethod && (method.CallingConvention & CallingConventions.VarArgs) == 0;

    private static bool HasUnmodifiedReturn(MethodInfo method)
        => method.ReturnParameter.GetRequiredCustomModifiers().Length == 0
            && method.ReturnParameter.GetOptionalCustomModifiers().Length == 0;

    private static bool ParametersMatch(MethodInfo method, params Type[] types)
    {
        var parameters = method.GetParameters();
        return parameters.Length == types.Length && parameters.Select((parameter, i) =>
            ClrTypeUtilities.AreSame(parameter.ParameterType, types[i])
            && (!types[i].IsArray || parameter.ParameterType.IsSZArray == types[i].IsSZArray)
            && parameter.GetRequiredCustomModifiers().Length == 0
            && parameter.GetOptionalCustomModifiers().Length == 0).All(match => match);
    }
}
