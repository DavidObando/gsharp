// <copyright file="GsToCSharpTypeSpeller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §B: projects a bound G# <see cref="TypeSymbol"/> onto its C# type
/// spelling for the declaration-only stub the generator host feeds to Roslyn.
/// This is the reverse of cs2gs's <c>CSharpTypeMapper</c>: cs2gs maps a Roslyn
/// <c>ITypeSymbol</c> onto a canonical G# type; this maps a bound G#
/// <see cref="TypeSymbol"/> back onto a fully-qualified (<c>global::</c>) C#
/// type name.
/// <para>
/// A type with no faithful C# spelling degrades to the universal upper bound
/// <c>object</c> and the loss is recorded on <see cref="Fallbacks"/> so the
/// caller can surface a <c>GS9204</c> info (ADR-0145 §H). The stub only has to
/// re-parse, so the fallback never breaks the pipeline.
/// </para>
/// </summary>
public sealed class GsToCSharpTypeSpeller
{
    /// <summary>
    /// The parseable placeholder emitted when a type has no C# spelling. As in
    /// cs2gs's <c>CSharpTypeMapper.UnsupportedPlaceholderType</c>, <c>object</c>
    /// is the universal upper bound so the stub always re-parses.
    /// </summary>
    public const string FallbackType = "object";

    // Reverse of cs2gs CSharpTypeMapper.MapPredefinedName, keyed by the CLR type
    // the built-in G# TypeSymbol carries (e.g. TypeSymbol.Int32.ClrType == typeof(int)).
    private static readonly Dictionary<Type, string> PrimitiveKeywords = new()
    {
        [typeof(bool)] = "bool",
        [typeof(byte)] = "byte",
        [typeof(sbyte)] = "sbyte",
        [typeof(short)] = "short",
        [typeof(ushort)] = "ushort",
        [typeof(int)] = "int",
        [typeof(uint)] = "uint",
        [typeof(long)] = "long",
        [typeof(ulong)] = "ulong",
        [typeof(float)] = "float",
        [typeof(double)] = "double",
        [typeof(decimal)] = "decimal",
        [typeof(char)] = "char",
        [typeof(string)] = "string",
        [typeof(object)] = "object",
        [typeof(nint)] = "nint",
        [typeof(nuint)] = "nuint",
        [typeof(void)] = "void",
    };

    private readonly List<string> fallbacks = new();

    /// <summary>
    /// Gets the distinct type names that could not be spelled and were degraded
    /// to <see cref="FallbackType"/> (ADR-0145 §H / <c>GS9204</c>).
    /// </summary>
    public IReadOnlyList<string> Fallbacks => fallbacks;

    /// <summary>
    /// Spells the fully-qualified C# type name for a bound G# type. Returns
    /// <see cref="FallbackType"/> (recorded on <see cref="Fallbacks"/>) when the
    /// type has no faithful C# form.
    /// </summary>
    /// <param name="type">The bound G# type to spell.</param>
    /// <returns>A parseable C# type spelling.</returns>
    public string Spell(TypeSymbol type)
    {
        switch (type)
        {
            case null:
                return Fallback("<null-type>");

            case NullableTypeSymbol nullable:
                return Spell(nullable.UnderlyingType) + "?";

            case TypeParameterSymbol tp:
                return tp.Name;

            case SequenceTypeSymbol seq:
                return $"global::System.Collections.Generic.IEnumerable<{Spell(seq.ElementType)}>";

            case AsyncSequenceTypeSymbol aseq:
                return $"global::System.Collections.Generic.IAsyncEnumerable<{Spell(aseq.ElementType)}>";

            case MapTypeSymbol map:
                return $"global::System.Collections.Generic.Dictionary<{Spell(map.KeyType)}, {Spell(map.ValueType)}>";

            case ArrayTypeSymbol array:
                return Spell(array.ElementType) + "[]";

            case SliceTypeSymbol slice:
                // ADR-0145 §B: G#-only shapes project onto their documented CLR shape.
                return $"global::System.Span<{Spell(slice.ElementType)}>";

            case ChannelTypeSymbol channel:
                return $"global::System.Threading.Channels.Channel<{Spell(channel.ElementType)}>";

            case PointerTypeSymbol pointer:
                return Spell(pointer.PointeeType) + "*";

            case ByRefTypeSymbol byRef:
                // A managed by-ref has no standalone type-position spelling; the
                // pointee is the closest parseable form for a signature stub.
                return Spell(byRef.PointeeType);

            case TupleTypeSymbol tuple:
                return "(" + string.Join(", ", tuple.ElementTypes.Select(Spell)) + ")";

            case FunctionTypeSymbol function:
                return SpellFunction(function);

            case DelegateTypeSymbol del:
                return SpellUserType(del.PackageName, del.Name, del.TypeArguments);

            case EnumSymbol enumSymbol when enumSymbol.ClrType == null:
                return SpellUserType(enumSymbol.PackageName, enumSymbol.Name, default);

            case InterfaceSymbol iface when iface.ClrType == null:
                return SpellUserType(iface.PackageName, iface.Name, iface.TypeArguments);

            case StructSymbol structSymbol when structSymbol.ClrType == null:
                return SpellUserType(structSymbol.PackageName, structSymbol.Name, structSymbol.TypeArguments);

            case ImportedTypeSymbol imported:
                return SpellImported(imported);
        }

        // A built-in primitive is a plain TypeSymbol (not a subclass) carrying a
        // CLR type; map it to the C# keyword.
        if (type.GetType() == typeof(TypeSymbol) && type.ClrType != null &&
            PrimitiveKeywords.TryGetValue(type.ClrType, out var keyword))
        {
            return keyword;
        }

        // An imported aggregate (StructSymbol/InterfaceSymbol/EnumSymbol) that
        // carries a CLR type, or any other CLR-backed symbol, spells from its
        // CLR type.
        if (type.ClrType != null)
        {
            return SpellClrType(type.ClrType, default);
        }

        return Fallback(type.Name);
    }

