#nullable disable

// <copyright file="DocumentationIdProvider.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;

namespace GSharp.Core.CodeAnalysis.Documentation;

/// <summary>
/// Computes documentation ids ("DocIDs") in the exact format Roslyn's
/// <c>DocumentationCommentId</c> / the C# language specification uses. This is the
/// single shared component behind both documentation <em>ingestion</em> (reflected
/// CLR members, ADR-0057 §6) and documentation <em>emission</em> (source symbols,
/// ADR-0057 §5): the two paths must never diverge, so they share this code and one
/// golden corpus.
/// </summary>
/// <remarks>
/// A DocID is a prefix (<c>T:</c>, <c>M:</c>, <c>P:</c>, <c>F:</c>, <c>E:</c>,
/// <c>N:</c>) followed by the member's fully-qualified, language-neutral signature:
/// nested types separated by <c>.</c>, generic arity as <c>`n</c> (types) / <c>``n</c>
/// (methods), constructed type arguments in <c>{…}</c>, by-ref <c>@</c>, arrays
/// <c>[]</c>, pointers <c>*</c>, and a <c>~ReturnType</c> suffix on conversion operators.
/// </remarks>
public static class DocumentationIdProvider
{
    /// <summary>
    /// Computes the DocID for any reflected member, dispatching on its kind.
    /// </summary>
    /// <param name="member">The reflected member.</param>
    /// <returns>The DocID, or <see langword="null"/> when the member kind is unsupported.</returns>
    public static string GetDocumentationId(MemberInfo member)
    {
        return member switch
        {
            Type type => GetDocumentationId(type),
            MethodBase method => GetDocumentationId(method),
            PropertyInfo property => GetDocumentationId(property),
            FieldInfo field => GetDocumentationId(field),
            EventInfo @event => GetDocumentationId(@event),
            _ => null,
        };
    }

    /// <summary>Computes the <c>T:</c> DocID for a reflected type.</summary>
    /// <param name="type">The reflected type.</param>
    /// <returns>The type DocID.</returns>
    public static string GetDocumentationId(Type type)
    {
        var builder = new StringBuilder("T:");
        AppendTypeDeclarationName(builder, NormalizeToGenericDefinition(type));
        return builder.ToString();
    }

    /// <summary>Computes the <c>M:</c> DocID for a reflected method or constructor.</summary>
    /// <param name="method">The reflected method or constructor.</param>
    /// <returns>The method DocID.</returns>
    public static string GetDocumentationId(MethodBase method)
    {
        // Normalize a member reflected off a constructed generic type (e.g. List<int>.Add)
        // to its counterpart on the generic definition (List<>.Add) so both the declaration
        // path (`List`1.Add`) AND the parameter signature (`(`0)` instead of `(System.Int32)`)
        // match the XML doc key. Without this, every member on a constructed generic type
        // would produce a DocID Roslyn never emits (issue #393).
        method = NormalizeToOpenGenericDeclaringType(method) ?? method;

        var builder = new StringBuilder("M:");
        AppendTypeDeclarationName(builder, method.DeclaringType);
        builder.Append('.');
        AppendMethodName(builder, method);

        if (method.IsGenericMethod)
        {
            builder.Append("``").Append(method.GetGenericArguments().Length);
        }

        AppendParameterList(builder, method.GetParameters());

        if (method is MethodInfo info && (method.Name == "op_Implicit" || method.Name == "op_Explicit"))
        {
            builder.Append('~');
            AppendTypeReference(builder, info.ReturnType);
        }

        return builder.ToString();
    }

    /// <summary>Computes the <c>P:</c> DocID for a reflected property or indexer.</summary>
    /// <param name="property">The reflected property.</param>
    /// <returns>The property DocID.</returns>
    public static string GetDocumentationId(PropertyInfo property)
    {
        property = NormalizeToOpenGenericDeclaringType(property) ?? property;

        var builder = new StringBuilder("P:");
        AppendTypeDeclarationName(builder, property.DeclaringType);
        builder.Append('.').Append(EncodeName(property.Name));
        AppendParameterList(builder, property.GetIndexParameters());
        return builder.ToString();
    }

    /// <summary>Computes the <c>F:</c> DocID for a reflected field.</summary>
    /// <param name="field">The reflected field.</param>
    /// <returns>The field DocID.</returns>
    public static string GetDocumentationId(FieldInfo field)
    {
        field = NormalizeToOpenGenericDeclaringType(field) ?? field;

        var builder = new StringBuilder("F:");
        AppendTypeDeclarationName(builder, field.DeclaringType);
        builder.Append('.').Append(EncodeName(field.Name));
        return builder.ToString();
    }

    /// <summary>Computes the <c>E:</c> DocID for a reflected event.</summary>
    /// <param name="event">The reflected event.</param>
    /// <returns>The event DocID.</returns>
    public static string GetDocumentationId(EventInfo @event)
    {
        @event = NormalizeToOpenGenericDeclaringType(@event) ?? @event;

        var builder = new StringBuilder("E:");
        AppendTypeDeclarationName(builder, @event.DeclaringType);
        builder.Append('.').Append(EncodeName(@event.Name));
        return builder.ToString();
    }

