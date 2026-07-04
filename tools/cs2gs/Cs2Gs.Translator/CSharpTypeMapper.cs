// <copyright file="CSharpTypeMapper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection.Metadata;
using System.Runtime.InteropServices;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.Translator.Coverage;
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
    /// Issue #1174: cached per-compilation census of source-declared type simple
    /// names (built lazily on first use), used to decide whether a source nested
    /// type's simple name is ambiguous and must be emitted in qualified form.
    /// </summary>
    private Dictionary<string, int> sourceSimpleNameCounts;

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

        // Issue #1894: `System.Index`/`System.Range` have no canonical G# value
        // type. G#'s own `^n`/`a..b` syntax exists only as bracket-scoped index
        // sugar (gsc's Parser.ParseIndexBound) that lowers directly against the
        // collection it indexes — there is no reusable value carrying from-end
        // semantics. Mapping the type through as a bare name would let a local,
        // parameter, field, or return type of type Index/Range compile and then
        // silently misbehave at runtime (a stored `^n` re-parses elsewhere as
        // one's-complement, not from-end). Gap loudly instead.
        if (IsSystemIndexOrRange(type))
        {
            context.Report(new TranslationDiagnostic(
                type.Name,
                $"'System.{type.Name}' has no canonical G# type: G# has no reusable from-end index/range value, only bracket-scoped '^n'/'a..b' sugar, so a {type.Name}-typed local/parameter/field/return cannot carry from-end semantics correctly (issue #1894).",
                location,
                TranslationSeverity.Unsupported));
            return new NamedTypeReference(UnsupportedPlaceholderType);
        }

        // A C# unsafe pointer type (`T*`, `void*`) maps to the canonical G#
        // PREFIX pointer form `*T` (spec §"Byref/pointer syntax exists as
        // `*T`"; grammar `'*' TypeClause '?'?`). A `void*` (no element type)
        // maps to the faithful void-element pointer `*void` (ADR-0122 §3 /
        // issue #1033) — distinct from a byte pointer `*uint8`: it round-trips
        // through `nint`/`IntPtr` and casts to/from typed pointers, but cannot
        // be dereferenced/indexed/advanced without a cast. The emitted form
        // round-trips through the parser; the binder steers callers to
        // ref/out/in (GS0243) and rejects pointer fields (GS9006) on the
        // excepted unsafe Win32-interop surface (ADR-0115 §G). A FUNCTION
        // pointer has no canonical managed G# form and stays Unsupported.
        if (type is IPointerTypeSymbol pointer)
        {
            ITypeSymbol pointee = pointer.PointedAtType;
            GTypeReference element = pointee == null || pointee.SpecialType == SpecialType.System_Void
                ? new NamedTypeReference("void")
                : this.Map(pointee, context, location);
            context.Report(new TranslationDiagnostic(
                "PointerType",
                $"unsafe pointer type '{type.ToDisplayString()}' maps to the canonical G# prefix-pointer form; the binder steers callers to ref/out/in (GS0243) on the excepted unsafe Win32-interop surface (ADR-0115 §G).",
                location,
                TranslationSeverity.Info));
            return new PointerTypeReference(element);
        }

        // Issue #1906: a C# function pointer (`delegate*<...>`) maps to one of
        // G#'s two function-pointer forms — see MapFunctionPointer.
        if (type is IFunctionPointerTypeSymbol functionPointer)
        {
            return this.MapFunctionPointer(functionPointer, context, location);
        }

        // A nullable value type (Nullable<T>) carries its payload as the single
        // type argument; map the underlying type and mark the result nullable.
        if (type is INamedTypeSymbol nullableValue &&
            nullableValue.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T)
        {
            GTypeReference underlying = this.Map(nullableValue.TypeArguments[0], context, location);
            return WithNullable(underlying, true);
        }

        // A `T?`-annotated type also covers an annotated type parameter (`T?`
        // where `T : IFoo` / unconstrained). Such a parameter reports
        // `IsReferenceType == false` (an interface/unconstrained type parameter is
        // not provably a reference type), so it must be recognised explicitly or
        // the `?` is silently dropped and the nullable return/field no longer
        // type-checks against `== nil`. A `T : struct` parameter's `T?` is modelled
        // by Roslyn as `Nullable<T>` and is handled above, so an annotated
        // ITypeParameterSymbol here is always the nullable-reference-like form.
        bool nullableReference = type.NullableAnnotation == NullableAnnotation.Annotated
            && (type.IsReferenceType || type is ITypeParameterSymbol);
        GTypeReference mapped = this.MapCore(type, context, location);
        return nullableReference ? WithNullable(mapped, true) : mapped;
    }

    /// <summary>
    /// Issue #1960 item 3: maps an event's handler type, preferring a
    /// SOURCE-DECLARED named delegate's own name over the structural
    /// <c>func(...)</c> arrow form that <see cref="Map"/> always uses for
    /// delegate types. An event declared as <c>event Ticked TickHandler;</c>
    /// round-trips higher-fidelity than the anonymous <c>event Ticked (int32)
    /// -&gt; void</c> shape, and it matches C#'s own event-type story (named
    /// delegates document the handler shape for consumers). Scoped to events
    /// only (not <see cref="Map"/> generally) — a plain local/field/parameter
    /// of a same-package named-delegate type still lowers through the arrow
    /// form, since referencing a named delegate type from outside its own
    /// declaration currently trips a gsc emitter bug ("Delegate 'X' has no
    /// emitted TypeDef") for those positions; only the event accessor shape
    /// has been verified to compile with the named form (see corpus
    /// G07-Members-Console).
    /// </summary>
    /// <param name="type">The event's declared handler type.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>The canonical G# type reference for the event's handler type.</returns>
    public GTypeReference MapEventType(ITypeSymbol type, TranslationContext context, Location location)
    {
        if (type is INamedTypeSymbol { TypeKind: TypeKind.Delegate, DelegateInvokeMethod: not null } named &&
            named.DeclaringSyntaxReferences.Length > 0)
        {
            if (named.IsGenericType)
            {
                List<GTypeReference> delegateArgs = named.TypeArguments
                    .Select(a => this.Map(a, context, location))
                    .ToList();
                return new NamedTypeReference(this.QualifiedTypeName(named, context), delegateArgs);
            }

            return new NamedTypeReference(this.QualifiedTypeName(named, context));
        }

        return this.Map(type, context, location);
    }

    /// <summary>
    /// Issue #1894: whether <paramref name="type"/> is the BCL <c>System.Index</c>
    /// or <c>System.Range</c> struct — the two from-end-indexing value types that
    /// have no canonical G# representation (see <see cref="MapCore"/>).
    /// </summary>
    /// <param name="type">The C# type symbol to check.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> is <c>System.Index</c> or <c>System.Range</c>.</returns>
    internal static bool IsSystemIndexOrRange(ITypeSymbol type) =>
        type is INamedTypeSymbol { ContainingNamespace.Name: "System", ContainingNamespace.ContainingNamespace.IsGlobalNamespace: true } named
            && (named.Name == "Index" || named.Name == "Range");

    /// <summary>
    /// Issue #1906: maps a C# function-pointer type (<c>delegate*&lt;...&gt;</c>)
    /// to a G# function-pointer type. A plain <c>delegate*&lt;T, R&gt;</c> or an
    /// explicit <c>delegate* managed&lt;T, R&gt;</c> is the <b>default</b>
    /// (managed) calling convention (<see cref="SignatureCallingConvention.Default"/>)
    /// and maps to G#'s managed form <c>*func(T) R</c> (ADR-0122 §9). A
    /// <c>delegate* unmanaged[Cdecl]&lt;T, R&gt;</c> (and the three other named
    /// single conventions) maps to G#'s raw form <c>unmanaged[CC] (T) -&gt; R</c>
    /// (ADR-0095), whose <c>[CC]</c> slot only accepts one of the four fixed
    /// P/Invoke-style conventions. A bare <c>delegate* unmanaged&lt;T, R&gt;</c>
    /// (the platform-default ABI, which is Winapi/StdCall on Windows x86 and
    /// Cdecl elsewhere — genuinely platform-dependent, unlike the other four
    /// fixed conventions) and a combined/custom convention (e.g.
    /// <c>unmanaged[Cdecl, SuppressGCTransition]</c>) have no single fixed G#
    /// <see cref="CallingConvention"/> to spell, so those two sub-cases stay a
    /// deliberate by-design gap.
    /// </summary>
    /// <param name="type">The C# function-pointer type symbol.</param>
    /// <param name="context">The translation context that accumulates diagnostics.</param>
    /// <param name="location">The originating C# source location for diagnostics.</param>
    /// <returns>The mapped G# function-pointer type, or the placeholder for the two unrepresentable calling-convention sub-cases.</returns>
    private GTypeReference MapFunctionPointer(IFunctionPointerTypeSymbol type, TranslationContext context, Location location)
    {
        IMethodSymbol signature = type.Signature;
        var parameterTypes = signature.Parameters.Select(p => this.Map(p.Type, context, location)).ToList();
        GTypeReference returnType = signature.ReturnsVoid ? null : this.Map(signature.ReturnType, context, location);

        if (signature.CallingConvention == SignatureCallingConvention.Default)
        {
            return new FunctionPointerTypeReference(isManaged: true, default, parameterTypes, returnType);
        }

        CallingConvention? callingConvention = signature.CallingConvention switch
        {
            SignatureCallingConvention.CDecl => CallingConvention.Cdecl,
            SignatureCallingConvention.StdCall => CallingConvention.StdCall,
            SignatureCallingConvention.ThisCall => CallingConvention.ThisCall,
            SignatureCallingConvention.FastCall => CallingConvention.FastCall,
            SignatureCallingConvention.Unmanaged => MapSingleUnmanagedConvention(signature.UnmanagedCallingConventionTypes),
            _ => null,
        };

        if (callingConvention is { } resolved)
        {
            return new FunctionPointerTypeReference(isManaged: false, resolved, parameterTypes, returnType);
        }

        string reason = signature.CallingConvention == SignatureCallingConvention.Unmanaged
            && signature.UnmanagedCallingConventionTypes.Length == 0
            ? "the platform-default unmanaged convention ('delegate* unmanaged<...>' with no explicit '[CC]') is genuinely platform-dependent (Stdcall on Windows x86, Cdecl elsewhere) and has no single fixed G# CallingConvention to spell"
            : "a combined or custom unmanaged calling convention has no single fixed G# CallingConvention equivalent — G#'s '[CC]' slot only accepts one of Cdecl/Stdcall/Thiscall/Fastcall";
        context.Report(new TranslationDiagnostic(
            "FunctionPointerType",
            $"unsafe function-pointer type '{type.ToDisplayString()}' has no canonical G# form: {reason} (issue #1906).",
            location,
            TranslationSeverity.Unsupported)
        {
            Classification = UnsupportedClassification.ByDesign,
            Rationale = UnsupportedRationale.NoGsharpConstruct,
        });
        return new NamedTypeReference(UnsupportedPlaceholderType);
    }

    /// <summary>
    /// Resolves the single well-known unmanaged calling convention named in a
    /// generic <c>delegate* unmanaged[Name]&lt;...&gt;</c> modopt list (issue
    /// #1906), or <see langword="null"/> when the list is empty (bare
    /// <c>unmanaged</c>) or names anything other than exactly one of
    /// Cdecl/Stdcall/Thiscall/Fastcall.
    /// </summary>
    /// <param name="unmanagedCallingConventionTypes">The modopt types Roslyn resolved from the <c>[...]</c> list.</param>
    /// <returns>The matching <see cref="CallingConvention"/>, or <see langword="null"/> when none applies.</returns>
    private static CallingConvention? MapSingleUnmanagedConvention(ImmutableArray<INamedTypeSymbol> unmanagedCallingConventionTypes)
    {
        if (unmanagedCallingConventionTypes.Length != 1)
        {
            return null;
        }

        return unmanagedCallingConventionTypes[0].Name switch
        {
            "CallConvCdecl" => CallingConvention.Cdecl,
            "CallConvStdcall" => CallingConvention.StdCall,
            "CallConvThiscall" => CallingConvention.ThisCall,
            "CallConvFastcall" => CallingConvention.FastCall,
            _ => null,
        };
    }

    private static GTypeReference WithNullable(GTypeReference reference, bool isNullable)
    {
        switch (reference)
        {
            case NamedTypeReference named:
                return new NamedTypeReference(named.Name, named.TypeArguments) { IsNullable = isNullable };
            case ArrayTypeReference array:
                return new ArrayTypeReference(array.ElementType) { IsNullable = isNullable };
            case PointerTypeReference pointer:
                return new PointerTypeReference(pointer.ElementType) { IsNullable = isNullable };
            case TupleTypeReference tuple:
                return new TupleTypeReference(tuple.ElementTypes) { IsNullable = isNullable };
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
            if (array.Rank > 1)
            {
                // Issue #1893: gsc has no rectangular multi-dim array type (only
                // the fixed-length `[N]T`/slice `[]T`, both rank 1). A
                // multi-dim TYPE reached here (e.g. an explicit `T[,] x;` with
                // no initializer, a field/parameter/return type) has no symbol
                // for TranslateLocalDeclaration's flat-lowering to hang
                // per-dimension sizes on, so — rather than silently returning a
                // 1-D `ArrayTypeReference` that drops the rank (the original
                // bug) — report the gap loudly. A local declared AND
                // initialized in one statement from `new T[d0, d1, ...]` avoids
                // this path entirely: TranslateLocalDeclaration omits the type
                // clause and relies on inference over the already-flat-lowered
                // initializer.
                string multiDimTypeGapMessage =
                    $"multi-dimensional array type '{array}' (rank {array.Rank}) has no canonical G# type; " +
                    "only a local declared and initialized in the same statement from `new T[d0, d1, ...]` " +
                    "or a rectangular initializer is supported today.";
                context.Report(new TranslationDiagnostic(
                    "ArrayType", multiDimTypeGapMessage, location, TranslationSeverity.Unsupported));
            }

            return new ArrayTypeReference(this.Map(array.ElementType, context, location));
        }

        if (type is ITypeParameterSymbol typeParameter)
        {
            return new NamedTypeReference(CSharpToGSharpTranslator.SanitizeIdentifier(typeParameter.Name));
        }

        if (type is INamedTypeSymbol named)
        {
            // Value tuples / named tuples map to the canonical G# positional
            // tuple type `(T1, T2, …)` (spec §Type syntax). G# tuples are
            // positional, so C# element names are dropped here and named element
            // access lowers to `.Item1`/`.Item2` at the use site (ADR-0115 §B.4).
            if (named.IsTupleType)
            {
                List<GTypeReference> elementTypes = named.TupleElements
                    .Select(e => this.Map(e.Type, context, location))
                    .ToList();
                context.Report(new TranslationDiagnostic(
                    named.ToDisplayString(),
                    "C# value-tuple / named-tuple type mapped to the canonical G# positional tuple type; element names are dropped and named access lowers to '.ItemN' (ADR-0115 §B.4).",
                    location,
                    TranslationSeverity.Info));
                return new TupleTypeReference(elementTypes);
            }

            // Issue #1934: an anonymous type (`new { A = 1, B = 2 }`) has no G#
            // equivalent, but its shape — an ordered list of property types — is
            // exactly a tuple's shape, so it maps to the same positional tuple
            // type as a named C# tuple, above.
            if (named.IsAnonymousType)
            {
                List<GTypeReference> anonymousElementTypes = named.GetMembers()
                    .OfType<IPropertySymbol>()
                    .Select(p => this.Map(p.Type, context, location))
                    .ToList();
                context.Report(new TranslationDiagnostic(
                    named.ToDisplayString(),
                    "C# anonymous type mapped to the canonical G# positional tuple type; member names are dropped and named access lowers to '.ItemN' (ADR-0115 §B.4).",
                    location,
                    TranslationSeverity.Info));
                return new TupleTypeReference(anonymousElementTypes);
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
                return new NamedTypeReference(this.QualifiedTypeName(named, context), args);
            }

            return new NamedTypeReference(this.QualifiedTypeName(named, context));
        }

        return new NamedTypeReference(CSharpToGSharpTranslator.SanitizeIdentifier(type.Name));
    }

    // A nested type is referenced through its containing type(s)
    // (`ConfiguredTaskAwaitable.ConfiguredTaskAwaiter`); emitting the innermost
    // name alone makes the reference unresolvable. Walk the containing-type chain
    // and join with '.' so nested types stay qualified (ADR-0115 §B.12).
    //
    // Metadata (BCL/external) nested types are ALWAYS qualified. A source-declared
    // nested type is emitted by the translator as a directly-nested G# member and
    // is normally referenced by its simple name within the package. However, when
    // another source type shares its simple name (issue #1174 / #914: e.g. a
    // top-level `class SampleEntry` alongside `class SttsBox { data struct
    // SampleEntry(...) }`), the bare name binds to the homonym that holds the
    // simple key — so the nested type must be qualified `Container.Nested` to
    // resolve correctly. This is now safe to emit in every position (generic
    // arguments, type clauses, struct literals) thanks to the issue #1174
    // language fix, so the qualified form round-trips under gsc.
    private string QualifiedTypeName(INamedTypeSymbol named, TranslationContext context)
    {
        if (named.ContainingType == null)
        {
            return CSharpToGSharpTranslator.SanitizeIdentifier(named.Name);
        }

        // A source nested type only needs qualifying when its simple name is
        // ambiguous within the package (a same-named source homonym exists).
        if (named.Locations.Any(l => l.IsInSource) && !this.HasSourceHomonym(named, context))
        {
            return CSharpToGSharpTranslator.SanitizeIdentifier(named.Name);
        }

        var parts = new List<string>();
        for (INamedTypeSymbol current = named; current != null; current = current.ContainingType)
        {
            parts.Insert(0, CSharpToGSharpTranslator.SanitizeIdentifier(current.Name));
        }

        return string.Join(".", parts);
    }

    /// <summary>
    /// Issue #1174: whether another source-declared type shares the simple name of
    /// <paramref name="named"/>, making the bare name ambiguous in the flat G#
    /// package scope. The per-compilation simple-name census is built once and
    /// cached on this mapper instance.
    /// </summary>
    private bool HasSourceHomonym(INamedTypeSymbol named, TranslationContext context)
    {
        this.sourceSimpleNameCounts ??= BuildSourceSimpleNameCounts(context.Compilation);
        return this.sourceSimpleNameCounts.TryGetValue(named.Name, out var count) && count > 1;
    }

    private static Dictionary<string, int> BuildSourceSimpleNameCounts(Compilation compilation)
    {
        var counts = new Dictionary<string, int>();
        foreach (var type in EnumerateAllNamedTypes(compilation.GlobalNamespace))
        {
            if (!type.Locations.Any(l => l.IsInSource))
            {
                continue;
            }

            counts.TryGetValue(type.Name, out var existing);
            counts[type.Name] = existing + 1;
        }

        return counts;
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateAllNamedTypes(INamespaceSymbol ns)
    {
        foreach (var member in ns.GetMembers())
        {
            if (member is INamespaceSymbol childNs)
            {
                foreach (var nested in EnumerateAllNamedTypes(childNs))
                {
                    yield return nested;
                }
            }
            else if (member is INamedTypeSymbol type)
            {
                foreach (var nested in EnumerateNamedTypeAndNested(type))
                {
                    yield return nested;
                }
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> EnumerateNamedTypeAndNested(INamedTypeSymbol type)
    {
        yield return type;
        foreach (var nested in type.GetTypeMembers())
        {
            foreach (var deeper in EnumerateNamedTypeAndNested(nested))
            {
                yield return deeper;
            }
        }
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