    private static string StripGenericArity(string metadataName)
    {
        if (string.IsNullOrEmpty(metadataName))
        {
            return metadataName;
        }

        // `System.Collections.Generic.List`1` -> `System.Collections.Generic.List`.
        var tick = metadataName.IndexOf('`');
        if (tick >= 0)
        {
            metadataName = metadataName.Substring(0, tick);
        }

        // Nested CLR types use `+`; C# spells them with `.`.
        return metadataName.Replace('+', '.');
    }

    private string SpellFunction(FunctionTypeSymbol function)
    {
        var parameters = function.ParameterTypes.Select(Spell).ToList();
        var isVoid = function.ReturnType == null || function.ReturnType == TypeSymbol.Void;
        if (isVoid)
        {
            return parameters.Count == 0
                ? "global::System.Action"
                : $"global::System.Action<{string.Join(", ", parameters)}>";
        }

        parameters.Add(Spell(function.ReturnType));
        return $"global::System.Func<{string.Join(", ", parameters)}>";
    }

    private string SpellUserType(string packageName, string name, System.Collections.Immutable.ImmutableArray<TypeSymbol> typeArguments)
    {
        var qualified = string.IsNullOrEmpty(packageName) ? name : $"{packageName}.{name}";
        var spelled = "global::" + qualified;
        if (!typeArguments.IsDefaultOrEmpty)
        {
            spelled += "<" + string.Join(", ", typeArguments.Select(Spell)) + ">";
        }

        return spelled;
    }

    private string SpellImported(ImportedTypeSymbol imported)
    {
        // Prefer the symbolic type arguments (#313 constructions such as
        // `List[T]`) so the open definition + symbolic args reconstruct the
        // strongly-typed shape rather than the type-erased `<object>` closure.
        if (!imported.TypeArguments.IsDefaultOrEmpty && imported.OpenDefinition != null)
        {
            var baseName = StripGenericArity(imported.OpenDefinition.FullName ?? imported.OpenDefinition.Name);
            var args = string.Join(", ", imported.TypeArguments.Select(Spell));
            return $"global::{baseName}<{args}>";
        }

        if (imported.ClrType != null)
        {
            return SpellClrType(imported.ClrType, default);
        }

        return Fallback(imported.Name);
    }

    private string SpellClrType(Type clrType, System.Collections.Immutable.ImmutableArray<TypeSymbol> unused)
    {
        if (PrimitiveKeywords.TryGetValue(clrType, out var keyword))
        {
            return keyword;
        }

        if (clrType.IsArray)
        {
            var element = clrType.GetElementType();
            return (element != null ? SpellClrType(element, default) : FallbackType) + "[]";
        }

        if (clrType.IsPointer)
        {
            var element = clrType.GetElementType();
            return (element != null ? SpellClrType(element, default) : FallbackType) + "*";
        }

        if (clrType.IsGenericType && !clrType.IsGenericTypeDefinition)
        {
            var definition = clrType.GetGenericTypeDefinition();
            var baseName = StripGenericArity(definition.FullName ?? definition.Name);
            var args = string.Join(", ", clrType.GetGenericArguments().Select(a => SpellClrType(a, default)));
            return $"global::{baseName}<{args}>";
        }

        var fullName = clrType.FullName;
        if (string.IsNullOrEmpty(fullName))
        {
            // A generic parameter (T) or otherwise anonymous CLR type: use the bare name.
            return string.IsNullOrEmpty(clrType.Name) ? Fallback("<anonymous-clr-type>") : clrType.Name;
        }

        return "global::" + StripGenericArity(fullName);
    }

    private string Fallback(string typeName)
    {
        if (!fallbacks.Contains(typeName))
        {
            fallbacks.Add(typeName);
        }

        return FallbackType;
    }
}
