// <copyright file="SymbolDocumentationIdProvider.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Documentation;

internal static class SymbolDocumentationIdProvider
{
    public static string? GetDocumentationId(Symbol symbol)
    {
        return symbol switch
        {
            PackageSymbol package => GetDocumentationId(package: package),
            TypeSymbol type when IsSourceNamedType(type) => GetDocumentationId(type: type),
            EnumMemberSymbol enumMember => GetDocumentationId(member: enumMember),
            FunctionSymbol function => GetDocumentationId(function: function),
            _ => null,
        };
    }

    public static string? GetDocumentationId(Symbol member, TypeSymbol? ownerType)
    {
        return member switch
        {
            FieldSymbol field => GetDocumentationId(field: field, ownerType: ownerType),
            PropertySymbol property => GetDocumentationId(property: property, ownerType: ownerType),
            EventSymbol @event => GetDocumentationId(@event: @event, ownerType: ownerType),
            FunctionSymbol function => GetDocumentationId(function: function),
            _ => null,
        };
    }

    internal static string? GetDocumentationId(PackageSymbol package)
    {
        return package is null ? null : $"N:{package.Name}";
    }

    internal static string? GetDocumentationId(TypeSymbol type)
    {
        if (type is null || !IsSourceNamedType(type))
        {
            return null;
        }

        var builder = new StringBuilder("T:");
        AppendTypeDeclarationName(builder, type);
        return builder.ToString();
    }

    internal static string? GetDocumentationId(FunctionSymbol function)
    {
        if (function is null)
        {
            return null;
        }

        var builder = new StringBuilder("M:");
        var candidateOwner = function.ReceiverType ?? function.StaticOwnerType;
        var ownerType = candidateOwner is not null && IsSourceNamedType(candidateOwner)
            ? candidateOwner
            : null;
        if (ownerType is not null)
        {
            AppendTypeDeclarationName(builder, ownerType);
        }
        else if (!string.IsNullOrEmpty(function.Package?.Name))
        {
            builder.Append(function.Package.Name);
        }
        else
        {
            return null;
        }

        builder.Append('.');
        AppendMethodName(builder, function);

        if (!IsConstructor(function) && function.TypeParameters.Length > 0)
        {
            builder.Append("``").Append(function.TypeParameters.Length);
        }

        AppendParameterList(builder, function, ownerType);

        if (string.Equals(function.Name, "op_Implicit", StringComparison.Ordinal) ||
            string.Equals(function.Name, "op_Explicit", StringComparison.Ordinal))
        {
            builder.Append('~');
            AppendTypeReference(builder, function.Type, ownerType, function);
        }

        return builder.ToString();
    }

    private static string? GetDocumentationId(FieldSymbol field, TypeSymbol? ownerType)
    {
        if (field is null || ownerType is null)
        {
            return null;
        }

        var builder = new StringBuilder("F:");
        AppendTypeDeclarationName(builder, ownerType);
        builder.Append('.').Append(EncodeName(field.Name));
        return builder.ToString();
    }

    private static string? GetDocumentationId(PropertySymbol property, TypeSymbol? ownerType)
    {
        if (property is null || ownerType is null)
        {
            return null;
        }

        var builder = new StringBuilder("P:");
        AppendTypeDeclarationName(builder, ownerType);
        builder.Append('.').Append(EncodeName(property.Name));
        AppendParameterList(builder, property.Parameters, ownerType);
        return builder.ToString();
    }

    private static string? GetDocumentationId(EventSymbol @event, TypeSymbol? ownerType)
    {
        if (@event is null || ownerType is null)
        {
            return null;
        }

        var builder = new StringBuilder("E:");
        AppendTypeDeclarationName(builder, ownerType);
        builder.Append('.').Append(EncodeName(@event.Name));
        return builder.ToString();
    }

    private static string? GetDocumentationId(EnumMemberSymbol member)
    {
        if (member is null)
        {
            return null;
        }

        var builder = new StringBuilder("F:");
        AppendTypeDeclarationName(builder, member.EnumType);
        builder.Append('.').Append(EncodeName(member.Name));
        return builder.ToString();
    }

