// <copyright file="SymbolDisplay.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols.Display;

/// <summary>
/// Produces a classified, declaratively-formatted display of a <see cref="Symbol"/>
/// for IDE features (LSP hover, signature help, completion detail). This is the
/// single source of truth for IDE symbol rendering — the analog of Roslyn's
/// <c>ISymbolDisplayService</c> — so the language server never maintains divergent
/// ad-hoc formatters.
/// </summary>
/// <remarks>
/// This service intentionally renders a richer, IDE-oriented view than
/// <see cref="SymbolPrinter"/>, which produces the terse, classified output used by
/// diagnostics and <see cref="Symbol.ToString"/>. The two serve different audiences
/// and are not duplicate logic.
/// </remarks>
public static class SymbolDisplay
{
    /// <summary>
    /// Renders <paramref name="symbol"/> to a flat string under <paramref name="format"/>.
    /// </summary>
    /// <param name="symbol">The symbol to render.</param>
    /// <param name="format">The display options.</param>
    /// <param name="compilation">An optional compilation used to recover a variable's exact declaring keyword.</param>
    /// <returns>The rendered display string.</returns>
    public static string ToDisplayString(Symbol symbol, SymbolDisplayFormat format, Compilation.Compilation compilation = null)
    {
        return PartsToString(ToDisplayParts(symbol, format, compilation));
    }

    /// <summary>
    /// Renders an imported CLR <paramref name="clrType"/> to a flat string.
    /// </summary>
    /// <param name="clrType">The reflected CLR type.</param>
    /// <param name="format">The display options.</param>
    /// <returns>The rendered display string.</returns>
    public static string ToDisplayString(Type clrType, SymbolDisplayFormat format)
    {
        return PartsToString(ToDisplayParts(clrType, format));
    }

    /// <summary>
    /// Renders a reflected CLR <paramref name="member"/> to a flat string.
    /// </summary>
    /// <param name="member">The reflected CLR member.</param>
    /// <param name="format">The display options.</param>
    /// <returns>The rendered display string.</returns>
    public static string ToDisplayString(MemberInfo member, SymbolDisplayFormat format)
    {
        return PartsToString(ToDisplayParts(member, format));
    }

