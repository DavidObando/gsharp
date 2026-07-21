// <copyright file="GsStubRenderer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §B: renders a bound G# global scope into a single declaration-only
/// C# compilation unit ("stub"). The stub carries every user-declared type with
/// its accessibility, base clause, generics/constraints, member signatures, and
/// — critically — every symbol's attributes spelled by fully-qualified CLR
/// metadata name, which is exactly what a Roslyn incremental generator matches
/// on via <c>ForAttributeWithMetadataName</c>. All member bodies are elided
/// (<c>=&gt; throw null!</c>).
/// <para>
/// The correctness bar is that the emitted text re-parses as valid C#; it is
/// never compiled to a runnable assembly.
/// </para>
/// </summary>
public sealed class GsStubRenderer
{
    private readonly GsToCSharpTypeSpeller speller;
    private readonly List<string> notes = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="GsStubRenderer"/> class.
    /// </summary>
    public GsStubRenderer()
        : this(new GsToCSharpTypeSpeller())
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="GsStubRenderer"/> class with
    /// a shared type speller.
    /// </summary>
    /// <param name="speller">The type speller whose fallbacks accumulate across the render.</param>
    public GsStubRenderer(GsToCSharpTypeSpeller speller)
    {
        this.speller = speller ?? throw new ArgumentNullException(nameof(speller));
    }

    /// <summary>
    /// Gets the type-spelling fallbacks accumulated during the last render
    /// (ADR-0145 §H / <c>GS9204</c>).
    /// </summary>
    public IReadOnlyList<string> Fallbacks => speller.Fallbacks;

    /// <summary>
    /// Gets the human-readable notes for arguments/members that could not be
    /// projected faithfully (e.g. an unrenderable attribute argument that was
    /// omitted).
    /// </summary>
    public IReadOnlyList<string> Notes => notes;

    /// <summary>
    /// Renders the C# stub for every user-declared type in <paramref name="scope"/>.
    /// </summary>
    /// <param name="scope">The bound global scope to project.</param>
    /// <returns>A single C# compilation-unit string, prefixed with <c>#nullable enable</c>.</returns>
    public string RenderStub(BoundGlobalScope scope)
    {
        if (scope == null)
        {
            throw new ArgumentNullException(nameof(scope));
        }

        var builder = new StringBuilder();
        builder.AppendLine("#nullable enable");

        // Group every top-level user type by its package (namespace). A type
        // nested inside another type is rendered by its enclosing type; skip it
        // at the namespace level (v1: top-level only).
        var byPackage = new SortedDictionary<string, List<Action<StringBuilder, string>>>(StringComparer.Ordinal);

        void AddType(string packageName, Action<StringBuilder, string> emit)
        {
            var key = packageName ?? string.Empty;
            if (!byPackage.TryGetValue(key, out var list))
            {
                list = new List<Action<StringBuilder, string>>();
                byPackage[key] = list;
            }

            list.Add(emit);
        }

        foreach (var structSymbol in scope.Structs)
        {
            if (SkipType(structSymbol.Name) || structSymbol.ContainingType != null)
            {
                continue;
            }

            AddType(structSymbol.PackageName, (sb, indent) => RenderStruct(sb, indent, structSymbol));
        }

        foreach (var iface in scope.Interfaces)
        {
            if (SkipType(iface.Name) || iface.ContainingType != null)
            {
                continue;
            }

            AddType(iface.PackageName, (sb, indent) => RenderInterface(sb, indent, iface));
        }

        foreach (var enumSymbol in scope.Enums)
        {
            if (SkipType(enumSymbol.Name) || enumSymbol.ContainingType != null)
            {
                continue;
            }

            AddType(enumSymbol.PackageName, (sb, indent) => RenderEnum(sb, indent, enumSymbol));
        }

        foreach (var del in scope.Delegates)
        {
            if (SkipType(del.Name))
            {
                continue;
            }

            AddType(del.PackageName, (sb, indent) => RenderDelegate(sb, indent, del));
        }

        foreach (var pair in byPackage)
        {
            var packageName = pair.Key;
            var hasNamespace = !string.IsNullOrEmpty(packageName);
            var indent = hasNamespace ? "    " : string.Empty;

            if (hasNamespace)
            {
                builder.Append("namespace ").AppendLine(packageName);
                builder.AppendLine("{");
            }

            var first = true;
            foreach (var emit in pair.Value)
            {
                if (!first)
                {
                    builder.AppendLine();
                }

                first = false;
                emit(builder, indent);
            }

            if (hasNamespace)
            {
                builder.AppendLine("}");
            }
        }

        return builder.ToString();
    }

