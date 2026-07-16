// <copyright file="DeclarationBinder.Attributes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class DeclarationBinder
{
    /// <summary>
    /// Phase 4 of #141 / ADR-0047 §5: returns true if any annotation in the
    /// list is the bare <c>@Attribute</c> sugar marker (single-segment name
    /// <c>Attribute</c>, no use-site target qualifier).
    /// </summary>
    /// <param name="annotations">Annotations from the declaration's syntax node.</param>
    /// <returns>True if the marker is present.</returns>
    private static bool HasAttributeSugarMarker(ImmutableArray<AnnotationSyntax> annotations)
    {
        if (annotations.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var annotation in annotations)
        {
            // ADR-0047 §5: the sugar marker is exactly `@Attribute` (no
            // use-site target qualifier; no arguments; single-segment name).
            if (annotation.Target != null)
            {
                continue;
            }

            if (annotation.NameSegments.Length != 1)
            {
                continue;
            }

            if (annotation.NameSegments[0].Text == "Attribute")
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// ADR-0058 / issue #376: returns true if a function declaration carries the
    /// <c>@UnscopedRef</c> annotation, which relaxes the implicit <c>scoped</c>
    /// on a ref struct instance method's <c>this</c> parameter.
    /// </summary>
    internal static bool HasUnscopedRefAnnotation(FunctionSymbol function)
    {
        var declaration = function.Declaration;
        if (declaration == null)
        {
            return false;
        }

        var annotations = declaration.Annotations;
        if (annotations.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var annotation in annotations)
        {
            if (annotation.Target != null)
            {
                continue;
            }

            if (annotation.NameSegments.Length == 1 && annotation.NameSegments[0].Text == "UnscopedRef")
            {
                return true;
            }

            // Also accept the fully qualified name.
            if (annotation.NameSegments.Length >= 2)
            {
                var fullName = string.Concat(annotation.NameSegments.Select(s => s.Text));
                if (fullName == "UnscopedRef" || fullName == "UnscopedRefAttribute"
                    || fullName == "System.Diagnostics.CodeAnalysis.UnscopedRef"
                    || fullName == "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute")
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Phase 4 of #141 / ADR-0047 §5: returns true if <paramref name="annotation"/>
    /// is the bare <c>@Attribute</c> sugar marker.
    /// </summary>
    /// <param name="annotation">The annotation node to test.</param>
    /// <returns>True for the marker.</returns>
    private static bool IsAttributeSugarMarker(AnnotationSyntax annotation)
    {
        if (annotation == null || annotation.Target != null)
        {
            return false;
        }

        if (annotation.NameSegments.Length != 1)
        {
            return false;
        }

        return annotation.NameSegments[0].Text == "Attribute";
    }

    /// <summary>
    /// Resolves a list of <see cref="AnnotationSyntax"/> nodes against the
    /// declaring scope and returns the bound attribute list per ADR-0047.
    /// </summary>
    /// <param name="annotations">Annotations from the declaration's syntax node.</param>
    /// <param name="defaultTarget">Default target inferred from the declaration position.</param>
    /// <param name="allowedTargets">Target kinds permitted at this declaration position.</param>
    /// <param name="positionDescription">Human-readable position for diagnostics.</param>
    /// <param name="defaultSystemTarget">CLR-side <see cref="System.AttributeTargets"/>
    /// value used when validating <c>[AttributeUsage(ValidOn)]</c> for the
    /// <c>Type</c> kind, which is ambiguous in source.</param>
    /// <returns>The resolved attribute list (skipping unresolved entries).</returns>
    internal ImmutableArray<BoundAttribute> BindAttributes(
        ImmutableArray<AnnotationSyntax> annotations,
        AttributeTargetKind defaultTarget,
        ImmutableHashSet<AttributeTargetKind> allowedTargets,
        string positionDescription,
        System.AttributeTargets defaultSystemTarget)
    {
        if (annotations.IsDefaultOrEmpty)
        {
            return ImmutableArray<BoundAttribute>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<BoundAttribute>(annotations.Length);

        // Track applications per (attribute-type identity, effective target)
        // so we can fire GS0210 when AllowMultiple = false. We key on the
        // resolved TypeSymbol (reference identity is sufficient — each
        // attribute class has a single Symbol instance).
        var applications = new Dictionary<(TypeSymbol Type, AttributeTargetKind Target), int>();

        foreach (var annotation in annotations)
        {
            // Phase 4 of #141 / ADR-0047 §5: the `@Attribute` marker on a
            // class declaration is sugar — it does NOT participate in the
            // emitted CustomAttribute table. The struct binder consumes it
            // separately via HasAttributeSugarMarker.
            if (defaultTarget == AttributeTargetKind.Type && IsAttributeSugarMarker(annotation))
            {
                continue;
            }

            var bound = BindAttribute(annotation, defaultTarget, allowedTargets, positionDescription, defaultSystemTarget);
            if (bound != null)
            {
                var key = (bound.AttributeType, bound.Target);
                if (applications.TryGetValue(key, out var count))
                {
                    KnownAttributes.GetAttributeUsage(bound.AttributeType, out _, out var allowMultiple);
                    if (!allowMultiple)
                    {
                        Diagnostics.ReportAttributeUsageDuplicate(
                            GetAnnotationNameLocation(annotation),
                            annotation.GetNameText());
                    }

                    applications[key] = count + 1;
                }
                else
                {
                    applications[key] = 1;
                }

                builder.Add(bound);
            }
        }

        return builder.ToImmutable();
    }

    private BoundAttribute BindAttribute(
        AnnotationSyntax annotation,
        AttributeTargetKind defaultTarget,
        ImmutableHashSet<AttributeTargetKind> allowedTargets,
        string positionDescription,
        System.AttributeTargets defaultSystemTarget)
    {
        // 1) Resolve target — parser already filtered to canonical kinds; if
        // the user wrote an unrecognised one a GS0197 was already reported,
        // but we still need to map a parsed-but-unknown string back to a
        // sentinel. The closed set keys off ADR-0047 §2.
        var targetKind = defaultTarget;
        if (annotation.Target != null)
        {
            if (TryParseTargetKind(annotation.Target.KindIdentifier.Text, out var parsedTarget))
            {
                targetKind = parsedTarget;
            }
            else
            {
                // Already reported by the parser; treat as default and continue.
            }

            if (!allowedTargets.Contains(targetKind))
            {
                Diagnostics.ReportAttributeTargetInvalidForPosition(
                    annotation.Target.KindIdentifier.Location,
                    annotation.Target.KindIdentifier.Text,
                    positionDescription);
            }
        }

        // 2) Resolve attribute type (C#-style: `Foo` then `FooAttribute`).
        var nameText = annotation.GetNameText();
        bool nameIsExact;
        var attrType = annotation.HasTypeArgumentList
            ? this.ResolveGenericAttributeType(nameText, annotation, out nameIsExact)
            : ResolveAttributeType(nameText, annotation, out nameIsExact);
        if (attrType == null)
        {
            return null;
        }

        // 3) Validate it derives from System.Attribute.
        if (!IsAttributeType(attrType))
        {
            var displayName = nameIsExact ? nameText : (nameText + "Attribute");
            Diagnostics.ReportNotAnAttributeType(GetAnnotationNameLocation(annotation), displayName);
            return null;
        }

        // 3a) Reject user-written instances of attributes ADR-0047 §6
        // reserves for compiler synthesis (Extension, AsyncStateMachine,
        // CompilerGenerated, Nullable, NullableContext). Recognition is
        // type-identity based on the resolved CLR type so renaming or
        // shadowing the source-level name cannot bypass the rule.
        if (KnownAttributes.IsReservedForCompiler(attrType.ClrType))
        {
            Diagnostics.ReportAttributeReservedForCompiler(GetAnnotationNameLocation(annotation), nameText);
            return null;
        }

        // 3a.1) ADR-0086 / issue #727: the blanket rejection of @DllImport
        // (formerly GS0211, ADR-0047 §6) is removed. Well-formed P/Invoke
        // declarations bind normally here; the function-declaration binder
        // (BindFunctionDeclaration) then drives the P/Invoke pipeline:
        // validates the function shape (no body, no instance/async/generic),
        // extracts the @DllImport metadata into PInvokeMetadata, and reports
        // GS0322–GS0329 on any malformed input. The emitter picks up
        // function.PInvokeMetadata to write the ImplMap row.

        // 3b) Issue #177 / ADR-0047 §6: enforce [AttributeUsage(ValidOn)].
        // For the `Type` target the actual CLR target depends on the kind
        // of type being declared (class/struct/enum/interface), which the
        // caller passes via defaultSystemTarget. For all other targets the
        // effective CLR target is derived directly from targetKind, since
        // any use-site qualifier (`@return:` etc.) already narrows it.
        var effectiveSystemTarget = MapToSystemAttributeTargets(targetKind, defaultSystemTarget);
        KnownAttributes.GetAttributeUsage(attrType, out var validOn, out _);
        if ((validOn & effectiveSystemTarget) == 0)
        {
            Diagnostics.ReportAttributeUsageInvalidTarget(
                GetAnnotationNameLocation(annotation),
                nameText,
                positionDescription,
                validOn);
            return null;
        }

        // 4) Bind arguments — positional + named — restricted to compile-time
        // constants. Named arguments come back from ParseArguments as
        // NamedArgumentExpressionSyntax wrappers.
        var positional = ImmutableArray.CreateBuilder<BoundAttributeArgument>();
        var named = ImmutableArray.CreateBuilder<BoundAttributeArgument>();
        if (annotation.Arguments != null)
        {
            foreach (var argSyntax in annotation.Arguments)
            {
                if (argSyntax is NamedArgumentExpressionSyntax namedArg)
                {
                    // Issue #1921 code review (GS0466): the emitter can only
                    // write named args against an already-emitted CLR type
                    // (it resolves the target member via reflection); a
                    // same-compilation user attribute has no ClrType yet, so
                    // reject named args on it here instead of silently
                    // dropping them at emit time.
                    if (attrType is StructSymbol { ClrType: null })
                    {
                        Diagnostics.ReportNamedArgumentsNotSupportedOnUserAttribute(
                            namedArg.NameToken.Location,
                            nameIsExact ? nameText : (nameText + "Attribute"),
                            namedArg.NameToken.Text);
                        continue;
                    }

                    if (!TryBindAttributeArgument(namedArg.Expression, out var value, out var valueType))
                    {
                        Diagnostics.ReportAttributeArgumentNotConstant(namedArg.Expression.Location);
                        continue;
                    }

                    named.Add(new BoundAttributeArgument(namedArg.NameToken.Text, value, valueType));
                }
                else
                {
                    if (!TryBindAttributeArgument(argSyntax, out var value, out var valueType))
                    {
                        Diagnostics.ReportAttributeArgumentNotConstant(argSyntax.Location);
                        continue;
                    }

                    positional.Add(new BoundAttributeArgument(name: null, value, valueType));
                }
            }
        }

        return new BoundAttribute(annotation, attrType, targetKind, positional.ToImmutable(), named.ToImmutable());
    }

    // Issue #1913: resolves a C# 11-style generic attribute application
    // (`@Tag[int32]`) to its CLOSED attribute type. Mirrors
    // <see cref="ResolveAttributeType"/>'s exact-then-`Attribute`-suffixed
    // two-try lookup, but existence is probed via the silent, arity-aware
    // `scope.TryLookupTypeAlias` (no diagnostics on a miss) exactly the way
    // <see cref="TryResolveUserNestedTypeExpression"/> gates a speculative
    // generic-type probe elsewhere — so trying the exact name first and
    // falling back to the suffixed name never reports a spurious
    // "type not found" for the name that loses. Once the winning name is
    // picked, the real close-the-generic-type work is delegated to the SAME
    // `bindTypeClause` callback an ordinary generic type reference
    // (`List[int32]`) already goes through, by building a synthetic
    // `TypeClauseSyntax` out of the annotation's own tokens — no separate
    // generic-attribute-construction logic to maintain.
    private TypeSymbol ResolveGenericAttributeType(string name, AnnotationSyntax annotation, out bool nameIsExact)
    {
        nameIsExact = true;
        var nameLocation = GetAnnotationNameLocation(annotation);
        var arity = annotation.TypeArguments.Count;

        var simpleName = name;
        var dotIndex = string.IsNullOrEmpty(name) ? -1 : name.LastIndexOf('.');
        if (dotIndex >= 0)
        {
            simpleName = name.Substring(dotIndex + 1);
        }

        // The `Attribute`-suffix retry only ever applies to a simple
        // (non-dotted) name, same as `ResolveAttributeType` — a dotted name's
        // last segment is resolved by `bindTypeClause` itself via the
        // reference-assembly path, which does its own suffix-free lookup.
        var directExists = dotIndex < 0
            && !string.IsNullOrEmpty(simpleName)
            && scope.TryLookupTypeAlias(simpleName, arity, out _);

        string suffixedName = null;
        var suffixedExists = false;
        if (dotIndex < 0 && !string.IsNullOrEmpty(simpleName) && !simpleName.EndsWith("Attribute", StringComparison.Ordinal))
        {
            suffixedName = simpleName + "Attribute";
            suffixedExists = scope.TryLookupTypeAlias(suffixedName, arity, out _);
        }

        if (directExists && suffixedExists)
        {
            Diagnostics.ReportAmbiguousAttributeName(nameLocation, name);
        }

        string resolvedLastSegment;
        if (directExists)
        {
            nameIsExact = true;
            resolvedLastSegment = simpleName;
        }
        else if (suffixedExists)
        {
            nameIsExact = false;
            resolvedLastSegment = suffixedName;
        }
        else if (dotIndex < 0)
        {
            Diagnostics.ReportAttributeTypeNotFound(nameLocation, name);
            return null;
        }
        else
        {
            // Dotted/qualified generic attribute name (e.g.
            // `System.Foo<int>`): no local-scope suffix retry applies, so try
            // the exact spelling and let `bindTypeClause` report GS0113 if it
            // doesn't resolve.
            resolvedLastSegment = simpleName;
        }

        var syntheticTypeClause = BuildSyntheticGenericAttributeTypeClause(annotation, resolvedLastSegment);
        return bindTypeClause(syntheticTypeClause);
    }

    // Issue #1913: builds the `TypeClauseSyntax` that `ResolveGenericAttributeType`
    // feeds to `bindTypeClause`, reusing the annotation's own name/type-argument
    // tokens verbatim (only the LAST segment's identifier may need renaming for
    // the `Attribute`-suffix retry — the suffix retry only ever fires for a
    // single-segment name, so no other segment ever needs renaming).
    private static TypeClauseSyntax BuildSyntheticGenericAttributeTypeClause(AnnotationSyntax annotation, string lastSegmentText)
    {
        var segments = annotation.NameSegments;
        var lastIndex = segments.Length - 1;
        var lastSegmentToken = segments[lastIndex];
        var renamedLast = lastSegmentToken.Text == lastSegmentText
            ? lastSegmentToken
            : new SyntaxToken(annotation.SyntaxTree, SyntaxKind.IdentifierToken, lastSegmentToken.Position, lastSegmentText, null);

        var identifier = lastIndex == 0 ? renamedLast : segments[0];
        var qualifierIdentifiers = lastIndex == 0
            ? ImmutableArray<SyntaxToken>.Empty
            : segments.RemoveAt(0).SetItem(lastIndex - 1, renamedLast);

        return new TypeClauseSyntax(
            annotation.SyntaxTree,
            openBracketToken: null,
            lengthToken: null,
            closeBracketToken: null,
            identifier,
            annotation.DotTokens,
            qualifierIdentifiers,
            annotation.TypeArgumentOpenBracketToken,
            annotation.TypeArguments,
            annotation.TypeArgumentCloseBracketToken,
            questionToken: null);
    }

    private TypeSymbol ResolveAttributeType(string name, AnnotationSyntax annotation, out bool nameIsExact)
    {
        var nameLocation = GetAnnotationNameLocation(annotation);
        nameIsExact = true;

        // Issue #1206: resolve the verbatim name and the C#-style
        // `<simple-name>Attribute` suffixed name. The suffix is appended to the
        // final simple-name segment only — for a qualified name `Ns.Foo` the
        // candidate is `Ns.FooAttribute`, never `Ns.FooAttribute` with a doubled
        // `Attribute`, and a name whose simple part already ends in `Attribute`
        // is not suffixed at all. Both the simple-identifier form (honoring
        // imports/aliases via LookupType) and the dotted/qualified form (resolved
        // by full name against the reference set, the same machinery used for
        // qualified type references such as `System.IntPtr`) are supported.
        var direct = ResolveAttributeName(name);

        var simpleName = name;
        var dotIndex = string.IsNullOrEmpty(name) ? -1 : name.LastIndexOf('.');
        if (dotIndex >= 0)
        {
            simpleName = name.Substring(dotIndex + 1);
        }

        TypeSymbol suffixed = null;
        if (!string.IsNullOrEmpty(simpleName) && !simpleName.EndsWith("Attribute", StringComparison.Ordinal))
        {
            var suffixedName = dotIndex >= 0
                ? string.Concat(name.Substring(0, dotIndex + 1), simpleName, "Attribute")
                : simpleName + "Attribute";
            suffixed = ResolveAttributeName(suffixedName);
        }

        if (direct != null && IsAttributeType(direct) && suffixed != null && IsAttributeType(suffixed))
        {
            Diagnostics.ReportAmbiguousAttributeName(nameLocation, name);
            return direct;
        }

        // Issue #2261: C# attribute-name resolution (ECMA-334 §22.3) discards
        // an exact-name candidate that does not itself derive from
        // System.Attribute and falls back to the `Attribute`-suffixed
        // candidate instead of reporting it non-attribute — the two names can
        // legitimately coexist in the same assembly (e.g. CommunityToolkit.Mvvm
        // ships both the `RelayCommand` ICommand class and the
        // `RelayCommandAttribute` marker consumed by its source generator).
        // Only when the exact-name candidate genuinely derives from Attribute
        // do we prefer it outright.
        if (direct != null && IsAttributeType(direct))
        {
            nameIsExact = true;
            return direct;
        }

        if (suffixed != null)
        {
            nameIsExact = false;
            return suffixed;
        }

        // Neither resolved candidate derives from System.Attribute (or only the
        // exact name resolved at all): keep the original "not an attribute
        // type" diagnostic shape by returning the exact-name candidate when it
        // exists.
        if (direct != null)
        {
            nameIsExact = true;
            return direct;
        }

        Diagnostics.ReportAttributeTypeNotFound(nameLocation, name);
        return null;
    }

    // Issue #1206: resolves a (possibly dotted) attribute name to a TypeSymbol.
    // The simple-identifier form goes through LookupType so imports and aliases
    // are honored; the qualified/dotted form (e.g. `System.Obsolete`,
    // `System.Runtime.InteropServices.DllImport`) is resolved by full name
    // against the reference set — the same resolution used for qualified type
    // references elsewhere (e.g. `System.IntPtr`).
    private TypeSymbol ResolveAttributeName(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }

        var resolved = lookupType(name);
        if (resolved != null)
        {
            return resolved;
        }

        if (name.IndexOf('.') >= 0 && scope.References.TryResolveType(name, out var clrType) && clrType != null)
        {
            return TypeSymbol.FromClrType(clrType);
        }

        return null;
    }

    private static bool IsAttributeType(TypeSymbol typeSymbol)
    {
        // Issue #1921: a same-compilation user class deriving from
        // System.Attribute (via either the `@Attribute` sugar or a plain
        // `: Attribute` / `: System.Attribute` base clause) has no CLR type
        // yet — it hasn't been emitted — so ClrType is null and the CLR
        // base-chain walk below can't see it. StructSymbol.DerivesFromSystemAttribute
        // walks the symbol-level BaseClass chain instead of relying on ClrType.
        if (typeSymbol is StructSymbol structSym)
        {
            return structSym.DerivesFromSystemAttribute();
        }

        var clr = typeSymbol?.ClrType;
        if (clr == null)
        {
            return false;
        }

        var attributeFullName = typeof(System.Attribute).FullName;
        for (var t = clr; t != null; t = t.BaseType)
        {
            if (t.FullName == attributeFullName)
            {
                return true;
            }
        }

        return false;
    }

    private static TextLocation GetAnnotationNameLocation(AnnotationSyntax annotation)
    {
        if (!annotation.NameSegments.IsDefaultOrEmpty)
        {
            var first = annotation.NameSegments[0];
            var last = annotation.NameSegments[annotation.NameSegments.Length - 1];
            var span = TextSpan.FromBounds(first.Span.Start, last.Span.End);
            return new TextLocation(annotation.SyntaxTree.Text, span);
        }

        return annotation.Location;
    }

    private static bool IsEnumLikeType(TypeSymbol type)
    {
        if (type is EnumSymbol)
        {
            return true;
        }

        // Issue #2327: `type.ClrType` may be a
        // System.Reflection.Emit.TypeBuilderInstantiation whose `IsEnum`
        // throws NotSupportedException. Route through the shared safe
        // helper (generalizing the #1100/#2135 pattern established in
        // Conversion.IsEnumLikeType / IsInterfaceLikeType) rather than
        // probing `ClrType.IsEnum` directly.
        return type?.ClrType.IsEnumSafe() == true;
    }

    private static bool TryParseTargetKind(string text, out AttributeTargetKind kind)
    {
        switch (text)
        {
            case "field": kind = AttributeTargetKind.Field; return true;
            case "param": kind = AttributeTargetKind.Param; return true;
            case "return": kind = AttributeTargetKind.Return; return true;
            case "type": kind = AttributeTargetKind.Type; return true;
            case "method": kind = AttributeTargetKind.Method; return true;
            case "property": kind = AttributeTargetKind.Property; return true;
            case "event": kind = AttributeTargetKind.Event; return true;
            case "module": kind = AttributeTargetKind.Module; return true;
            case "assembly": kind = AttributeTargetKind.Assembly; return true;
            case "genericparam": kind = AttributeTargetKind.GenericParam; return true;
            default: kind = AttributeTargetKind.Method; return false;
        }
    }

    /// <summary>
    /// Issue #177: maps a GSharp <see cref="AttributeTargetKind"/> to the
    /// corresponding CLR <see cref="System.AttributeTargets"/> flag used by
    /// <see cref="System.AttributeUsageAttribute"/>. The <c>Type</c> kind
    /// is intentionally ambiguous in GSharp (class/struct/enum/interface
    /// share a single source-level position), so the caller supplies the
    /// concrete CLR target via <paramref name="typePositionFallback"/>.
    /// </summary>
    private static System.AttributeTargets MapToSystemAttributeTargets(AttributeTargetKind kind, System.AttributeTargets typePositionFallback)
    {
        switch (kind)
        {
            case AttributeTargetKind.Field: return System.AttributeTargets.Field;
            case AttributeTargetKind.Param: return System.AttributeTargets.Parameter;
            case AttributeTargetKind.Return: return System.AttributeTargets.ReturnValue;
            case AttributeTargetKind.Method: return System.AttributeTargets.Method;
            case AttributeTargetKind.Property: return System.AttributeTargets.Property;
            case AttributeTargetKind.Event: return System.AttributeTargets.Event;
            case AttributeTargetKind.Module: return System.AttributeTargets.Module;
            case AttributeTargetKind.Assembly: return System.AttributeTargets.Assembly;
            case AttributeTargetKind.GenericParam: return System.AttributeTargets.GenericParameter;
            case AttributeTargetKind.Type: return typePositionFallback;
            default: return System.AttributeTargets.All;
        }
    }

    /// <summary>
    /// Tries to bind an attribute argument expression as a compile-time
    /// constant value of one of the shapes permitted by ECMA-335 II.23.3 /
    /// ADR-0047 §3: literal (numeric, char, string, bool, nil), a
    /// <c>typeof(T)</c> expression (carried as the resolved CLR
    /// <see cref="Type"/>), or a single-dimensional array literal of any
    /// supported element shape. Returns <c>false</c> for any expression the
    /// emitter cannot serialise.
    /// </summary>
    /// <param name="syntax">The argument expression.</param>
    /// <param name="value">The extracted compile-time value when the method returns <c>true</c>.</param>
    /// <param name="type">The static type carried by the argument when the method returns <c>true</c>.</param>
    /// <returns><c>true</c> if the expression maps to a supported attribute constant; otherwise <c>false</c>.</returns>
    private bool TryBindAttributeArgument(ExpressionSyntax syntax, out object value, out TypeSymbol type)
    {
        value = null;
        type = null;

        switch (syntax)
        {
            case LiteralExpressionSyntax literal:
                if (bindExpression(literal) is BoundLiteralExpression bl)
                {
                    value = bl.Value;
                    type = bl.Type;
                    return true;
                }

                return false;

            case TypeOfExpressionSyntax typeOfSyntax:
                if (bindTypeOfExpression(typeOfSyntax) is BoundTypeOfExpression bt
                    && bt.OperandType?.ClrType is { } clr)
                {
                    value = clr;
                    type = bt.Type;
                    return true;
                }

                return false;

            case ArrayCreationExpressionSyntax arraySyntax:
                return TryBindAttributeArrayArgument(arraySyntax, out value, out type);
        }

        // Issue #177: accept BoundLiteralExpression whose static type is an
        // enum (e.g. `AttributeTargets.Method`) — required by [AttributeUsage]
        // and other enum-valued attribute arguments. The emitter serialises
        // the underlying primitive per ECMA-335 II.23.3. Other expressions
        // that incidentally fold to a constant (e.g. `nameof(...)`) remain
        // out of scope here; they go through GS0202.
        if (bindExpression(syntax) is BoundLiteralExpression lit
            && lit.Value != null
            && IsEnumLikeType(lit.Type))
        {
            value = lit.Value;
            type = lit.Type;
            return true;
        }

        return false;
    }

    private bool TryBindAttributeArrayArgument(
        ArrayCreationExpressionSyntax syntax,
        out object value,
        out TypeSymbol type)
    {
        value = null;
        type = null;

        if (bindArrayCreationExpression(syntax) is not BoundArrayCreationExpression bound)
        {
            return false;
        }

        // Attribute arrays must be a serialisable SZARRAY (1-D) shape per
        // ECMA-335 II.23.3. Both `[]T{...}` (slice) and `[N]T{...}` (array)
        // produce a CLR `T[]` for the element type clause.
        var clrArrayType = bound.Type?.ClrType;
        if (clrArrayType == null || !clrArrayType.IsArray || clrArrayType.GetArrayRank() != 1)
        {
            return false;
        }

        var elementClrType = clrArrayType.GetElementType();
        if (elementClrType == null)
        {
            return false;
        }

        var result = Array.CreateInstance(elementClrType, syntax.Elements.Count);
        for (int i = 0; i < syntax.Elements.Count; i++)
        {
            if (!TryBindAttributeArgument(syntax.Elements[i], out var elementValue, out _))
            {
                return false;
            }

            try
            {
                result.SetValue(CoerceAttributeElement(elementValue, elementClrType), i);
            }
            catch
            {
                return false;
            }
        }

        value = result;
        type = bound.Type;
        return true;
    }

    /// <summary>
    /// Issue #660: for test-data attributes like xUnit's <c>@InlineData</c>,
    /// cross-validates nil (null) positional arguments against the owning
    /// method's parameter types. If a nil is supplied for a non-nullable
    /// parameter, reports GS0274.
    /// </summary>
    internal void ValidateInlineDataNilArguments(
        ImmutableArray<BoundAttribute> attributes,
        ImmutableArray<ParameterSymbol> parameters)
    {
        foreach (var attr in attributes)
        {
            if (attr == null)
            {
                continue;
            }

            // Match the InlineDataAttribute by CLR type name (handles any xunit version).
            var clrType = attr.AttributeType?.ClrType;
            if (clrType == null || !clrType.FullName.EndsWith("InlineDataAttribute", StringComparison.Ordinal))
            {
                continue;
            }

            var positional = attr.PositionalArguments;
            var annotation = attr.Syntax;
            if (annotation == null || positional.IsDefaultOrEmpty || parameters.IsDefaultOrEmpty)
            {
                continue;
            }

            // InlineData's positional arguments are expanded into the params
            // object[] — each positional arg[i] corresponds to method parameter[i].
            var argExpressions = annotation.Arguments;
            for (int i = 0; i < positional.Length && i < parameters.Length; i++)
            {
                if (positional[i].Value == null && positional[i].Type == TypeSymbol.Null)
                {
                    var paramType = parameters[i].Type;
                    if (paramType != null && !(paramType is NullableTypeSymbol))
                    {
                        // Get the source location of the nil literal in the argument list.
                        var argLocation = i < argExpressions.Count
                            ? argExpressions[i].Location
                            : annotation.Location;
                        Diagnostics.ReportNilNotAssignableToNonNullableParameter(
                            argLocation,
                            parameters[i].Name,
                            paramType.Name);
                    }
                }
            }
        }
    }

    private static object CoerceAttributeElement(object value, Type elementType)
    {
        if (value == null || elementType.IsInstanceOfType(value))
        {
            return value;
        }

        if (elementType.IsEnum)
        {
            var underlying = Enum.GetUnderlyingType(elementType);
            return Convert.ChangeType(value, underlying, System.Globalization.CultureInfo.InvariantCulture);
        }

        // Numeric / char widening between primitives (e.g. int → long).
        return Convert.ChangeType(value, elementType, System.Globalization.CultureInfo.InvariantCulture);
    }
}