    private static void AppendMethodName(StringBuilder builder, FunctionSymbol function)
    {
        if (IsConstructor(function))
        {
            builder.Append(IsStaticConstructor(function) ? "#cctor" : "#ctor");
            return;
        }

        builder.Append(EncodeName(function.Name));
    }

    private static void AppendParameterList(StringBuilder builder, FunctionSymbol function, TypeSymbol? ownerType)
    {
        var start = function.ReceiverType != null && function.ExplicitReceiverParameter != null ? 1 : 0;
        if (function.Parameters.Length <= start)
        {
            return;
        }

        builder.Append('(');
        for (var i = start; i < function.Parameters.Length; i++)
        {
            if (i > start)
            {
                builder.Append(',');
            }

            AppendTypeReference(builder, function.Parameters[i].Type, ownerType, function);

            // ADR-0060 item #8: Roslyn DocID convention appends '@' for any
            // by-ref parameter ('ref', 'out', and 'in' all encode identically
            // in the DocID; the 'in' / 'out' distinction is recorded only via
            // ParameterAttributes on the metadata row).
            if (function.Parameters[i].RefKind != RefKind.None)
            {
                builder.Append('@');
            }
        }

        builder.Append(')');
    }

    private static void AppendParameterList(
        StringBuilder builder,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol? ownerType)
    {
        if (parameters.IsDefaultOrEmpty)
        {
            return;
        }

        builder.Append('(');
        for (var i = 0; i < parameters.Length; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            AppendTypeReference(builder, parameters[i].Type, ownerType, function: null);
            if (parameters[i].RefKind != RefKind.None)
            {
                builder.Append('@');
            }
        }

        builder.Append(')');
    }

    private static void AppendTypeDeclarationName(StringBuilder builder, TypeSymbol type)
    {
        var chain = SourceNestingChain(GetSourceDefinition(type));
        if (chain.Count == 0)
        {
            builder.Append(EncodeName(type.Name));
            return;
        }

        var packageName = GetPackageName(chain[0]);
        if (!string.IsNullOrEmpty(packageName))
        {
            builder.Append(packageName).Append('.');
        }

        for (var i = 0; i < chain.Count; i++)
        {
            if (i > 0)
            {
                builder.Append('.');
            }

            var level = chain[i];
            builder.Append(EncodeName(level.Name));
            var arity = GetOwnArity(level);
            if (arity > 0)
            {
                builder.Append('`').Append(arity);
            }
        }
    }