    /// <summary>
    /// Renders <paramref name="symbol"/> to classified display parts under <paramref name="format"/>.
    /// </summary>
    /// <param name="symbol">The symbol to render.</param>
    /// <param name="format">The display options.</param>
    /// <param name="compilation">An optional compilation used to recover a variable's exact declaring keyword.</param>
    /// <returns>The classified display parts.</returns>
    public static ImmutableArray<SymbolDisplayPart> ToDisplayParts(Symbol symbol, SymbolDisplayFormat format, Compilation.Compilation compilation = null)
    {
        if (symbol == null)
        {
            return ImmutableArray<SymbolDisplayPart>.Empty;
        }

        var builder = new PartBuilder();
        switch (symbol)
        {
            case ParameterSymbol parameter:
                AppendVariableLike(builder, format, SymbolDisplayPartKind.ParameterName, "parameter", parameter.Name, parameter.Type);
                break;
            case LocalVariableSymbol local:
                AppendVariableLike(builder, format, SymbolDisplayPartKind.Identifier, "local variable", local.Name, local.Type);
                break;
            case VariableSymbol variable:
                AppendGlobalVariable(builder, format, variable, compilation);
                break;
            case FunctionSymbol function:
                AppendFunction(builder, format, function);
                break;
            case StructSymbol aggregate:
                AppendAggregate(builder, format, aggregate);
                break;
            case EnumSymbol enumSymbol:
                AppendEnum(builder, format, enumSymbol);
                break;
            case EnumMemberSymbol member:
                AppendEnumMember(builder, format, member);
                break;
            case PropertySymbol property:
                AppendProperty(builder, format, property);
                break;
            case EventSymbol @event:
                AppendEvent(builder, @event);
                break;
            case FieldSymbol field:
                AppendField(builder, format, field);
                break;
            case ImportSymbol import:
                AppendImport(builder, import);
                break;
            case PackageSymbol package:
                AppendPackage(builder, package);
                break;
            case TypeSymbol type:
                builder.Keyword("type");
                builder.Space();
                builder.Type(FormatType(type));
                break;
            default:
                builder.Identifier(symbol.Name);
                break;
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Renders an imported CLR <paramref name="clrType"/> to classified display parts.
    /// </summary>
    /// <param name="clrType">The reflected CLR type.</param>
    /// <param name="format">The display options.</param>
    /// <returns>The classified display parts.</returns>
    public static ImmutableArray<SymbolDisplayPart> ToDisplayParts(Type clrType, SymbolDisplayFormat format)
    {
        var builder = new PartBuilder();
        if (clrType == null)
        {
            return builder.ToImmutable();
        }

        // ADR-0078: the aggregate kind keyword comes first.
        if (clrType.IsInterface)
        {
            builder.Keyword("interface");
        }
        else if (clrType.IsEnum)
        {
            builder.Keyword("enum");
        }
        else if (clrType.IsValueType)
        {
            if (IsByRefLikeType(clrType))
            {
                builder.Keyword("ref");
                builder.Space();
            }

            builder.Keyword("struct");
        }
        else
        {
            builder.Keyword("class");
        }

        builder.Space();
        builder.Type(FormatClrTypeName(clrType, format.QualifyNames));

        return builder.ToImmutable();
    }

    /// <summary>
    /// Renders a reflected CLR <paramref name="member"/> to classified display parts.
    /// </summary>
    /// <param name="member">The reflected CLR member.</param>
    /// <param name="format">The display options.</param>
    /// <returns>The classified display parts.</returns>
    public static ImmutableArray<SymbolDisplayPart> ToDisplayParts(MemberInfo member, SymbolDisplayFormat format)
    {
        var builder = new PartBuilder();
        switch (member)
        {
            case PropertyInfo property:
                AppendClrProperty(builder, format, property);
                break;
            case FieldInfo field:
                AppendClrField(builder, format, field);
                break;
            case EventInfo @event:
                AppendClrEvent(builder, format, @event);
                break;
            case MethodInfo method:
                AppendClrMethod(builder, format, method);
                break;
        }

        return builder.ToImmutable();
    }

    private static void AppendVariableLike(PartBuilder builder, SymbolDisplayFormat format, SymbolDisplayPartKind nameKind, string descriptor, string name, TypeSymbol type)
    {
        if (format.IncludeDescriptorPrefix)
        {
            builder.Descriptor($"({descriptor})");
            builder.Space();
        }

        builder.Add(nameKind, name);
        builder.Space();
        builder.Type(FormatType(type));
    }

    private static void AppendGlobalVariable(PartBuilder builder, SymbolDisplayFormat format, VariableSymbol variable, Compilation.Compilation compilation)
    {
        builder.Keyword(ResolveVariableKeyword(variable, compilation));
        builder.Space();
        builder.Identifier(variable.Name);
        builder.Space();
        builder.Type(FormatType(variable.Type));
    }

    private static void AppendFunction(PartBuilder builder, SymbolDisplayFormat format, FunctionSymbol function)
    {
        if (format.IncludeModifiers)
        {
            foreach (var modifier in FunctionModifiers(function))
            {
                builder.Keyword(modifier);
                builder.Space();
            }
        }

        builder.Keyword("func");
        builder.Space();

        if (format.IncludeModifiers && function.ReceiverType != null)
        {
            builder.Punctuation("(");
            builder.Type(FormatType(function.ReceiverType));
            builder.Punctuation(")");
            builder.Space();
        }

        builder.Add(SymbolDisplayPartKind.MethodName, function.Name, function);
        AppendTypeParameters(builder, function.TypeParameters);

        builder.Punctuation("(");
        for (var i = 0; i < function.Parameters.Length; i++)
        {
            if (i > 0)
            {
                builder.Punctuation(",");
                builder.Space();
            }

            builder.Add(SymbolDisplayPartKind.ParameterName, function.Parameters[i].Name);
            builder.Space();
            builder.Type(FormatType(function.Parameters[i].Type));
        }

        builder.Punctuation(")");

        if (!IsVoid(function.Type))
        {
            builder.Space();
            builder.Type(FormatType(function.Type));
        }
    }

    private static IEnumerable<string> FunctionModifiers(FunctionSymbol function)
    {
        if (function.IsStatic)
        {
            yield return "static";
        }

        if (function.IsOpen)
        {
            yield return "open";
        }

        if (function.IsOverride)
        {
            yield return "override";
        }

        if (function.IsAsync)
        {
            yield return "async";
        }
    }

    private static void AppendAggregate(PartBuilder builder, SymbolDisplayFormat format, StructSymbol aggregate)
    {
        // ADR-0078: the aggregate kind keyword IS the declaration head.
        // Render as `[ref]? [data]? [inline]? [open|sealed]? (class|struct) Name [TParams]? { fields }?`.
        if (aggregate.IsRefStruct)
        {
            builder.Keyword("ref");
            builder.Space();
        }

        if (aggregate.IsData)
        {
            builder.Keyword("data");
            builder.Space();
        }

        if (aggregate.IsInline)
        {
            builder.Keyword("inline");
            builder.Space();
        }

        builder.Keyword(aggregate.IsClass ? "class" : "struct");
        builder.Space();
        builder.Type(QualifiedName(format, aggregate.PackageName, aggregate.Name));
        AppendTypeParameters(builder, aggregate.TypeParameters);

        if (!aggregate.Fields.IsEmpty)
        {
            builder.Space();
            builder.Punctuation("{");
            builder.Space();
            for (var i = 0; i < aggregate.Fields.Length; i++)
            {
                if (i > 0)
                {
                    builder.Punctuation(";");
                    builder.Space();
                }

                builder.Keyword(aggregate.Fields[i].IsReadOnly ? "let" : "var");
                builder.Space();
                builder.Add(SymbolDisplayPartKind.FieldName, aggregate.Fields[i].Name);
                builder.Space();
                builder.Type(FormatType(aggregate.Fields[i].Type));
            }

            builder.Space();
            builder.Punctuation("}");
        }
    }

    private static void AppendEnum(PartBuilder builder, SymbolDisplayFormat format, EnumSymbol enumSymbol)
    {
        builder.Keyword("enum");
        builder.Space();
        builder.Type(QualifiedName(format, enumSymbol.PackageName, enumSymbol.Name));
        builder.Space();
        builder.Punctuation("{");
        builder.Space();
        for (var i = 0; i < enumSymbol.Members.Length; i++)
        {
            if (i > 0)
            {
                builder.Punctuation(",");
                builder.Space();
            }

            builder.Add(SymbolDisplayPartKind.EnumMemberName, enumSymbol.Members[i].Name);
        }

        builder.Space();
        builder.Punctuation("}");
    }

    private static void AppendEnumMember(PartBuilder builder, SymbolDisplayFormat format, EnumMemberSymbol member)
    {
        builder.Type(member.EnumType.Name);
        builder.Punctuation(".");
        builder.Add(SymbolDisplayPartKind.EnumMemberName, member.Name);
        if (format.IncludeConstantValue)
        {
            builder.Space();
            builder.Punctuation("=");
            builder.Space();
            builder.Add(SymbolDisplayPartKind.NumericLiteral, member.Value.ToString(CultureInfo.InvariantCulture));
        }
    }

    private static void AppendProperty(PartBuilder builder, SymbolDisplayFormat format, PropertySymbol property)
    {
        builder.Keyword("prop");
        builder.Space();
        builder.Add(SymbolDisplayPartKind.PropertyName, property.Name);
        builder.Space();
        builder.Type(FormatType(property.Type));
        if (format.IncludePropertyAccessors)
        {
            builder.Space();
            builder.Punctuation("{");
            if (property.HasGetter)
            {
                builder.Space();
                builder.Keyword("get");
                builder.Punctuation(";");
            }

            if (property.HasSetter)
            {
                builder.Space();
                builder.Keyword("set");
                builder.Punctuation(";");
            }

            builder.Space();
            builder.Punctuation("}");
        }
    }

    private static void AppendEvent(PartBuilder builder, EventSymbol @event)
    {
        builder.Keyword("event");
        builder.Space();
        builder.Identifier(@event.Name);
        builder.Space();
        builder.Type(FormatType(@event.Type));
    }

    private static void AppendField(PartBuilder builder, SymbolDisplayFormat format, FieldSymbol field)
    {
        if (format.IncludeDescriptorPrefix)
        {
            builder.Descriptor("(field)");
            builder.Space();
        }

        builder.Add(SymbolDisplayPartKind.FieldName, field.Name);
        builder.Space();
        builder.Type(FormatType(field.Type));
    }

    private static void AppendImport(PartBuilder builder, ImportSymbol import)
    {
        builder.Keyword("import");
        builder.Space();
        if (import.IsAlias)
        {
            builder.Add(SymbolDisplayPartKind.AliasName, import.Name);
            builder.Space();
            builder.Punctuation("=");
            builder.Space();
        }

        builder.Add(SymbolDisplayPartKind.NamespaceName, import.Target);
    }

    private static void AppendPackage(PartBuilder builder, PackageSymbol package)
    {
        builder.Keyword("package");
        builder.Space();
        builder.Add(SymbolDisplayPartKind.NamespaceName, package.Name);
    }

    private static void AppendTypeParameters(PartBuilder builder, ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        if (typeParameters.IsDefaultOrEmpty)
        {
            return;
        }

        builder.Punctuation("<");
        for (var i = 0; i < typeParameters.Length; i++)
        {
            if (i > 0)
            {
                builder.Punctuation(",");
                builder.Space();
            }

            builder.Type(typeParameters[i].Name);
        }

        builder.Punctuation(">");
    }

    private static void AppendClrProperty(PartBuilder builder, SymbolDisplayFormat format, PropertyInfo property)
    {
        builder.Add(SymbolDisplayPartKind.PropertyName, FormatClrMemberName(property.DeclaringType, property.Name, format));
        builder.Space();
        builder.Type(FormatClrTypeName(property.PropertyType, format.QualifyNames));
        if (format.IncludePropertyAccessors)
        {
            builder.Space();
            builder.Punctuation("{");
            if (property.CanRead)
            {
                builder.Space();
                builder.Keyword("get");
                builder.Punctuation(";");
            }

            if (property.CanWrite)
            {
                builder.Space();
                builder.Keyword("set");
                builder.Punctuation(";");
            }

            builder.Space();
            builder.Punctuation("}");
        }
    }

    private static void AppendClrField(PartBuilder builder, SymbolDisplayFormat format, FieldInfo field)
    {
        builder.Add(SymbolDisplayPartKind.FieldName, FormatClrMemberName(field.DeclaringType, field.Name, format));
        builder.Space();
        builder.Type(FormatClrTypeName(field.FieldType, format.QualifyNames));
    }

    private static void AppendClrEvent(PartBuilder builder, SymbolDisplayFormat format, EventInfo @event)
    {
        builder.Keyword("event");
        builder.Space();
        builder.Add(SymbolDisplayPartKind.Identifier, FormatClrMemberName(@event.DeclaringType, @event.Name, format));
        builder.Space();
        builder.Type(FormatClrTypeName(@event.EventHandlerType, format.QualifyNames));
    }

    private static void AppendClrMethod(PartBuilder builder, SymbolDisplayFormat format, MethodInfo method)
    {
        // ADR-0023 parity: a CLR method compiled from `async`/`await` exposes a
        // `Task[R]` (or `ValueTask[R]`) return in metadata, but G# renders async
        // functions as `async func ... R` with the awaited result type. Mirror
        // that here so an imported `async Task<R> M(...)` hovers as
        // `async func (T) M(...) R` rather than the leaked `func ... Task[R]`.
        var isAsync = format.IncludeModifiers && IsClrAsyncMethod(method);
        if (isAsync)
        {
            builder.Keyword("async");
            builder.Space();
        }

        builder.Keyword("func");
        builder.Space();

        if (format.QualifyNames && method.DeclaringType != null)
        {
            builder.Punctuation("(");
            builder.Type(FormatClrTypeName(method.DeclaringType, qualifyNames: true));
            builder.Punctuation(")");
            builder.Space();
        }

        builder.Add(SymbolDisplayPartKind.MethodName, method.Name);
        builder.Punctuation("(");
        var parameters = method.GetParameters();
        for (var i = 0; i < parameters.Length; i++)
        {
            if (i > 0)
            {
                builder.Punctuation(",");
                builder.Space();
            }

            builder.Add(SymbolDisplayPartKind.ParameterName, parameters[i].Name);
            builder.Space();
            builder.Type(FormatClrTypeName(parameters[i].ParameterType, format.QualifyNames));
        }

        builder.Punctuation(")");

        var returnType = isAsync ? UnwrapTaskReturnType(method.ReturnType) : method.ReturnType;
        if (!returnType.IsSameAs(typeof(void)))
        {
            builder.Space();
            builder.Type(FormatClrTypeName(returnType, format.QualifyNames));
        }
    }

    /// <summary>
    /// Returns <c>true</c> when a reflected CLR method was compiled from an
    /// <c>async</c> method (carries <c>AsyncStateMachineAttribute</c>). Uses
    /// <see cref="MemberInfo.GetCustomAttributesData"/> rather than the generic
    /// <c>GetCustomAttribute&lt;T&gt;()</c> so it works for methods loaded
    /// through a <c>MetadataLoadContext</c> (the production <c>gsc</c> reference
    /// path), where reflection-only types cannot be matched by runtime identity.
    /// </summary>
    private static bool IsClrAsyncMethod(MethodInfo method)
    {
        foreach (var attribute in method.GetCustomAttributesData())
        {
            if (attribute.AttributeType?.FullName == "System.Runtime.CompilerServices.AsyncStateMachineAttribute")
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Unwraps the awaited result type of an async return: <c>Task[R]</c> /
    /// <c>ValueTask[R]</c> resolve to <c>R</c>, the non-generic <c>Task</c> /
    /// <c>ValueTask</c> resolve to <c>void</c>, and any other shape (e.g. an
    /// async <c>IAsyncEnumerable[T]</c> iterator, or <c>async void</c>) is
    /// returned unchanged. FullName matching keeps this correct under a
    /// <c>MetadataLoadContext</c>.
    /// </summary>
    private static Type UnwrapTaskReturnType(Type returnType)
    {
        if (returnType == null)
        {
            return null;
        }

        if (returnType.IsGenericType && !returnType.IsGenericTypeDefinition)
        {
            var definitionName = returnType.GetGenericTypeDefinition()?.FullName;
            if (definitionName == "System.Threading.Tasks.Task`1"
                || definitionName == "System.Threading.Tasks.ValueTask`1")
            {
                return returnType.GetGenericArguments()[0];
            }

            return returnType;
        }

        return returnType.FullName == "System.Threading.Tasks.Task"
            || returnType.FullName == "System.Threading.Tasks.ValueTask"
            ? typeof(void)
            : returnType;
    }

    private static string QualifiedName(SymbolDisplayFormat format, string packageName, string name)
    {
        // "Default" is G#'s implicit package (the analog of C#'s global namespace);
        // qualifying with it is noise, so it is treated as unqualified.
        return format.QualifyNames && !string.IsNullOrEmpty(packageName) && packageName != "Default"
            ? $"{packageName}.{name}"
            : name;
    }

    private static string FormatType(TypeSymbol type)
    {
        if (type == null || IsVoid(type))
        {
            return "void";
        }

        // Reconstruct the display name from the type's structure rather than
        // returning the raw TypeSymbol.Name. For constructed generics backed by
        // a CLR type (e.g. Task[string]) that raw name is the assembly-qualified
        // Type.FullName (`System.Threading.Tasks.Task`1[[System.String, ...]]`),
        // which leaks into hover. Recursing also keeps wrapper syntax in G# form
        // (`[]T`, `T?`, `sequence[T]`, ...) while rendering imported element
        // types nicely.
        switch (type)
        {
            case NullableTypeSymbol nullable:
                // Issue #2160: a nullable function type must wrap the whole
                // arrow shape in parentheses so the `?` applies to the function
                // type and not just its return type (`((int32) -> void)?`,
                // never `(int32) -> void?`). Because FormatType recurses,
                // parenthesizing here also fixes nested occurrences (slice
                // element, generic arg, tuple element). Non-function nullable
                // types are rendered unchanged.
                var underlying = FormatType(nullable.UnderlyingType);
                return nullable.UnderlyingType is FunctionTypeSymbol
                    ? $"({underlying})?"
                    : $"{underlying}?";
            case FunctionTypeSymbol function:
                return FormatFunctionType(function);
            case SliceTypeSymbol slice:
                return $"[]{FormatType(slice.ElementType)}";
            case AsyncSequenceTypeSymbol asyncSequence:
                return $"sequence[{FormatType(asyncSequence.ElementType)}]";
            case SequenceTypeSymbol sequence:
                return $"sequence[{FormatType(sequence.ElementType)}]";
            case MapTypeSymbol map:
                return $"map[{FormatType(map.KeyType)},{FormatType(map.ValueType)}]";
            case TupleTypeSymbol tuple:
                return $"({string.Join(", ", tuple.ElementTypes.Select(FormatType))})";
            case ImportedTypeSymbol imported:
                return FormatImportedType(imported);
            default:
                return type.Name;
        }
    }

    /// <summary>
    /// Renders a <see cref="FunctionTypeSymbol"/> in its canonical arrow shape
    /// <c>(P1, P2, ...) -> R</c> (ADR-0075 / issue #715), recursing through
    /// <see cref="FormatType"/> so nested imported/wrapper element types render
    /// consistently. A trailing variadic parameter is rendered with the
    /// <c>...</c> prefix and its element type (ADR-0102 follow-up / issue #818),
    /// and a void return renders as <c>void</c>.
    /// </summary>
    private static string FormatFunctionType(FunctionTypeSymbol function)
    {
        var hasVariadicFlags = !function.IsVariadic.IsDefaultOrEmpty;
        var sb = new System.Text.StringBuilder();
        sb.Append('(');
        for (var i = 0; i < function.ParameterTypes.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(", ");
            }

            if (hasVariadicFlags && function.IsVariadic[i])
            {
                sb.Append("...");
                sb.Append(function.ParameterTypes[i] is SliceTypeSymbol slice
                    ? FormatType(slice.ElementType)
                    : FormatType(function.ParameterTypes[i]));
            }
            else
            {
                sb.Append(FormatType(function.ParameterTypes[i]));
            }
        }

        sb.Append(") -> ");
        sb.Append(FormatType(function.ReturnType));
        return sb.ToString();
    }

    /// <summary>
    /// Renders an <see cref="ImportedTypeSymbol"/> with a friendly, G#-flavored
    /// name. A plain imported type is formatted from its CLR <see cref="Type"/>
    /// (so constructed generics become <c>Outer[Arg]</c> and primitives map to
    /// their G# spellings). A #313 symbolic construction — whose CLR form is
    /// type-erased to <c>object</c> — is rebuilt from its open definition plus
    /// the symbolic <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// </summary>
    private static string FormatImportedType(ImportedTypeSymbol imported)
    {
        if (!imported.TypeArguments.IsDefaultOrEmpty)
        {
            var definition = imported.OpenDefinition;
            var baseName = StripGenericArity(definition?.FullName ?? definition?.Name) ?? imported.Name;
            var args = string.Join(", ", imported.TypeArguments.Select(a => a == null ? "?" : FormatType(a)));
            return $"{baseName}[{args}]";
        }

        return FormatClrTypeName(imported.ClrType, qualifyNames: true);
    }

    /// <summary>
    /// Strips the CLR generic-arity suffix (<c>`1</c>) and normalizes nested
    /// type separators (<c>+</c> to <c>.</c>) from a reflected type name.
    /// </summary>
    private static string StripGenericArity(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        var tickIndex = name.IndexOf('`');
        if (tickIndex >= 0)
        {
            name = name.Substring(0, tickIndex);
        }

        return name.Replace('+', '.');
    }

    private static string FormatClrMemberName(Type declaringType, string name, SymbolDisplayFormat format)
    {
        return format.QualifyNames && declaringType != null
            ? $"{FormatClrTypeName(declaringType, qualifyNames: true)}.{name}"
            : name;
    }

    private static string FormatClrTypeName(Type clrType, bool qualifyNames)
    {
        if (clrType == null)
        {
            return "void";
        }

        if (clrType.IsSameAs(typeof(void)))
        {
            return "void";
        }

        // Map CLR primitives to G# type names.
        if (TryGetGSharpPrimitiveName(clrType, out var primitiveName))
        {
            return primitiveName;
        }

        if (clrType.IsByRef)
        {
            return $"{FormatClrTypeName(clrType.GetElementType(), qualifyNames)}@";
        }

        if (clrType.IsArray)
        {
            return $"{FormatClrTypeName(clrType.GetElementType(), qualifyNames)}[]";
        }

        if (clrType.IsPointer)
        {
            return $"{FormatClrTypeName(clrType.GetElementType(), qualifyNames)}*";
        }

        if (clrType.IsGenericParameter)
        {
            return clrType.Name;
        }

        if (!clrType.IsGenericType)
        {
            return qualifyNames ? (clrType.FullName ?? clrType.Name).Replace('+', '.') : clrType.Name;
        }

        var typeName = clrType.IsNested ? clrType.Name : (qualifyNames ? clrType.FullName ?? clrType.Name : clrType.Name);
        var tickIndex = typeName.IndexOf('`');
        if (tickIndex >= 0)
        {
            typeName = typeName.Substring(0, tickIndex);
        }

        typeName = typeName.Replace('+', '.');
        var args = clrType.GetGenericArguments();
        return $"{typeName}[{string.Join(", ", args.Select(a => FormatClrTypeName(a, qualifyNames)))}]";
    }

    private static bool TryGetGSharpPrimitiveName(Type clrType, out string name)
    {
        if (clrType.IsSameAs(typeof(bool)))
        {
            name = "bool";
            return true;
        }

        if (clrType.IsSameAs(typeof(byte)))
        {
            name = "uint8";
            return true;
        }

        if (clrType.IsSameAs(typeof(sbyte)))
        {
            name = "int8";
            return true;
        }

        if (clrType.IsSameAs(typeof(short)))
        {
            name = "int16";
            return true;
        }

        if (clrType.IsSameAs(typeof(ushort)))
        {
            name = "uint16";
            return true;
        }

        if (clrType.IsSameAs(typeof(int)))
        {
            name = "int32";
            return true;
        }

        if (clrType.IsSameAs(typeof(uint)))
        {
            name = "uint32";
            return true;
        }

        if (clrType.IsSameAs(typeof(long)))
        {
            name = "int64";
            return true;
        }

        if (clrType.IsSameAs(typeof(ulong)))
        {
            name = "uint64";
            return true;
        }

        if (clrType.IsSameAs(typeof(nint)))
        {
            name = "nint";
            return true;
        }

        if (clrType.IsSameAs(typeof(nuint)))
        {
            name = "nuint";
            return true;
        }

        if (clrType.IsSameAs(typeof(float)))
        {
            name = "float32";
            return true;
        }

        if (clrType.IsSameAs(typeof(double)))
        {
            name = "float64";
            return true;
        }

        if (clrType.IsSameAs(typeof(decimal)))
        {
            name = "decimal";
            return true;
        }

        if (clrType.IsSameAs(typeof(char)))
        {
            name = "char";
            return true;
        }

        if (clrType.IsSameAs(typeof(string)))
        {
            name = "string";
            return true;
        }

        if (clrType.IsSameAs(typeof(object)))
        {
            name = "object";
            return true;
        }

        name = null;
        return false;
    }

    private static bool IsByRefLikeType(Type type)
    {
        // System.Runtime.CompilerServices.IsByRefLikeAttribute is present on ref structs.
        // Use GetCustomAttributesData (metadata-only) rather than GetCustomAttributes
        // (which instantiates attribute objects). The latter throws under a
        // MetadataLoadContext — the LSP loads references that way so it sees
        // target-framework-bound assemblies (see ReferenceResolver.WithReferences).
        if (!type.IsValueType)
        {
            return false;
        }

        try
        {
            foreach (var attr in type.GetCustomAttributesData())
            {
                if (attr.AttributeType?.FullName == "System.Runtime.CompilerServices.IsByRefLikeAttribute")
                {
                    return true;
                }
            }
        }
        catch (Exception)
        {
            // Some loaders/assemblies can throw when enumerating metadata; degrade gracefully.
        }

        return false;
    }

    private static bool IsVoid(TypeSymbol type)
    {
        return type == null || ReferenceEquals(type, TypeSymbol.Void);
    }

    private static string ResolveVariableKeyword(VariableSymbol variable, Compilation.Compilation compilation)
    {
        if (compilation != null && variable.DeclaringSyntax is SyntaxToken identifier)
        {
            foreach (var tree in compilation.SyntaxTrees)
            {
                foreach (var declaration in FindVariableDeclarations(tree.Root))
                {
                    if (ReferenceEquals(declaration.Identifier, identifier)
                        || (declaration.Identifier.Span.Start == identifier.Span.Start
                            && declaration.Identifier.Span.Length == identifier.Span.Length
                            && declaration.Identifier.Text == identifier.Text))
                    {
                        var keyword = declaration.Keyword?.Text;
                        if (!string.IsNullOrEmpty(keyword))
                        {
                            return keyword;
                        }
                    }
                }
            }
        }

        return variable.IsReadOnly ? "let" : "var";
    }

    private static IEnumerable<VariableDeclarationSyntax> FindVariableDeclarations(SyntaxNode node)
    {
        if (node is VariableDeclarationSyntax declaration)
        {
            yield return declaration;
        }

        foreach (var child in node.GetChildren())
        {
            foreach (var descendant in FindVariableDeclarations(child))
            {
                yield return descendant;
            }
        }
    }

    private static string PartsToString(ImmutableArray<SymbolDisplayPart> parts)
    {
        return string.Concat(parts.Select(p => p.Text));
    }

    private sealed class PartBuilder
    {
        private readonly ImmutableArray<SymbolDisplayPart>.Builder parts = ImmutableArray.CreateBuilder<SymbolDisplayPart>();

        public void Add(SymbolDisplayPartKind kind, string text, Symbol symbol = null) => this.parts.Add(new SymbolDisplayPart(kind, text, symbol));

        public void Keyword(string text) => this.Add(SymbolDisplayPartKind.Keyword, text);

        public void Identifier(string text) => this.Add(SymbolDisplayPartKind.Identifier, text);

        public void Type(string text) => this.Add(SymbolDisplayPartKind.TypeName, text);

        public void Punctuation(string text) => this.Add(SymbolDisplayPartKind.Punctuation, text);

        public void Descriptor(string text) => this.Add(SymbolDisplayPartKind.Descriptor, text);

        public void Space() => this.Add(SymbolDisplayPartKind.Space, " ");

        public ImmutableArray<SymbolDisplayPart> ToImmutable() => this.parts.ToImmutable();
    }
}
