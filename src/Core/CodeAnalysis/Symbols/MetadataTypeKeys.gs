// <copyright file="MetadataTypeKeys.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Text

/// The identity text of a type, spelled for a symbol and for a reflection type by one set of rules.
/// @remarks The comparison mode (ADR-0209 section 10) compares these texts. A definition is its assembly and full name;
/// the built-in types are their `System` names; a construction, an array, a pointer and a by-ref add their parts.
/// Both spellings share the same primitive list and the same separators, so the two cannot drift apart.
internal shared class MetadataTypeKeys {
    // The built-in types and their System names. The one list for both spellings.
    private let BuiltIns[]KeyValuePair[TypeSymbol, string] = []KeyValuePair[TypeSymbol, string]{
        KeyValuePair[TypeSymbol, string](TypeSymbol.Bool, "System.Boolean"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Char, "System.Char"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Int8, "System.SByte"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.UInt8, "System.Byte"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Int16, "System.Int16"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.UInt16, "System.UInt16"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Int32, "System.Int32"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.UInt32, "System.UInt32"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Int64, "System.Int64"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.UInt64, "System.UInt64"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.NInt, "System.IntPtr"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.NUInt, "System.UIntPtr"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Float32, "System.Single"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Float64, "System.Double"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Decimal, "System.Decimal"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.String, "System.String"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Object, "System.Object"),
        KeyValuePair[TypeSymbol, string](TypeSymbol.Void, "System.Void")
    }

    private let NullableName string = "System.Nullable`1"

    /// Spells a symbol. An absent type is the empty text.
    internal func Of(type TypeSymbol?) string {
        if type == nil {
            return ""
        }
        // A modified type has the identity of its unmodified type; the modifiers are compared as data beside it.
        if type is MetadataModifiedTypeSymbol modified {
            return Of(modified.Unmodified)
        }
        for builtIn in BuiltIns {
            if object.ReferenceEquals(builtIn.Key, type) {
                return builtIn.Value
            }
        }
        if type is NullableTypeSymbol nullable {
            let nullableArguments = List[string]()
            nullableArguments.Add(Of(nullable.UnderlyingType))
            return Generic(NullableName, nullableArguments)
        }
        if type is MetadataTypeSymbol definition {
            return Definition(definition.Module.Identity.Name, definition.FullName, definition.Module.IsCoreLibrary)
        }
        if type is ConstructedMetadataTypeSymbol constructed {
            return Generic(
                Of(constructed.Definition),
                constructed.TypeArguments.Select((a TypeSymbol) -> Of(a)).ToList()
            )
        }
        if type is MetadataArrayTypeSymbol array {
            return Of(array.ElementType) + ArraySuffix(array.IsVector, 1)
        }
        if type is RectangularArrayTypeSymbol rectangular {
            return Of(rectangular.ElementType) + ArraySuffix(false, rectangular.Rank)
        }
        if type is PointerTypeSymbol pointer {
            return Of(pointer.PointeeType) + "*"
        }
        if type is ByRefTypeSymbol byRef {
            return Of(byRef.PointeeType) + "&"
        }
        if type is MetadataFunctionPointerTypeSymbol pointer {
            return FunctionPointer(
                Of(pointer.ReturnType),
                pointer.ParameterTypes.Select((t TypeSymbol) -> Of(t)).ToList()
            )
        }
        if type is TypeParameterSymbol parameter {
            return Parameter(parameter.IsMethodTypeParameter, parameter.Ordinal)
        }
        if type is MissingTypeSymbol missing {
            return "missing:" + (missing.AssemblyIdentity?.Name ?? "") + "!" + missing.FullName
        }
        return "unknown:" + type.Name
    }

    /// Spells a reflection type by the same rules.
    internal func Of(type Type?) string {
        if type == nil {
            return ""
        }
        if type.IsFunctionPointer {
            return FunctionPointer(
                Of(type.GetFunctionPointerReturnType()),
                type.GetFunctionPointerParameterTypes().Select((t Type) -> Of(t)).ToList()
            )
        }
        if type.IsGenericParameter {
            return Parameter(type.DeclaringMethod != nil, type.GenericParameterPosition)
        }
        if type.IsByRef {
            return Of(type.GetElementType()) + "&"
        }
        if type.IsPointer {
            return Of(type.GetElementType()) + "*"
        }
        if type.IsArray {
            return Of(type.GetElementType()) + ArraySuffix(type.IsSZArray, type.GetArrayRank())
        }
        if type.IsGenericType && !type.IsGenericTypeDefinition {
            let definition = type.GetGenericTypeDefinition()
            let arguments = type.GetGenericArguments().Select((a Type) -> Of(a)).ToList()
            return if definition.FullName == NullableName && IsCoreLibrary(definition.Assembly) {
                Generic(NullableName, arguments)
            } else {
                Generic(Of(definition), arguments)
            }
        }
        return Definition(type.Assembly.GetName().Name ?? "", type.FullName ?? "", IsCoreLibrary(type.Assembly))
    }

    /// Lists the types that a type is made of, in order: the element of an array, the pointee, the underlying type of a
    /// nullable, the arguments of a construction, the return type and parameters of a function pointer, and the type
    /// beneath a modified type. This is the only place that knows the shapes. Every walk over nested types uses it, so a
    /// new shape cannot be missed by one walk and covered by another.
    internal func Parts(type TypeSymbol) ImmutableArray[TypeSymbol] {
        if type is MetadataModifiedTypeSymbol modified {
            return ImmutableArray.Create(modified.Unmodified)
        }
        if type is NullableTypeSymbol nullable {
            return ImmutableArray.Create(nullable.UnderlyingType)
        }
        if type is ConstructedMetadataTypeSymbol constructed {
            return constructed.TypeArguments
        }
        if type is MetadataArrayTypeSymbol array {
            return ImmutableArray.Create(array.ElementType)
        }
        if type is RectangularArrayTypeSymbol rectangular {
            return ImmutableArray.Create(rectangular.ElementType)
        }
        if type is PointerTypeSymbol pointer {
            return ImmutableArray.Create(pointer.PointeeType)
        }
        if type is ByRefTypeSymbol byRef {
            return ImmutableArray.Create(byRef.PointeeType)
        }
        if type is MetadataFunctionPointerTypeSymbol functionPointer {
            return functionPointer.ParameterTypes.Insert(0, functionPointer.ReturnType)
        }
        return ImmutableArray[TypeSymbol].Empty
    }

    /// Tells whether a type, or a part of it, is a missing type. The test is structural: no text is searched.
    internal func ContainsMissing(type TypeSymbol?) bool {
        if type == nil {
            return false
        }
        if type is MissingTypeSymbol {
            return true
        }
        if type is MetadataModifiedTypeSymbol modified && MetadataModifiers.ContainsMissing(modified) {
            return true
        }
        return Parts(type).Any((part TypeSymbol) -> ContainsMissing(part))
    }

    // A built-in name denotes the built-in type only in a core library (a module that defines a base-less System.Object).
    // A namesake in any other assembly is a definition of its own. Symbols and reflection types use this one rule.
    private func Definition(assemblyName string, fullName string, inCoreLibrary bool) string {
        if inCoreLibrary {
            for builtIn in BuiltIns {
                if builtIn.Value == fullName {
                    return fullName
                }
            }
        }
        return assemblyName + "!" + fullName
    }

    // The reflection side of MetadataModule.IsCoreLibrary.
    internal func IsCoreLibrary(assembly Assembly) bool {
        let objectType = assembly.GetType("System.Object", false)
        return objectType != nil && objectType.Assembly == assembly && objectType.BaseType == nil
    }

    // The one spelling of an array shape. A vector is `[]`, a rank-one non-vector array is `[*]`, higher ranks use commas.
    private func ArraySuffix(isVector bool, rank int32) string {
        if isVector {
            return "[]"
        }
        return if rank == 1 {
            "[*]"
        } else {
            "[" + string.Concat(Enumerable.Repeat(",", rank - 1)) + "]"
        }
    }

    // The one spelling of a function pointer: the return type, then the parameters. The calling convention modifiers are
    // not part of it: MetadataLoadContext reports none for a function pointer (its GetFunctionPointerCallingConventions
    // is empty even when the return type carries CallConv modifiers), so the context cannot answer that question.
    // The modifiers are kept on the symbol (MetadataFunctionPointerTypeSymbol.UnmanagedConventions) and tested there.
    private func FunctionPointer(returnType string, parameters List[string]) string -> "fnptr(" +
        returnType +
        ";" +
        string.Join(";", parameters) + ")"

    private func Generic(definition string, arguments List[string]) string -> definition + "<" + string.Join(
        ",",
        arguments
    ) +
        ">"

    private func Parameter(isMethod bool, ordinal int32) string -> if isMethod {
        "!!"
    } else {
        "!"
    } + ordinal.ToString()
}