    private static void AppendTypeReference(StringBuilder builder, TypeSymbol type, TypeSymbol? ownerType, FunctionSymbol? function)
    {
        switch (type)
        {
            case null:
                builder.Append("System.Void");
                return;
            case TypeParameterSymbol typeParameter:
                if (IsMethodTypeParameter(typeParameter, function))
                {
                    builder.Append("``").Append(typeParameter.Ordinal);
                }
                else
                {
                    builder.Append('`').Append(GetTypeParameterOrdinal(typeParameter, ownerType));
                }

                return;
            case ArrayTypeSymbol arrayType:
                AppendTypeReference(builder, arrayType.ElementType, ownerType, function);
                builder.Append("[]");
                return;
            case RectangularArrayTypeSymbol rectangularArrayType:
                AppendTypeReference(builder, rectangularArrayType.ElementType, ownerType, function);
                builder.Append('[');
                for (var i = 0; i < rectangularArrayType.Rank; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    builder.Append("0:");
                }

                builder.Append(']');
                return;
            case SliceTypeSymbol sliceType:
                // #611: a slice `[]T` is backed by CLR `T[]`, so its
                // documentation ID uses the same array encoding.
                AppendTypeReference(builder, sliceType.ElementType, ownerType, function);
                builder.Append("[]");
                return;
            case ByRefTypeSymbol byRefType:
                AppendTypeReference(builder, byRefType.PointeeType, ownerType, function);
                builder.Append('@');
                return;
            case NullableTypeSymbol nullableType:
                if (NullableLifting.IsAnyValueTypeNullable(nullableType))
                {
                    builder.Append("System.Nullable{");
                    AppendTypeReference(builder, nullableType.UnderlyingType, ownerType, function);
                    builder.Append('}');
                }
                else
                {
                    AppendTypeReference(builder, nullableType.UnderlyingType, ownerType, function);
                }

                return;
            case PointerTypeSymbol pointerType:
                AppendTypeReference(builder, pointerType.PointeeType, ownerType, function);
                builder.Append('*');
                return;
            case TupleTypeSymbol tupleType:
                AppendTupleTypeReference(builder, tupleType.ElementTypes, 0, tupleType.Arity, ownerType, function);
                return;
            case FunctionTypeSymbol functionType:
                AppendFunctionTypeReference(builder, functionType, ownerType, function);
                return;
            case StructSymbol structType:
                AppendSourceTypeReference(builder, structType, ownerType, function);
                return;
            case InterfaceSymbol interfaceType:
                AppendSourceTypeReference(builder, interfaceType, ownerType, function);
                return;
            case EnumSymbol enumType:
                AppendSourceTypeReference(builder, enumType, ownerType, function);
                return;
            case DelegateTypeSymbol delegateType:
                AppendSourceTypeReference(builder, delegateType, ownerType, function);
                return;
            case ImportedTypeSymbol importedType when importedType.OpenDefinition is not null && !importedType.TypeArguments.IsDefaultOrEmpty:
                AppendClrConstructedTypeReference(builder, importedType.OpenDefinition, importedType.TypeArguments, ownerType, function);
                return;
            case ImportedTypeSymbol importedType when importedType.Type is not null:
                AppendClrTypeReference(builder, importedType.Type);
                return;
            default:
                if (type.ClrType is not null)
                {
                    AppendClrTypeReference(builder, type.ClrType);
                }
                else
                {
                    builder.Append(EncodeName(type.Name));
                }

                return;
        }
    }

    private static void AppendTupleTypeReference(
        StringBuilder builder,
        ImmutableArray<TypeSymbol> elementTypes,
        int start,
        int count,
        TypeSymbol? ownerType,
        FunctionSymbol? function)
    {
        // TupleTypeSymbol retains only positional element types, which also
        // erases tuple element names as required by XML documentation IDs.
        builder.Append("System.ValueTuple{");

        var directCount = Math.Min(count, 7);
        for (var i = 0; i < directCount; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            AppendTypeReference(builder, elementTypes[start + i], ownerType, function);
        }

        if (count > 7)
        {
            builder.Append(',');
            AppendTupleTypeReference(builder, elementTypes, start + 7, count - 7, ownerType, function);
        }

        builder.Append('}');
    }

    private static void AppendFunctionTypeReference(
        StringBuilder builder,
        FunctionTypeSymbol type,
        TypeSymbol? ownerType,
        FunctionSymbol? function)
    {
        var returnsVoid = ReferenceEquals(type.ReturnType, TypeSymbol.Void);
        builder.Append(returnsVoid ? "System.Action" : "System.Func");

        var argumentCount = type.ParameterTypes.Length + (returnsVoid ? 0 : 1);
        if (argumentCount == 0)
        {
            return;
        }

        builder.Append('{');
        for (var i = 0; i < type.ParameterTypes.Length; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            AppendTypeReference(builder, type.ParameterTypes[i], ownerType, function);
        }

        if (!returnsVoid)
        {
            if (type.ParameterTypes.Length > 0)
            {
                builder.Append(',');
            }

            AppendTypeReference(builder, type.ReturnType, ownerType, function);
        }

        builder.Append('}');
    }