    // Normalizes a constructed generic type (e.g. List<int>) to its generic definition
    // (List<>) so the declaration-name path produces arity-backticked output (`List`1`)
    // that matches XML doc keys. Non-generic and already-open generic types pass through
    // unchanged. Null in → null out (callers handle the null DeclaringType case).
    private static Type NormalizeToGenericDefinition(Type type)
    {
        if (type is { IsGenericType: true, IsGenericTypeDefinition: false })
        {
            return type.GetGenericTypeDefinition();
        }

        return type;
    }

    // Re-resolves a member reflected off a *constructed* generic type to the equivalent
    // member on the generic *definition*. This is what makes DocIDs match the XML doc
    // keys for things like `typeof(List<int>).GetMethod("Add")`: not only must the
    // declaring type be `List`1`, but the parameter signature must be `(`0)` rather than
    // the bound `(System.Int32)`. Matching by metadata token within the same module is
    // the standard reflection trick for going from constructed → open form.
    // Returns null when the member is already open or normalization isn't possible.
    private static T NormalizeToOpenGenericDeclaringType<T>(T member)
        where T : MemberInfo
    {
        var declaring = member.DeclaringType;
        if (declaring is not { IsGenericType: true, IsGenericTypeDefinition: false })
        {
            return null;
        }

        Type openType;
        try
        {
            openType = declaring.GetGenericTypeDefinition();
        }
        catch (InvalidOperationException)
        {
            return null;
        }

        const BindingFlags AllDeclared = BindingFlags.Public | BindingFlags.NonPublic
            | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;

        foreach (var candidate in openType.GetMembers(AllDeclared))
        {
            if (candidate is T typed
                && candidate.MetadataToken == member.MetadataToken
                && candidate.Module == member.Module)
            {
                return typed;
            }
        }

        return null;
    }

    private static void AppendMethodName(StringBuilder builder, MethodBase method)
    {
        if (method.IsConstructor)
        {
            builder.Append(method.IsStatic ? "#cctor" : "#ctor");
            return;
        }

        builder.Append(EncodeName(method.Name));
    }

    private static void AppendParameterList(StringBuilder builder, ParameterInfo[] parameters)
    {
        if (parameters.Length == 0)
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

            AppendTypeReference(builder, parameters[i].ParameterType);
        }

        builder.Append(')');
    }

    // The declaration name is the dotted, arity-backticked path with no prefix and no
    // brace-substituted type arguments — used for `T:` ids and as the container path of
    // member ids (e.g. "System.Collections.Generic.List`1").
    private static void AppendTypeDeclarationName(StringBuilder builder, Type type)
    {
        var chain = NestingChain(type);
        var outermost = chain[0];
        if (!string.IsNullOrEmpty(outermost.Namespace))
        {
            builder.Append(outermost.Namespace).Append('.');
        }

        for (var i = 0; i < chain.Count; i++)
        {
            if (i > 0)
            {
                builder.Append('.');
            }

            var level = chain[i];
            builder.Append(StripArity(level.Name));
            var arity = LevelArity(level);
            if (arity > 0)
            {
                builder.Append('`').Append(arity);
            }
        }
    }

    // A type reference as it appears in a parameter/return position: generic parameters
    // become `n (type) / ``n (method); constructed generics use brace-substituted args;
    // by-ref/array/pointer carry their suffixes.
    private static void AppendTypeReference(StringBuilder builder, Type type)
    {
        if (type.IsByRef)
        {
            AppendTypeReference(builder, type.GetElementType());
            builder.Append('@');
            return;
        }

        if (type.IsPointer)
        {
            AppendTypeReference(builder, type.GetElementType());
            builder.Append('*');
            return;
        }

        if (type.IsArray)
        {
            AppendTypeReference(builder, type.GetElementType());
            AppendArraySuffix(builder, type);
            return;
        }

        if (type.IsGenericParameter)
        {
            builder.Append(type.DeclaringMethod != null ? "``" : "`").Append(type.GenericParameterPosition);
            return;
        }

        AppendConstructedTypeReference(builder, type);
    }

    private static void AppendConstructedTypeReference(StringBuilder builder, Type type)
    {
        var chain = NestingChain(type);
        var outermost = chain[0];
        if (!string.IsNullOrEmpty(outermost.Namespace))
        {
            builder.Append(outermost.Namespace).Append('.');
        }

        var allArgs = type.IsGenericType ? type.GetGenericArguments() : Array.Empty<Type>();
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

                AppendTypeReference(builder, allArgs[consumed + a]);
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
        builder.Append('[')
            .Append(string.Join(",", Enumerable.Repeat("0:", rank)))
            .Append(']');
    }

    private static System.Collections.Generic.List<Type> NestingChain(Type type)
    {
        var chain = new System.Collections.Generic.List<Type>();
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

    // Explicit interface implementations encode the interface in the member name:
    // '.' becomes '#', and when the implemented interface is generic, reflection spells
    // its type arguments with angle brackets/commas which Roslyn mangles as '{' / '}' /
    // '@' (e.g. ICollection<KeyValuePair<TKey,TValue>>.Add becomes
    // System#Collections#Generic#ICollection{...KeyValuePair{TKey@TValue}}#Add).
    // None of '<', '>', ',' ever appear in an ordinary member name, so the uniform
    // replacement is safe for non-EII names too.
    private static string EncodeName(string name)
    {
        return name
            .Replace('.', '#')
            .Replace('<', '{')
            .Replace('>', '}')
            .Replace(',', '@');
    }
}