    private static bool SkipType(string name) =>
        string.IsNullOrEmpty(name) || name.IndexOf('<') >= 0 || name.IndexOf('$') >= 0;

    private static string AccessibilityKeyword(Accessibility accessibility) => accessibility switch
    {
        Accessibility.Public => "public",
        Accessibility.Internal => "internal",
        Accessibility.Private => "private",
        Accessibility.Protected => "protected",
        _ => "internal",
    };

    private void RenderStruct(StringBuilder sb, string indent, StructSymbol structSymbol)
    {
        RenderAttributes(sb, indent, structSymbol.Attributes);

        sb.Append(indent).Append(AccessibilityKeyword(structSymbol.Accessibility)).Append(' ');
        if (structSymbol.Declaration?.IsPartial ?? false)
        {
            sb.Append("partial ");
        }

        sb.Append(structSymbol.IsClass ? "class " : "struct ");
        sb.Append(structSymbol.Name);
        sb.Append(RenderTypeParameters(structSymbol.TypeParameters));

        var bases = CollectBaseTypes(structSymbol);
        if (bases.Count > 0)
        {
            sb.Append(" : ").Append(string.Join(", ", bases));
        }

        sb.Append(RenderConstraints(structSymbol.TypeParameters));
        sb.AppendLine();
        sb.Append(indent).AppendLine("{");

        var memberIndent = indent + "    ";
        RenderConstFields(sb, memberIndent, structSymbol.ConstFields);
        RenderFields(sb, memberIndent, structSymbol.Fields, isStatic: false);
        RenderFields(sb, memberIndent, structSymbol.StaticFields, isStatic: true);
        RenderProperties(sb, memberIndent, structSymbol.Properties, isStatic: false);
        RenderProperties(sb, memberIndent, structSymbol.StaticProperties, isStatic: true);
        RenderEvents(sb, memberIndent, structSymbol.Events, isStatic: false);
        RenderEvents(sb, memberIndent, structSymbol.StaticEvents, isStatic: true);
        RenderConstructors(sb, memberIndent, structSymbol);
        RenderMethods(sb, memberIndent, structSymbol.Methods, isStatic: false);
        RenderMethods(sb, memberIndent, structSymbol.StaticMethods, isStatic: true);

        sb.Append(indent).AppendLine("}");
    }

    private List<string> CollectBaseTypes(StructSymbol structSymbol)
    {
        var bases = new List<string>();
        if (structSymbol.IsClass)
        {
            if (structSymbol.BaseClass != null)
            {
                bases.Add(speller.Spell(structSymbol.BaseClass));
            }
            else if (structSymbol.ImportedBaseType != null)
            {
                bases.Add(speller.Spell(structSymbol.ImportedBaseType));
            }
        }

        if (!structSymbol.Interfaces.IsDefaultOrEmpty)
        {
            bases.AddRange(structSymbol.Interfaces.Select(i => speller.Spell(i)));
        }

        if (!structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            bases.AddRange(structSymbol.ImplementedClrInterfaces.Select(i => speller.Spell(i)));
        }

        return bases;
    }

    private void RenderInterface(StringBuilder sb, string indent, InterfaceSymbol iface)
    {
        RenderAttributes(sb, indent, iface.Attributes);

        sb.Append(indent).Append(AccessibilityKeyword(iface.Accessibility)).Append(' ');
        if (iface.Declaration?.IsPartial ?? false)
        {
            sb.Append("partial ");
        }

        sb.Append("interface ").Append(iface.Name);
        sb.Append(RenderTypeParameters(iface.TypeParameters));

        var bases = new List<string>();
        if (!iface.BaseInterfaces.IsDefaultOrEmpty)
        {
            bases.AddRange(iface.BaseInterfaces.Select(i => speller.Spell(i)));
        }

        if (!iface.BaseClrInterfaces.IsDefaultOrEmpty)
        {
            bases.AddRange(iface.BaseClrInterfaces.Select(i => speller.Spell(i)));
        }

        if (bases.Count > 0)
        {
            sb.Append(" : ").Append(string.Join(", ", bases));
        }

        sb.Append(RenderConstraints(iface.TypeParameters));
        sb.AppendLine();
        sb.Append(indent).AppendLine("{");

        var memberIndent = indent + "    ";
        RenderProperties(sb, memberIndent, iface.Properties, isStatic: false);
        RenderEvents(sb, memberIndent, iface.Events, isStatic: false);
        RenderMethods(sb, memberIndent, iface.Methods, isStatic: false);
        RenderMethods(sb, memberIndent, iface.StaticMethods, isStatic: true);

        sb.Append(indent).AppendLine("}");
    }