    private static void AppendSourceTypeReference(
        StringBuilder builder,
        TypeSymbol type,
        TypeSymbol? ownerType,
        FunctionSymbol? function)
    {
        var chain = SourceNestingChain(GetSourceDefinition(type));
        if (chain.Count == 0)
        {
            builder.Append(EncodeName(type.Name));
            return;
        }

        var packageName = GetPackageName(chain[0]);
        if (!string.IsNullOrEmpty(packageName))
        {
            builder.Append(packageName).Append('.');
        }

        var enclosingArguments = GetEnclosingTypeArguments(type);
        var ownArguments = GetOwnTypeArguments(type);
        var enclosingArgumentIndex = 0;

        for (var i = 0; i < chain.Count; i++)
        {
            if (i > 0)
            {
                builder.Append('.');
            }

            var level = chain[i];
            builder.Append(EncodeName(level.Name));

            var arity = GetOwnArity(level);
            if (arity == 0)
            {
                continue;
            }

            if (i < chain.Count - 1 &&
                enclosingArgumentIndex + arity <= enclosingArguments.Length)
            {
                AppendSourceTypeArguments(
                    builder,
                    enclosingArguments,
                    enclosingArgumentIndex,
                    arity,
                    ownerType,
                    function);
                enclosingArgumentIndex += arity;
                continue;
            }

            if (i == chain.Count - 1 && ownArguments.Length == arity)
            {
                AppendSourceTypeArguments(builder, ownArguments, 0, arity, ownerType, function);
                continue;
            }

            if (TryGetOwnerGenericOffset(level, ownerType, out var ownerOffset))
            {
                builder.Append('{');
                for (var a = 0; a < arity; a++)
                {
                    if (a > 0)
                    {
                        builder.Append(',');
                    }

                    builder.Append('`').Append(ownerOffset + a);
                }

                builder.Append('}');
                continue;
            }

            builder.Append('`').Append(arity);
        }
    }

    private static void AppendSourceTypeArguments(
        StringBuilder builder,
        ImmutableArray<TypeSymbol> arguments,
        int start,
        int count,
        TypeSymbol? ownerType,
        FunctionSymbol? function)
    {
        builder.Append('{');
        for (var i = 0; i < count; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            AppendTypeReference(builder, arguments[start + i], ownerType, function);
        }

        builder.Append('}');
    }

    private static bool IsSourceNamedType(TypeSymbol type)
    {
        return type is StructSymbol or InterfaceSymbol or EnumSymbol or DelegateTypeSymbol;
    }

    private static TypeSymbol GetSourceDefinition(TypeSymbol type)
    {
        return type switch
        {
            StructSymbol structType => structType.Definition ?? structType,
            InterfaceSymbol interfaceType => interfaceType.Definition ?? interfaceType,
            EnumSymbol enumType => enumType.Definition ?? enumType,
            DelegateTypeSymbol delegateType => delegateType.Definition ?? delegateType,
            _ => type,
        };
    }

    private static TypeSymbol? GetContainingSourceType(TypeSymbol type)
    {
        return type switch
        {
            StructSymbol structType => structType.ContainingType,
            InterfaceSymbol interfaceType => interfaceType.ContainingType,
            EnumSymbol enumType => enumType.ContainingType,
            _ => null,
        };
    }

    private static List<TypeSymbol> SourceNestingChain(TypeSymbol type)
    {
        var chain = new List<TypeSymbol>();
        for (TypeSymbol? current = GetSourceDefinition(type);
             current is not null;
             current = GetContainingSourceType(current) is { } containing
                 ? GetSourceDefinition(containing)
                 : null)
        {
            chain.Insert(0, current);
        }

        return chain;
    }

    private static string GetPackageName(TypeSymbol type)
    {
        return type switch
        {
            StructSymbol structType => structType.PackageName,
            InterfaceSymbol interfaceType => interfaceType.PackageName,
            EnumSymbol enumType => enumType.PackageName,
            DelegateTypeSymbol delegateType => delegateType.PackageName,
            _ => string.Empty,
        };
    }

    private static int GetOwnArity(TypeSymbol type)
    {
        return type switch
        {
            StructSymbol { Declaration: { } declaration } =>
                declaration.TypeParameterList?.Parameters.Count ?? 0,
            StructSymbol structType => structType.TypeParameters.Length,
            InterfaceSymbol { Declaration: { } declaration } =>
                declaration.TypeParameterList?.Parameters.Count ?? 0,
            InterfaceSymbol interfaceType => interfaceType.TypeParameters.Length,
            DelegateTypeSymbol { Declaration: { } declaration } =>
                declaration.TypeParameterList?.Parameters.Count ?? 0,
            DelegateTypeSymbol delegateType => delegateType.TypeParameters.Length,
            _ => 0,
        };
    }

