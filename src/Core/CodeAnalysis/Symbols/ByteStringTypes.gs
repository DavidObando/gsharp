// <copyright file="ByteStringTypes.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Emit
import System
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection

/// Recognizes the immutable byte-string runtime without changing CLR string types.
internal shared class ByteStringTypes {
    internal func IsDefinition(@NotNullWhen(true) type Type?) bool -> type != nil &&
        type.FullName == "Gsharp.Values.ByteString" &&
        type
        .Assembly
        .GetName()
        .Name == NativeSliceTypes.AssemblyName &&
        type.IsValueType &&
        !type.IsGenericType &&
        !type.IsByRefLike

    internal func TryResolveDefinition(references ReferenceResolver, @NotNullWhen(true) out type Type?) bool {
        type = nil
        if references.GetCoreType("System.Object").Assembly.GetName().Version?.Major < 10 {
            return false
        }
        if !references.TryResolveType("Gsharp.Values.ByteString", out var candidate) ||
            candidate == nil ||
            !IsDefinition(candidate) {
            return false
        }
        let length = candidate.GetProperty("Length")
        let literal = GetLiteralFactory(candidate)
        if length == nil ||
            length
            .PropertyType
            .FullName != "System.Int32" ||
            length.GetMethod == nil ||
            length.SetMethod != nil ||
            literal == nil {
            return false
        }
        let methods = candidate.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
        let byteType = references.GetCoreType("System.Byte")
        let intType = references.GetCoreType("System.Int32")
        let boolType = references.GetCoreType("System.Boolean")
        if !HasMethod(methods, "get_Item", false, byteType, intType) ||
            !HasMethod(methods, "get_Item", false, byteType, references.GetCoreType("System.Index")) ||
            !HasMethod(methods, "get_Item", false, candidate, references.GetCoreType("System.Range")) ||
            !HasMethod(methods, "Equals", false, boolType, candidate) ||
            !HasMethod(methods, "CompareTo", false, intType, candidate) ||
            !HasMethod(methods, "Subslice", false, candidate, intType, intType) ||
            !HasMethod(methods, "ToArray", false, byteType.MakeArrayType()) ||
            !HasMethod(methods, "Detach", false, candidate) ||
            !HasMethod(methods, "op_Addition", true, candidate, candidate, candidate) {
            return false
        }
        for name in[]string{
            "op_Equality",
            "op_Inequality",
            "op_LessThan",
            "op_LessThanOrEqual",
            "op_GreaterThan",
            "op_GreaterThanOrEqual"
        } {
            if !HasMethod(methods, name, true, boolType, candidate, candidate) {
                return false
            }
        }
        type = candidate
        return true
    }

    private func HasMethod(
        methods[]MethodInfo,
        name string,
        isStatic bool,
        returnType Type,
        parameterTypes ...Type
    ) bool -> methods
        .Any(
        (method MethodInfo) -> method.Name == name &&
            method.IsStatic == isStatic &&
            !method.IsGenericMethod &&
            method.ReturnType == returnType &&
            method
            .GetParameters()
            .Select((parameter ParameterInfo) -> parameter.ParameterType)
            .SequenceEqual(parameterTypes)
    )

    internal func GetLiteralFactory(type Type) MethodInfo? -> type.GetMethods(BindingFlags.Public | BindingFlags.Static)
        .FirstOrDefault(
        (method MethodInfo) -> method.Name == "FromLiteral" &&
            !method.IsGenericMethod &&
            method.ReturnType == type &&
            method
            .GetParameters().Length == 1 && method.GetParameters()[0].ParameterType.FullName == "System.String"
    )
}