    private void RenderEnum(StringBuilder sb, string indent, EnumSymbol enumSymbol)
    {
        RenderAttributes(sb, indent, enumSymbol.Attributes);

        sb.Append(indent).Append(AccessibilityKeyword(enumSymbol.Accessibility)).Append(" enum ").Append(enumSymbol.Name);
        sb.AppendLine();
        sb.Append(indent).AppendLine("{");

        var memberIndent = indent + "    ";
        foreach (var member in enumSymbol.Members)
        {
            RenderAttributes(sb, memberIndent, member.Attributes);
            sb.Append(memberIndent).Append(member.Name).Append(" = ")
              .Append(member.Value.ToString(CultureInfo.InvariantCulture)).AppendLine(",");
        }

        sb.Append(indent).AppendLine("}");
    }

    private void RenderDelegate(StringBuilder sb, string indent, DelegateTypeSymbol del)
    {
        RenderAttributes(sb, indent, del.Attributes);

        sb.Append(indent).Append(AccessibilityKeyword(del.Accessibility)).Append(" delegate ");
        sb.Append(del.ReturnType == null || del.ReturnType == TypeSymbol.Void ? "void" : speller.Spell(del.ReturnType));
        sb.Append(' ').Append(del.Name);
        sb.Append(RenderTypeParameters(del.TypeParameters));
        sb.Append('(').Append(RenderParameters(del.Parameters)).Append(')');
        sb.Append(RenderConstraints(del.TypeParameters));
        sb.AppendLine(";");
    }

    private void RenderConstFields(StringBuilder sb, string indent, ImmutableArray<FieldSymbol> fields)
    {
        if (fields.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var field in fields)
        {
            RenderAttributes(sb, indent, field.Attributes);
            sb.Append(indent).Append(AccessibilityKeyword(field.Accessibility)).Append(" const ");
            sb.Append(speller.Spell(field.Type)).Append(' ').Append(field.Name).Append(" = ");
            sb.Append(RenderConstant(field.ConstantValue, field.Type) ?? "default").AppendLine(";");
        }
    }

    private void RenderFields(StringBuilder sb, string indent, ImmutableArray<FieldSymbol> fields, bool isStatic)
    {
        if (fields.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var field in fields)
        {
            if (field.IsConst)
            {
                continue;
            }

            RenderAttributes(sb, indent, field.Attributes);
            sb.Append(indent).Append(AccessibilityKeyword(field.Accessibility)).Append(' ');
            if (isStatic || field.IsStatic)
            {
                sb.Append("static ");
            }

            if (field.IsReadOnly)
            {
                sb.Append("readonly ");
            }

            sb.Append(speller.Spell(field.Type)).Append(' ').Append(field.Name).AppendLine(";");
        }
    }

    private void RenderProperties(StringBuilder sb, string indent, ImmutableArray<PropertySymbol> properties, bool isStatic)
    {
        if (properties.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var property in properties)
        {
            RenderAttributes(sb, indent, property.Attributes);
            sb.Append(indent).Append(AccessibilityKeyword(property.Accessibility)).Append(' ');
            if (isStatic || property.IsStatic)
            {
                sb.Append("static ");
            }

            sb.Append(speller.Spell(property.Type)).Append(' ').Append(property.Name).Append(" { ");
            if (property.HasGetter)
            {
                sb.Append("get => throw null!; ");
            }

            if (property.HasSetter)
            {
                sb.Append(property.IsInitOnly ? "init { } " : "set { } ");
            }

            sb.AppendLine("}");
        }
    }