    private static ImmutableArray<TypeSymbol> GetEnclosingTypeArguments(TypeSymbol type)
    {
        return type switch
        {
            StructSymbol structType => structType.EnclosingTypeArguments,
            EnumSymbol enumType => enumType.EnclosingTypeArguments,
            _ => ImmutableArray<TypeSymbol>.Empty,
        };
    }

    private static ImmutableArray<TypeSymbol> GetOwnTypeArguments(TypeSymbol type)
    {
        return type switch
        {
            StructSymbol structType => structType.TypeArguments,
            InterfaceSymbol interfaceType => interfaceType.TypeArguments,
            DelegateTypeSymbol delegateType => delegateType.TypeArguments,
            _ => ImmutableArray<TypeSymbol>.Empty,
        };
    }

    private static bool TryGetOwnerGenericOffset(TypeSymbol type, TypeSymbol? ownerType, out int offset)
    {
        offset = 0;
        if (ownerType is null || !IsSourceNamedType(ownerType))
        {
            return false;
        }

        foreach (var ownerLevel in SourceNestingChain(GetSourceDefinition(ownerType)))
        {
            if (ReferenceEquals(GetSourceDefinition(ownerLevel), GetSourceDefinition(type)))
            {
                return true;
            }

            offset += GetOwnArity(ownerLevel);
        }

        offset = 0;
        return false;
    }

    private static int GetTypeParameterOrdinal(TypeParameterSymbol typeParameter, TypeSymbol? ownerType)
    {
        if (ownerType is null || !IsSourceNamedType(ownerType))
        {
            return typeParameter.Ordinal;
        }

        var chain = SourceNestingChain(GetSourceDefinition(ownerType));
        var offsets = new int[chain.Count];
        var offset = 0;
        for (var i = 0; i < chain.Count; i++)
        {
            offsets[i] = offset;
            offset += GetOwnArity(chain[i]);
        }

        for (var i = chain.Count - 1; i >= 0; i--)
        {
            if (DeclaresTypeParameter(chain[i], typeParameter))
            {
                return offsets[i] + typeParameter.Ordinal;
            }
        }

        return typeParameter.Ordinal;
    }

    private static bool DeclaresTypeParameter(TypeSymbol type, TypeParameterSymbol typeParameter)
    {
        var ordinal = typeParameter.Ordinal;
        if (ordinal < 0)
        {
            return false;
        }

        var parameters = type switch
        {
            StructSymbol structType => structType.TypeParameters,
            InterfaceSymbol interfaceType => interfaceType.TypeParameters,
            DelegateTypeSymbol delegateType => delegateType.TypeParameters,
            _ => ImmutableArray<TypeParameterSymbol>.Empty,
        };
        return ordinal < parameters.Length &&
            (ReferenceEquals(parameters[ordinal], typeParameter) ||
             string.Equals(parameters[ordinal].Name, typeParameter.Name, StringComparison.Ordinal));
    }

    private static void AppendClrTypeReference(StringBuilder builder, Type? type)
    {
        if (type == null)
        {
            return;
        }

        if (type.IsByRef)
        {
            AppendClrTypeReference(builder, type.GetElementType());
            builder.Append('@');
            return;
        }

        if (type.IsPointer)
        {
            AppendClrTypeReference(builder, type.GetElementType());
            builder.Append('*');
            return;
        }

        if (type.IsArray)
        {
            AppendClrTypeReference(builder, type.GetElementType());
            AppendArraySuffix(builder, type);
            return;
        }

        if (type.IsGenericParameter)
        {
            builder.Append(type.DeclaringMethod != null ? "``" : "`").Append(type.GenericParameterPosition);
            return;
        }

        AppendClrConstructedTypeReference(builder, type);
    }

