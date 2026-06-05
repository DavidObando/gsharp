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
    public static string GetDocumentationId(Symbol symbol)
    {
        return symbol switch
        {
            PackageSymbol package => GetDocumentationId(package),
            StructSymbol type => GetDocumentationId(type),
            FunctionSymbol function => GetDocumentationId(function),
            _ => null,
        };
    }

    public static string GetDocumentationId(Symbol member, StructSymbol ownerType)
    {
        return member switch
        {
            FieldSymbol field => GetDocumentationId(field, ownerType),
            PropertySymbol property => GetDocumentationId(property, ownerType),
            EventSymbol @event => GetDocumentationId(@event, ownerType),
            FunctionSymbol function => GetDocumentationId(function),
            _ => null,
        };
    }

    internal static string GetDocumentationId(PackageSymbol package)
    {
        return package is null ? null : $"N:{package.Name}";
    }

    internal static string GetDocumentationId(StructSymbol type)
    {
        if (type is null)
        {
            return null;
        }

        var builder = new StringBuilder("T:");
        AppendTypeDeclarationName(builder, type);
        return builder.ToString();
    }

    internal static string GetDocumentationId(FunctionSymbol function)
    {
        if (function is null)
        {
            return null;
        }

        var builder = new StringBuilder("M:");
        var ownerType = function.ReceiverType as StructSymbol ?? function.StaticOwnerType;
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
        return builder.ToString();
    }

    private static string GetDocumentationId(FieldSymbol field, StructSymbol ownerType)
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

    private static string GetDocumentationId(PropertySymbol property, StructSymbol ownerType)
    {
        if (property is null || ownerType is null)
        {
            return null;
        }

        var builder = new StringBuilder("P:");
        AppendTypeDeclarationName(builder, ownerType);
        builder.Append('.').Append(EncodeName(property.Name));
        return builder.ToString();
    }

    private static string GetDocumentationId(EventSymbol @event, StructSymbol ownerType)
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

    private static void AppendMethodName(StringBuilder builder, FunctionSymbol function)
    {
        if (IsConstructor(function))
        {
            builder.Append(IsStaticConstructor(function) ? "#cctor" : "#ctor");
            return;
        }

        builder.Append(EncodeName(function.Name));
    }

    private static void AppendParameterList(StringBuilder builder, FunctionSymbol function, StructSymbol ownerType)
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

    private static void AppendTypeDeclarationName(StringBuilder builder, StructSymbol type)
    {
        var definition = type.Definition ?? type;
        AppendSourceTypeDeclarationName(builder, definition.PackageName, definition.Name, definition.TypeParameters.Length);
    }

    private static void AppendTypeReference(StringBuilder builder, TypeSymbol type, StructSymbol ownerType, FunctionSymbol function)
    {
        switch (type)
        {
            case null:
                builder.Append("System.Void");
                return;
            case TypeParameterSymbol typeParameter:
                builder.Append(IsMethodTypeParameter(typeParameter, function) ? "``" : "`").Append(typeParameter.Ordinal);
                return;
            case ArrayTypeSymbol arrayType:
                AppendTypeReference(builder, arrayType.ElementType, ownerType, function);
                builder.Append("[]");
                return;
            case ByRefTypeSymbol byRefType:
                AppendTypeReference(builder, byRefType.PointeeType, ownerType, function);
                builder.Append('@');
                return;
            case NullableTypeSymbol nullableType:
                builder.Append("System.Nullable`1{");
                AppendTypeReference(builder, nullableType.UnderlyingType, ownerType, function);
                builder.Append('}');
                return;
            case StructSymbol structType:
                AppendSourceTypeReference(builder, structType, ownerType, function);
                return;
            case InterfaceSymbol interfaceType:
                AppendSourceTypeReference(builder, interfaceType, ownerType, function);
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

    private static void AppendSourceTypeReference(StringBuilder builder, StructSymbol type, StructSymbol ownerType, FunctionSymbol function)
    {
        var definition = type.Definition ?? type;
        AppendSourceNamedTypeReference(builder, definition.PackageName, definition.Name, definition.TypeParameters.Length, type.TypeArguments, ownerType, function);
    }

    private static void AppendSourceTypeReference(StringBuilder builder, InterfaceSymbol type, StructSymbol ownerType, FunctionSymbol function)
    {
        var definition = type.Definition ?? type;
        AppendSourceNamedTypeReference(builder, definition.PackageName, definition.Name, definition.TypeParameters.Length, type.TypeArguments, ownerType, function);
    }

    private static void AppendSourceNamedTypeReference(
        StringBuilder builder,
        string packageName,
        string name,
        int arity,
        ImmutableArray<TypeSymbol> typeArguments,
        StructSymbol ownerType,
        FunctionSymbol function)
    {
        if (!string.IsNullOrEmpty(packageName))
        {
            builder.Append(packageName).Append('.');
        }

        builder.Append(EncodeName(name));
        if (!typeArguments.IsDefaultOrEmpty && typeArguments.Length > 0)
        {
            builder.Append('{');
            for (var i = 0; i < typeArguments.Length; i++)
            {
                if (i > 0)
                {
                    builder.Append(',');
                }

                AppendTypeReference(builder, typeArguments[i], ownerType, function);
            }

            builder.Append('}');
            return;
        }

        if (arity > 0)
        {
            builder.Append('`').Append(arity);
        }
    }

    private static void AppendSourceTypeDeclarationName(StringBuilder builder, string packageName, string name, int arity)
    {
        if (!string.IsNullOrEmpty(packageName))
        {
            builder.Append(packageName).Append('.');
        }

        builder.Append(EncodeName(name));
        if (arity > 0)
        {
            builder.Append('`').Append(arity);
        }
    }

    private static void AppendClrTypeReference(StringBuilder builder, Type type)
    {
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

    private static void AppendClrConstructedTypeReference(StringBuilder builder, Type type)
    {
        var chain = NestingChain(type);
        var outermost = chain[0];
        if (!string.IsNullOrEmpty(outermost.Namespace))
        {
            builder.Append(outermost.Namespace).Append('.');
        }

        var allArgs = type.IsGenericType ? type.GetGenericArguments() : Type.EmptyTypes;
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
        StructSymbol ownerType,
        FunctionSymbol function)
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

    private static List<Type> NestingChain(Type type)
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

    private static bool IsMethodTypeParameter(TypeParameterSymbol typeParameter, FunctionSymbol function)
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