    private void RenderEvents(StringBuilder sb, string indent, ImmutableArray<EventSymbol> events, bool isStatic)
    {
        if (events.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var evt in events)
        {
            RenderAttributes(sb, indent, evt.Attributes);
            sb.Append(indent).Append(AccessibilityKeyword(evt.Accessibility)).Append(' ');
            if (isStatic || evt.IsStatic)
            {
                sb.Append("static ");
            }

            sb.Append("event ").Append(speller.Spell(evt.Type)).Append(' ').Append(evt.Name).AppendLine(";");
        }
    }

    private void RenderConstructors(StringBuilder sb, string indent, StructSymbol structSymbol)
    {
        if (structSymbol.ExplicitConstructors.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var ctor in structSymbol.ExplicitConstructors)
        {
            var function = ctor.Function;
            RenderAttributes(sb, indent, function?.Attributes ?? ImmutableArray<BoundAttribute>.Empty);
            var accessibility = function?.Accessibility ?? Accessibility.Public;
            sb.Append(indent).Append(AccessibilityKeyword(accessibility)).Append(' ');
            sb.Append(structSymbol.Name).Append('(').Append(RenderParameters(ctor.Parameters)).Append(')');

            // A value struct cannot carry a body-less expression ctor; give it an
            // empty block. Classes get the elided throwing body.
            sb.AppendLine(structSymbol.IsClass ? " => throw null!;" : " { }");
        }
    }

    private void RenderMethods(StringBuilder sb, string indent, ImmutableArray<FunctionSymbol> methods, bool isStatic)
    {
        if (methods.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var method in methods)
        {
            if (SkipType(method.Name))
            {
                continue;
            }

            RenderAttributes(sb, indent, method.Attributes);
            sb.Append(indent).Append(AccessibilityKeyword(method.Accessibility)).Append(' ');
            if (isStatic || method.IsStatic)
            {
                sb.Append("static ");
            }

            var isVoid = method.Type == null || method.Type == TypeSymbol.Void;
            sb.Append(RenderMethodReturnType(method, isVoid)).Append(' ').Append(method.Name);
            sb.Append(RenderTypeParameters(method.TypeParameters));
            sb.Append('(').Append(RenderParameters(method.Parameters)).Append(')');
            sb.Append(RenderConstraints(method.TypeParameters));
            sb.AppendLine(isVoid && !method.IsAsync ? " { }" : " => throw null!;");
        }
    }

    private string RenderMethodReturnType(FunctionSymbol method, bool isVoid)
    {
        if (!method.IsAsync)
        {
            return isVoid ? "void" : speller.Spell(method.Type);
        }

        var wrapper = method.AsyncReturnsValueTask
            ? "global::System.Threading.Tasks.ValueTask"
            : "global::System.Threading.Tasks.Task";
        return isVoid ? wrapper : wrapper + "<" + speller.Spell(method.Type) + ">";
    }

    private string RenderParameters(ImmutableArray<ParameterSymbol> parameters)
    {
        if (parameters.IsDefaultOrEmpty)
        {
            return string.Empty;
        }

        var parts = new List<string>(parameters.Length);
        foreach (var parameter in parameters)
        {
            var builder = new StringBuilder();
            switch (parameter.RefKind)
            {
                case RefKind.Ref:
                    builder.Append("ref ");
                    break;
                case RefKind.Out:
                    builder.Append("out ");
                    break;
                case RefKind.In:
                    builder.Append("in ");
                    break;
            }

            if (parameter.IsVariadic && parameter.Type is SliceTypeSymbol slice)
            {
                // `params T[]` — a params parameter must be an array, not the
                // Span shape a bare slice would otherwise spell to.
                builder.Append("params ").Append(speller.Spell(slice.ElementType)).Append("[] ");
            }
            else
            {
                builder.Append(speller.Spell(parameter.Type)).Append(' ');
            }

            builder.Append(parameter.Name);

            if (parameter.HasExplicitDefaultValue && parameter.RefKind == RefKind.None && !parameter.IsVariadic)
            {
                var rendered = RenderConstant(parameter.ExplicitDefaultValue, parameter.Type);
                builder.Append(" = ").Append(rendered ?? "default");
            }

            parts.Add(builder.ToString());
        }

        return string.Join(", ", parts);
    }

    private string RenderTypeParameters(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        if (typeParameters.IsDefaultOrEmpty)
        {
            return string.Empty;
        }

        return "<" + string.Join(", ", typeParameters.Select(tp => tp.Name)) + ">";
    }

