// <copyright file="CSharpTypeMapper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;

namespace Cs2Gs.Translator;

/// <summary>
/// Converts a Roslyn <see cref="ITypeSymbol"/> into the canonical G# type
/// reference (<see cref="GTypeReference"/>) following ADR-0115 §B.7, §B.8, and
/// §B.12. The mapper is driven by the bound <see cref="ITypeSymbol"/> (not the
/// raw syntax) so width-bearing primitive names, generic instantiations,
/// delegate arrow forms, and nullability are resolved semantically.
/// <para>
/// A C# type with no established canonical G# form (e.g. a value tuple /
/// named-tuple type) is <b>never</b> approximated with non-parsing text: the
/// mapper records a structured <see cref="TranslationSeverity.Unsupported"/>
/// <see cref="TranslationDiagnostic"/> and emits the nearest parseable
/// placeholder (<see cref="UnsupportedPlaceholderType"/>) so the file still
/// round-trips while the gap is surfaced for triage (ADR-0115 §B/§D).
/// </para>
/// </summary>
public sealed class CSharpTypeMapper
{
    /// <summary>
    /// The parseable placeholder type name emitted when a C# type has no
    /// canonical G# form. <c>object</c> is the universal upper bound (spec
    /// §Object) so the emitted file always re-parses; the real gap is carried by
    /// the accompanying <see cref="TranslationSeverity.Unsupported"/> diagnostic.
    /// </summary>
    public const string UnsupportedPlaceholderType = "object";

    /// <summary>
    /// Maps a Roslyn type symbol to its canonical G# type reference, recording
    /// an unsupported-construct diagnostic on <paramref name="context"/> for any
    /// type with no canonical G# form.
    /// </summary>
    /// <param name="type">The bound C# type symbol.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>The canonical G# type reference (never <see langword="null"/>).</returns>
    public GTypeReference Map(ITypeSymbol type, TranslationContext context, Location location)
    {
        if (type == null || type.TypeKind == TypeKind.Error)
        {
            context.Report(new TranslationDiagnostic(
                type?.ToDisplayString() ?? "<unresolved-type>",
                "Could not resolve a C# type symbol; emitted the placeholder type.",
                location,
                TranslationSeverity.Unsupported));
            return new NamedTypeReference(UnsupportedPlaceholderType);
        }

        // A nullable value type (Nullable<T>) carries its payload as the single
        // type argument; map the underlying type and mark the result nullable.
        if (type is INamedTypeSymbol nullableValue &&
            nullableValue.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
        {
            GTypeReference underlying = this.Map(nullableValue.TypeArguments[0], context, location);
            return WithNullable(underlying, true);
        }

        bool nullableReference = type.NullableAnnotation == NullableAnnotation.Annotated && type.IsReferenceType;
        GTypeReference mapped = this.MapCore(type, context, location);
        return nullableReference ? WithNullable(mapped, true) : mapped;
    }

    private static GTypeReference WithNullable(GTypeReference reference, bool isNullable)
    {
        switch (reference)
        {
            case NamedTypeReference named:
                return new NamedTypeReference(named.Name, named.TypeArguments) { IsNullable = isNullable };
            case ArrayTypeReference array:
                return new ArrayTypeReference(array.ElementType) { IsNullable = isNullable };
            case ArrowTypeReference arrow:
                return new ArrowTypeReference(arrow.ParameterTypes, arrow.ReturnTypes, arrow.IsAsync)
                {
                    IsNullable = isNullable,
                };
            default:
                return reference;
        }
    }

    private static string MapPredefinedName(SpecialType specialType)
    {
        switch (specialType)
        {
            case SpecialType.System_Boolean:
                return "bool";
            case SpecialType.System_Char:
                return "char";
            case SpecialType.System_SByte:
                return "int8";
            case SpecialType.System_Byte:
                return "uint8";
            case SpecialType.System_Int16:
                return "int16";
            case SpecialType.System_UInt16:
                return "uint16";
            case SpecialType.System_Int32:
                return "int32";
            case SpecialType.System_UInt32:
                return "uint32";
            case SpecialType.System_Int64:
                return "int64";
            case SpecialType.System_UInt64:
                return "uint64";
            case SpecialType.System_Single:
                return "float32";
            case SpecialType.System_Double:
                return "float64";
            case SpecialType.System_Decimal:
                return "decimal";
            case SpecialType.System_String:
                return "string";
            case SpecialType.System_Object:
                return "object";
            default:
                return null;
        }
    }

    private GTypeReference MapCore(ITypeSymbol type, TranslationContext context, Location location)
    {
        // Width-bearing primitive names (ADR-0115 §B.12).
        string predefined = MapPredefinedName(type.SpecialType);
        if (predefined != null)
        {
            return new NamedTypeReference(predefined);
        }

        if (type is IArrayTypeSymbol array)
        {
            return new ArrayTypeReference(this.Map(array.ElementType, context, location));
        }

        if (type is ITypeParameterSymbol typeParameter)
        {
            return new NamedTypeReference(typeParameter.Name);
        }

        if (type is INamedTypeSymbol named)
        {
            // Value tuples / named tuples have no canonical G# form yet
            // (deliberate gap-discovery path, ADR-0115 §B/§D).
            if (named.IsTupleType)
            {
                context.Report(new TranslationDiagnostic(
                    named.ToDisplayString(),
                    $"C# value-tuple / named-tuple types have no canonical G# form yet; emitted the '{UnsupportedPlaceholderType}' placeholder (ADR-0115 §B).",
                    location,
                    TranslationSeverity.Unsupported));
                return new NamedTypeReference(UnsupportedPlaceholderType);
            }

            // Delegate types (Func/Action/named delegates) render in arrow form
            // (ADR-0115 §B.8).
            if (named.TypeKind == TypeKind.Delegate && named.DelegateInvokeMethod != null)
            {
                return this.MapDelegate(named.DelegateInvokeMethod, context, location);
            }

            if (named.IsGenericType)
            {
                List<GTypeReference> args = named.TypeArguments
                    .Select(a => this.Map(a, context, location))
                    .ToList();
                return new NamedTypeReference(named.Name, args);
            }

            return new NamedTypeReference(named.Name);
        }

        return new NamedTypeReference(type.Name);
    }

    private ArrowTypeReference MapDelegate(IMethodSymbol invoke, TranslationContext context, Location location)
    {
        List<GTypeReference> parameters = invoke.Parameters
            .Select(p => this.Map(p.Type, context, location))
            .ToList();

        ITypeSymbol returnType = invoke.ReturnType;
        bool isAsync = false;

        // A delegate returning Task / Task<T> maps to the async arrow form
        // (ADR-0115 §B.8): async () -> void / async () -> T.
        if (returnType is INamedTypeSymbol returnNamed &&
            returnNamed.Name == "Task" &&
            returnNamed.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
        {
            isAsync = true;
            returnType = returnNamed.IsGenericType ? returnNamed.TypeArguments[0] : null;
        }

        var returns = new List<GTypeReference>();
        if (returnType != null && returnType.SpecialType != SpecialType.System_Void)
        {
            returns.Add(this.Map(returnType, context, location));
        }

        return new ArrowTypeReference(parameters, returns, isAsync);
    }
}