    private static void AppendClrConstructedTypeReference(StringBuilder builder, Type? type)
    {
        var chain = NestingChain(type);
        var outermost = chain[0];
        if (!string.IsNullOrEmpty(outermost.Namespace))
        {
            builder.Append(outermost.Namespace).Append('.');
        }

        // NestingChain returns an empty list for a null type, so the chain[0]
        // above would already have thrown; reaching here means type is present.
        var allArgs = type!.IsGenericType ? type.GetGenericArguments() : Type.EmptyTypes;
        var consumed = 0;
        for (var i = 0; i < chain.Count; i++)
        {
            if (i > 0)
            {
                builder.Append('.');
            }

            var level = chain[i];
            builder.Append(StripArity(level.Name));
            var arity = LevelArity(level);
            if (arity == 0)
            {
                continue;
            }

            if (type.IsGenericTypeDefinition)
            {
                builder.Append('`').Append(arity);
                continue;
            }

            builder.Append('{');
            for (var a = 0; a < arity; a++)
            {
                if (a > 0)
                {
                    builder.Append(',');
                }

                AppendClrTypeReference(builder, allArgs[consumed + a]);
            }

            builder.Append('}');
            consumed += arity;
        }
    }

    private static void AppendClrConstructedTypeReference(
        StringBuilder builder,
        Type openDefinition,
        ImmutableArray<TypeSymbol> typeArguments,
        TypeSymbol? ownerType,
        FunctionSymbol? function)
    {
        var chain = NestingChain(openDefinition);
        var outermost = chain[0];
        if (!string.IsNullOrEmpty(outermost.Namespace))
        {
            builder.Append(outermost.Namespace).Append('.');
        }

        var consumed = 0;
        for (var i = 0; i < chain.Count; i++)
        {
            if (i > 0)
            {
                builder.Append('.');
            }

            var level = chain[i];
            builder.Append(StripArity(level.Name));
            var arity = LevelArity(level);
            if (arity == 0)
            {
                continue;
            }

            builder.Append('{');
            for (var a = 0; a < arity; a++)
            {
                if (a > 0)
                {
                    builder.Append(',');
                }

                AppendTypeReference(builder, typeArguments[consumed + a], ownerType, function);
            }

            builder.Append('}');
            consumed += arity;
        }
    }

    private static void AppendArraySuffix(StringBuilder builder, Type array)
    {
        if (array.IsSZArray)
        {
            builder.Append("[]");
            return;
        }

        var rank = array.GetArrayRank();
        builder.Append('[');
        for (var i = 0; i < rank; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            builder.Append("0:");
        }

        builder.Append(']');
    }

    private static List<Type> NestingChain(Type? type)
    {
        var chain = new List<Type>();
        for (var current = type; current != null; current = current.DeclaringType)
        {
            chain.Insert(0, current);
        }

        return chain;
    }

    private static int LevelArity(Type level)
    {
        var own = level.IsGenericType ? level.GetGenericArguments().Length : 0;
        var enclosing = level.DeclaringType is { IsGenericType: true } declaring
            ? declaring.GetGenericArguments().Length
            : 0;
        return own - enclosing;
    }

    private static string StripArity(string name)
    {
        var tick = name.IndexOf('`');
        return tick >= 0 ? name.Substring(0, tick) : name;
    }

    private static bool IsMethodTypeParameter(TypeParameterSymbol typeParameter, FunctionSymbol? function)
    {
        if (function is null || function.TypeParameters.IsDefaultOrEmpty)
        {
            return false;
        }

        for (var i = 0; i < function.TypeParameters.Length; i++)
        {
            if (ReferenceEquals(function.TypeParameters[i], typeParameter))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsConstructor(FunctionSymbol function)
    {
        return string.Equals(function.Name, ".ctor", StringComparison.Ordinal) ||
               string.Equals(function.Name, "#ctor", StringComparison.Ordinal);
    }

    private static bool IsStaticConstructor(FunctionSymbol function)
    {
        return string.Equals(function.Name, ".cctor", StringComparison.Ordinal) ||
               string.Equals(function.Name, "#cctor", StringComparison.Ordinal);
    }

    private static string EncodeName(string name)
    {
        return name
            .Replace('.', '#')
            .Replace('<', '{')
            .Replace('>', '}')
            .Replace(',', '@');
    }
}