    private string RenderConstraints(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        if (typeParameters.IsDefaultOrEmpty)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var tp in typeParameters)
        {
            var constraints = new List<string>();
            var isValueLike = tp.HasValueTypeConstraint || tp.HasUnmanagedConstraint;
            if (tp.HasUnmanagedConstraint)
            {
                constraints.Add("unmanaged");
            }
            else if (tp.HasValueTypeConstraint)
            {
                constraints.Add("struct");
            }
            else if (tp.HasReferenceTypeConstraint)
            {
                constraints.Add("class");
            }

            if (tp.ConstraintReferenceType != null)
            {
                constraints.Add(speller.Spell(tp.ConstraintReferenceType));
            }

            if (tp.HasDefaultConstructorConstraint && !isValueLike)
            {
                constraints.Add("new()");
            }

            if (constraints.Count > 0)
            {
                builder.Append(" where ").Append(tp.Name).Append(" : ").Append(string.Join(", ", constraints));
            }
        }

        return builder.ToString();
    }

    private void RenderAttributes(StringBuilder sb, string indent, ImmutableArray<BoundAttribute> attributes)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var attribute in attributes)
        {
            var name = speller.Spell(attribute.AttributeType);

            // Trim the conventional `Attribute` suffix so the spelled name is
            // the metadata name a generator matches; C# accepts either form.
            var args = new List<string>();
            foreach (var positional in attribute.PositionalArguments)
            {
                var rendered = RenderConstant(positional.Value, positional.Type);
                if (rendered == null)
                {
                    notes.Add($"omitted positional argument on [{name}]");
                    continue;
                }

                args.Add(rendered);
            }

            foreach (var named in attribute.NamedArguments)
            {
                var rendered = RenderConstant(named.Value, named.Type);
                if (rendered == null)
                {
                    notes.Add($"omitted named argument '{named.Name}' on [{name}]");
                    continue;
                }

                args.Add($"{named.Name} = {rendered}");
            }

            sb.Append(indent).Append('[').Append(name);
            if (args.Count > 0)
            {
                sb.Append('(').Append(string.Join(", ", args)).Append(')');
            }

            sb.AppendLine("]");
        }
    }

    /// <summary>
    /// Renders a bound compile-time constant attribute/parameter value to a
    /// parseable C# expression, or <see langword="null"/> when it has no
    /// faithful spelling (the caller then omits it).
    /// </summary>
    private string RenderConstant(object value, TypeSymbol type)
    {
        switch (value)
        {
            case null:
                return "null";
            case string s:
                return "\"" + EscapeString(s) + "\"";
            case bool b:
                return b ? "true" : "false";
            case char c:
                return "'" + EscapeChar(c) + "'";
            case TypeSymbol ts:
                return $"typeof({speller.Spell(ts)})";
            case Type clrType:
                return $"typeof(global::{clrType.FullName?.Replace('+', '.') ?? clrType.Name})";
            case float f:
                return f.ToString("R", CultureInfo.InvariantCulture) + "f";
            case double d:
                return d.ToString("R", CultureInfo.InvariantCulture) + "d";
            case decimal m:
                return m.ToString(CultureInfo.InvariantCulture) + "m";
            case long l:
                return l.ToString(CultureInfo.InvariantCulture) + "L";
            case ulong ul:
                return ul.ToString(CultureInfo.InvariantCulture) + "UL";
            case uint ui:
                return ui.ToString(CultureInfo.InvariantCulture) + "u";
            case sbyte or byte or short or ushort or int:
                return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        return null;
    }

    private static string EscapeString(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var c in value)
        {
            builder.Append(EscapeChar(c));
        }

        return builder.ToString();
    }

    private static string EscapeChar(char c) => c switch
    {
        '\\' => "\\\\",
        '"' => "\\\"",
        '\'' => "\\'",
        '\0' => "\\0",
        '\a' => "\\a",
        '\b' => "\\b",
        '\f' => "\\f",
        '\n' => "\\n",
        '\r' => "\\r",
        '\t' => "\\t",
        '\v' => "\\v",
        _ when char.IsControl(c) => "\\u" + ((int)c).ToString("x4", CultureInfo.InvariantCulture),
        _ => c.ToString(),
    };
}
