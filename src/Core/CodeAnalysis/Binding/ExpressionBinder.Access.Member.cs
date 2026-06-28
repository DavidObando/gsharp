// <copyright file="ExpressionBinder.Access.Member.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
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
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{

    /// <summary>
    /// Issue #503 follow-up: rotates a right-associative member-access chain
    /// into the canonical left-associative form so the rightmost identifier is
    /// the immediate <see cref="AccessorExpressionSyntax.RightPart"/>. The
    /// parser produces <c>A . (B . C)</c> for <c>A.B.C</c>; this helper
    /// rewrites it as <c>(A . B) . C</c> so the event-subscription binder can
    /// treat the LHS uniformly (receiver expression on the left, event name on
    /// the right) regardless of how many segments the receiver chain has.
    /// </summary>
    private AccessorExpressionSyntax NormalizeAccessorLeftAssociative(AccessorExpressionSyntax accessor)
    {
        while (accessor.RightPart is AccessorExpressionSyntax rightChain)
        {
            var newLeft = new AccessorExpressionSyntax(
                accessor.SyntaxTree,
                accessor.LeftPart,
                accessor.DotToken,
                rightChain.LeftPart);
            accessor = new AccessorExpressionSyntax(
                accessor.SyntaxTree,
                newLeft,
                rightChain.DotToken,
                rightChain.RightPart);
        }

        return accessor;
    }

    private static BoundMethodGroupExpression BuildInstanceMethodGroup(BoundExpression receiver, ImmutableArray<FunctionSymbol> methods)
    {
        if (methods.Length == 1)
        {
            var only = methods[0];
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(only.Parameters.Length);
            foreach (var p in only.Parameters)
            {
                paramTypes.Add(p.Type);
            }

            var fnType = FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), only.Type ?? TypeSymbol.Void);
            return new BoundMethodGroupExpression(null, receiver, only, fnType);
        }

        return new BoundMethodGroupExpression(null, receiver, methods);
    }

    /// <summary>
    /// ADR-0112 §"method-group semantics": builds a <see cref="BoundMethodGroupExpression"/>
    /// for a user-defined type's method(s). A <paramref name="receiver"/> of
    /// <see langword="null"/> yields a static (null-target) group; a non-null
    /// receiver yields an instance group captured against it. Candidates that
    /// cannot participate in a method-group→delegate conversion (generic or
    /// variadic) are filtered out; the group is only produced when at least one
    /// usable candidate remains.
    /// </summary>
    private static bool TryBuildUserMethodGroup(BoundExpression receiver, ImmutableArray<FunctionSymbol> methods, out BoundExpression methodGroup)
    {
        methodGroup = null;

        if (methods.IsDefaultOrEmpty)
        {
            return false;
        }

        var usable = ImmutableArray.CreateBuilder<FunctionSymbol>(methods.Length);
        foreach (var m in methods)
        {
            if (m.IsGeneric)
            {
                continue;
            }

            var hasVariadic = false;
            foreach (var parameter in m.Parameters)
            {
                if (parameter.IsVariadic)
                {
                    hasVariadic = true;
                    break;
                }
            }

            if (hasVariadic)
            {
                continue;
            }

            usable.Add(m);
        }

        if (usable.Count == 0)
        {
            return false;
        }

        methodGroup = BuildInstanceMethodGroup(receiver, usable.ToImmutable());
        return true;
    }

    /// <summary>
    /// Issue #569: resolves a dotted prefix + terminal name as an outer type
    /// containing a nested type. The prefix is split at each dot position to
    /// find the outer type, then remaining segments and the terminal name are
    /// walked as nested types via <see cref="ReferenceResolver.TryResolveNestedType"/>.
    /// </summary>
    private bool TryResolveAsNestedTypeChain(string namespacePrefix, string typeSimpleName, int arity, CallExpressionSyntax terminalCall, out System.Type clrType)
    {
        clrType = null;
        if (string.IsNullOrEmpty(namespacePrefix))
        {
            return false;
        }

        var prefixSegments = namespacePrefix.Split('.');

        // Try each split point: first N segments are a type name, remaining
        // segments + terminal name are nested types. Start from the longest
        // outer prefix (most specific) first.
        for (var outerLen = prefixSegments.Length; outerLen >= 1; outerLen--)
        {
            var outerName = string.Join(".", prefixSegments, 0, outerLen);
            System.Type outerType = null;

            // Try resolving the outer name directly.
            if (!scope.References.TryResolveType(outerName, out outerType))
            {
                // Try with each import prefix.
                foreach (var import in scope.GetDeclaredImports())
                {
                    var qualified = import.Target + "." + outerName;
                    if (scope.References.TryResolveType(qualified, out outerType))
                    {
                        break;
                    }
                }
            }

            if (outerType == null)
            {
                continue;
            }

            // Walk remaining prefix segments as nested types.
            var current = outerType;
            var walkFailed = false;
            for (var i = outerLen; i < prefixSegments.Length; i++)
            {
                if (!scope.References.TryResolveNestedType(current, prefixSegments[i], out var next))
                {
                    walkFailed = true;
                    break;
                }

                current = next;
            }

            if (walkFailed)
            {
                continue;
            }

            // Now resolve the terminal name as a nested type of `current`.
            System.Type nestedType = null;
            if (arity > 0)
            {
                scope.References.TryResolveNestedType(current, typeSimpleName + "`" + arity, out nestedType);
            }

            if (nestedType == null)
            {
                scope.References.TryResolveNestedType(current, typeSimpleName, out nestedType);
            }

            if (nestedType == null)
            {
                continue;
            }

            // Close the generic if type arguments are supplied.
            if (arity > 0 && nestedType.IsGenericTypeDefinition)
            {
                var clrArgs = new System.Type[arity];
                var argsResolved = true;
                for (var i = 0; i < arity; i++)
                {
                    var ta = bindTypeClause(terminalCall.TypeArgumentList.Arguments[i]);
                    if (ta?.ClrType == null)
                    {
                        argsResolved = false;
                        break;
                    }

                    clrArgs[i] = scope.References.MapClrTypeToReferences(ta.ClrType);
                }

                if (!argsResolved)
                {
                    continue;
                }

                try
                {
                    clrType = nestedType.MakeGenericType(clrArgs);
                    return true;
                }
                catch (System.ArgumentException)
                {
                    continue;
                }
            }
            else if (nestedType.IsGenericTypeDefinition)
            {
                continue;
            }

            clrType = nestedType;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1323: binds a <see cref="GenericNameExpressionSyntax"/> that
    /// appears in value position rather than as a member-access receiver. A
    /// constructed generic type reference is not itself a value, so this reports
    /// a diagnostic. (In practice the parser only emits this node immediately
    /// before a `.` member access, which <see cref="BindAccessorExpression"/>
    /// handles via the accessor leftPart switch.)
    /// </summary>
    private BoundExpression BindGenericNameExpression(GenericNameExpressionSyntax syntax)
    {
        Diagnostics.ReportExpressionMustHaveValue(syntax.Location);
        return new BoundErrorExpression(null);
    }

    private BoundExpression BindAccessorExpression(AccessorExpressionSyntax syntax)
    {
        // Issue #1323: a GenericNameExpression only arises from the parser as the
        // receiver of a member access; the accessor leftPart switch below resolves
        // it to a constructed generic type. See BindGenericNameExpression for the
        // standalone (non-receiver) diagnostic path.
        // Phase 3.C.3b / ADR-0001: null-conditional access `lhs?.rhs`.
        // Evaluate the receiver once, capture it into a synthetic local,
        // then bind the rest of the access against the capture so the
        // subtree can be evaluated against the non-nil value without a
        // second evaluation of the receiver expression.
        if (syntax.IsNullConditional)
        {
            return BindNullConditionalAccessExpression(syntax);
        }

        // Issue #293: a fully-qualified imported-type constructor
        // (`System.Text.StringBuilder()`, `System.Collections.Generic.List[int]()`)
        // parses as an accessor chain whose terminal segment is the call, so it
        // never reaches the simple-name constructor path in BindCallExpression.
        // Resolve it the same way here so construction works identically whether
        // written as a simple name or a fully-qualified path, at top level and
        // inside function/method bodies alike.
        if (TryBindQualifiedClrConstructorCall(syntax, out var qualifiedCtorCall))
        {
            return qualifiedCtorCall;
        }

        // Issue #1069: a nested user type referenced by a qualified name from
        // outside its enclosing type (`Outer.Entry(...)`, `Outer.Inner().M()`).
        // Nested types are also visible by their simple name in the flat package
        // scope, so an enclosing-type qualifier in front of a nested-type
        // construction/member-access is redundant: peel it off and bind the
        // remainder by simple name. This mirrors how the enclosing type's own
        // members reference a sibling nested type. It only fires when the left
        // segment is a user aggregate type and the next segment names one of its
        // nested types, and never for a bare-name terminal segment (handled as a
        // type receiver below), so it cannot shadow ordinary static-member access.
        if (syntax.LeftPart is NameExpressionSyntax enclosingNameSyntax
            && syntax.RightPart is not NameExpressionSyntax
            && scope.TryLookupSymbol(enclosingNameSyntax.IdentifierToken.Text) is not VariableSymbol
            && scope.TryLookupTypeAlias(enclosingNameSyntax.IdentifierToken.Text, out var enclosingAliasType)
            && IsUserAggregateType(enclosingAliasType)
            && TryGetHeadIdentifier(syntax.RightPart, out var headIdentifier))
        {
            // Issue #1174: when a top-level type shares the nested type's simple
            // name, re-binding the right part by simple name would resolve to the
            // top-level homonym (which holds the simple key). Resolve the nested
            // type by (container, simpleName) and bind the qualified composite
            // literal directly against the NESTED definition so its members
            // resolve correctly.
            if (syntax.RightPart is StructLiteralExpressionSyntax nestedLiteral)
            {
                var literalArity = nestedLiteral.TypeArgumentList != null ? nestedLiteral.TypeArgumentList.Arguments.Count : -1;
                if (scope.TryLookupNestedTypeAlias(enclosingAliasType, headIdentifier, literalArity, out var nestedLiteralType)
                    && nestedLiteralType is StructSymbol nestedStructDef)
                {
                    return BindStructLiteralExpression(nestedLiteral, nestedStructDef);
                }
            }

            // No collision (the nested type still holds its simple key): peel off
            // the redundant enclosing-type qualifier and bind the remainder by
            // simple name. This mirrors how the enclosing type's own members
            // reference a sibling nested type.
            if (IsNestedTypeOf(headIdentifier, enclosingAliasType))
            {
                return BindExpression(syntax.RightPart);
            }
        }

        // Determine what the left side of the accessor is: either an imported
        // class (for static member access) or a value-producing expression (for
        // instance member access). Then apply the right side, which may itself
        // be a chain of accessors (e.g. Guid.NewGuid().ToString()).
        var leftPart = syntax.LeftPart;
        var rightPart = syntax.RightPart;
        BoundExpression receiver = null;
        ImportedClassSymbol classSymbol = null;
        EnumSymbol enumSymbol = null;
        StructSymbol userStructSymbol = null;
        InterfaceSymbol userInterfaceSymbol = null;

        if (leftPart is NameExpressionSyntax leftName)
        {
            var name = leftName.IdentifierToken.Text;
            var variableHit = scope.TryLookupSymbol(name) as VariableSymbol;

            // Issue #986: `base.M(args)` — a non-virtual call to the nearest
            // base class implementation of `M`, mirroring C# `base.M(...)`.
            // Issue #1104: `base.Prop` — a non-virtual read of the nearest base
            // class implementation of property `Prop`, mirroring C# `base.Prop`.
            // `base` is a contextual keyword: only intercepted when it is not a
            // real value in scope (so a hypothetical local named `base` still
            // wins).
            if (name == "base" && variableHit == null && rightPart is CallExpressionSyntax baseCall)
            {
                return BindBaseClassCall(baseCall, leftName.Location, explicitBaseType: null, selectorLocation: leftName.Location);
            }

            if (name == "base" && variableHit == null && rightPart is NameExpressionSyntax basePropName)
            {
                return BindBaseClassPropertyRead(basePropName, leftName.Location, explicitBaseType: null, selectorLocation: leftName.Location);
            }

            // Issue #1147 (Facet A — "Color Color" + unified overload
            // resolution): when the receiver name binds to BOTH an in-scope
            // value AND a same-named user struct/class, and the right-hand side
            // is a CALL to a method declared as BOTH an instance and a static
            // (`shared`) overload, neither the value nor the type interpretation
            // is correct on its own. Resolve the call against the COMBINED
            // instance + static overload set (C# §12.8.7.1) and route by the
            // selected method's IsStatic: an instance overload binds the VALUE
            // as the receiver; a static overload binds against the TYPE. This is
            // strictly scoped to the both-buckets-non-empty case, so a
            // static-only member name still falls through to the #687 type path
            // below and an instance-only name still falls through to the
            // value/instance path — both unchanged.
            if (variableHit != null
                && rightPart is CallExpressionSyntax colorColorCall
                && TryResolveColorColorType(name, leftName, out _, out var unifiedColorStruct, out _)
                && unifiedColorStruct != null
                && TryBindColorColorUnifiedCall(unifiedColorStruct, leftName, colorColorCall, out var unifiedColorResult))
            {
                return unifiedColorResult;
            }

            // Issue #687 (Option A — C#-style "color color"): when an identifier
            // resolves to both a value (field/local/parameter) AND a same-named
            // type in scope, prefer the type interpretation if the right-hand
            // side of the accessor is a static member of that type. Fall through
            // to the value interpretation otherwise so instance access continues
            // to bind as today (`field.InstanceMethod()`).
            if (variableHit != null
                && TryResolveColorColorType(name, leftName, out var colorClassSymbol, out var colorStructSymbol, out var colorEnumSymbol)
                && RightPartLooksLikeStaticMember(colorClassSymbol, colorStructSymbol, colorEnumSymbol, rightPart))
            {
                if (colorClassSymbol != null)
                {
                    classSymbol = colorClassSymbol;
                }
                else if (colorStructSymbol != null)
                {
                    userStructSymbol = colorStructSymbol;
                }
                else
                {
                    enumSymbol = colorEnumSymbol;
                }
            }
            else if (variableHit is VariableSymbol variable)
            {
                if (variable is ImplicitFieldVariableSymbol implicitField)
                {
                    // Bare field name inside a method: rebind as `this.field`
                    // so chained access (`Field.Sub`) emits a load of the
                    // backing field through the `this` receiver.
                    // Issue #186 / #175: implicit field as accessor receiver
                    // fires GS0204 if the field carries `@Obsolete`.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitField.Field,
                        $"{implicitField.StructType.Name}.{implicitField.Field.Name}");

                    // Issue #208: apply any [MemberNotNull] narrowing so that
                    // chained access like `_name.Length` after a [MemberNotNull]
                    // call is accepted without a nil-guard.
                    receiver = new BoundFieldAccessExpression(
                        null,
                        new BoundVariableExpression(null, implicitField.Receiver),
                        implicitField.StructType,
                        implicitField.Field,
                        TryGetNarrowedType(implicitField));
                }
                else if (variable is ImplicitStaticFieldVariableSymbol implicitStaticField)
                {
                    // Issue #261: bare static field name as accessor receiver
                    // inside a shared method body.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticField.Field,
                        $"{implicitStaticField.OwnerName}.{implicitStaticField.Field.Name}");

                    // Issue #1030: an interface-owned static field carries its
                    // owning interface (self-instantiation for a generic
                    // interface) so emit/interpreter resolve it correctly.
                    receiver = implicitStaticField.InterfaceType != null
                        ? new BoundFieldAccessExpression(null, implicitStaticField.Field, implicitStaticField.InterfaceType)
                        : new BoundFieldAccessExpression(
                            null,
                            receiver: null,
                            implicitStaticField.StructType,
                            implicitStaticField.Field);
                }
                else if (variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp)
                {
                    // ADR-0053: bare static property name as accessor receiver
                    // (e.g., `StaticProp.Sub` inside a method body of the
                    // enclosing type).
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticProp.Property,
                        $"{implicitStaticProp.StructType.Name}.{implicitStaticProp.Property.Name}");

                    if (!implicitStaticProp.Property.HasGetter)
                    {
                        Diagnostics.ReportCannotAssign(leftName.IdentifierToken.Location, implicitStaticProp.Property.Name);
                        return new BoundErrorExpression(null);
                    }

                    receiver = new BoundPropertyAccessExpression(
                        null,
                        receiver: null,
                        implicitStaticProp.StructType,
                        implicitStaticProp.Property);
                }
                else
                {
                    receiver = new BoundVariableExpression(null, variable, TryGetNarrowedType(variable));
                }
            }
            else if (scope.TryLookupImport(name, out var matchedImport)
                && TryBindImportAccessor(matchedImport, ref rightPart, out var typeFromImport))
            {
                classSymbol = typeFromImport;
            }
            else if (scope.TryLookupImportedClass(name, leftName, out var importedClass))
            {
                classSymbol = importedClass;
            }
            else if (scope.TryLookupTypeAlias(name, out var typeAlias))
            {
                if (typeAlias is EnumSymbol foundEnum)
                {
                    enumSymbol = foundEnum;
                }
                else if (typeAlias is StructSymbol foundStruct)
                {
                    userStructSymbol = foundStruct;
                }
                else if (typeAlias is InterfaceSymbol foundInterface)
                {
                    // ADR-0089 / issue #1030: `IName.StaticField` — qualified
                    // access to an interface static field (storage or const).
                    userInterfaceSymbol = foundInterface;
                }
                else
                {
                    Diagnostics.ReportUnableToFindType(leftName.Location, name);
                    return new BoundErrorExpression(null);
                }
            }
            else if (binderCtx.CurrentTypeParameters != null
                && binderCtx.CurrentTypeParameters.TryGetValue(name, out var tpSym))
            {
                // ADR-0089 / issue #755: `T.Member(args)` where `T` is a
                // generic type parameter with an interface constraint
                // dispatches to a static-virtual interface member. We
                // delegate to a helper that resolves the rightPart against
                // the constraint interface's static-virtual table.
                return BindTypeParameterStaticAccessorStep(tpSym, leftName, rightPart);
            }
            else if (TryResolvePredefinedTypeReceiver(name, leftName, out var predefinedClass))
            {
                // Issue #919: a lowercase predefined primitive type alias used as
                // the receiver of a static member access (e.g. `string.Empty`,
                // `int32.MaxValue`). The earlier import/alias lookups only match
                // the capitalized CLR name (`String`, `Int32`); the keyword form
                // is resolved here to the same underlying CLR type so static
                // member access binds identically to the capitalized form.
                classSymbol = predefinedClass;
            }
            else
            {
                Diagnostics.ReportUnableToFindType(leftName.Location, name);
                return new BoundErrorExpression(null);
            }
        }
        else if (leftPart is IndexExpressionSyntax genericTypeIndex
            && !genericTypeIndex.IsNullConditional
            && TryResolveConstructedGenericTypeReceiver(
                genericTypeIndex,
                out var constructedStruct,
                out var constructedInterface,
                out var constructedImported))
        {
            // Issue #1209 (extends ADR-0089 / issue #1030): a generic-type
            // reference with explicit type arguments used in expression /
            // member-access receiver position — `Box[int32].Default`,
            // `ArrayPool[uint8].Shared`, `Comparer[int32].Default`. The parser
            // shapes `Name[Arg]` as an index expression; when `Name` is NOT a
            // value but IS a generic type definition of matching arity (user
            // class/struct, user interface, or imported CLR generic), bind the
            // whole `Name[Arg]` as the constructed generic *type* receiver
            // rather than as element access. The closed construction is carried
            // so static-member access (and static method calls) resolve against
            // the construction.
            if (constructedInterface != null)
            {
                userInterfaceSymbol = constructedInterface;
            }
            else if (constructedStruct != null)
            {
                userStructSymbol = constructedStruct;
            }
            else
            {
                classSymbol = constructedImported;
            }
        }
        else if (leftPart is GenericNameExpressionSyntax genericTypeName
            && TryResolveConstructedGenericTypeReceiver(
                genericTypeName,
                out var genericConstructedStruct,
                out var genericConstructedInterface,
                out var genericConstructedImported))
        {
            // Issue #1323: a constructed generic *type* reference used as a
            // member-access receiver where the type argument is unambiguously a
            // type (`Box[int32?].Make(5)`, `Box[[]int32].Make(5)`,
            // `Box[List[int32]].Make(5)`, `Pair[int, string].Default`). The
            // parser emits a GenericNameExpression here (the bracket contents
            // cannot be reshaped from an index expression), so bind the closed
            // construction directly as the static-access receiver.
            if (genericConstructedInterface != null)
            {
                userInterfaceSymbol = genericConstructedInterface;
            }
            else if (genericConstructedStruct != null)
            {
                userStructSymbol = genericConstructedStruct;
            }
            else
            {
                classSymbol = genericConstructedImported;
            }
        }
        else if (leftPart is AccessorExpressionSyntax qualifiedNestedType
            && !qualifiedNestedType.IsNullConditional
            && TryResolveQualifiedUserNestedType(qualifiedNestedType, out var qualifiedNestedSymbol))
        {
            // Issue #1069: a qualified nested *type* used as the receiver of a
            // further member access, e.g. `Outer.Color.Red` (the `Outer.Color`
            // sub-chain names the nested enum) or `Outer.Inner.StaticMember`.
            switch (qualifiedNestedSymbol)
            {
                case EnumSymbol qualifiedEnum:
                    enumSymbol = qualifiedEnum;
                    break;
                case StructSymbol qualifiedStruct:
                    userStructSymbol = qualifiedStruct;
                    break;
                case InterfaceSymbol qualifiedInterface:
                    userInterfaceSymbol = qualifiedInterface;
                    break;
                default:
                    receiver = BindExpression(leftPart);
                    break;
            }
        }
        else
        {
            receiver = BindExpression(leftPart);
        }

        if (enumSymbol != null)
        {
            return BindEnumAccessorStep(enumSymbol, rightPart);
        }

        if (userStructSymbol != null)
        {
            return BindUserTypeStaticAccessorStep(userStructSymbol, rightPart);
        }

        if (userInterfaceSymbol != null)
        {
            return BindInterfaceStaticAccessorStep(userInterfaceSymbol, rightPart);
        }

        return BindAccessorStep(receiver, classSymbol, rightPart);
    }

    /// <summary>
    /// Issue #1069: returns the enclosing (containing) type of a user-defined
    /// nested type symbol, or <see langword="null"/> for a top-level type or a
    /// kind that cannot be nested.
    /// </summary>
    private static TypeSymbol GetSymbolContainingType(TypeSymbol type) => type switch
    {
        StructSymbol s => s.ContainingType,
        EnumSymbol e => e.ContainingType,
        InterfaceSymbol i => i.ContainingType,
        _ => null,
    };

    /// <summary>
    /// Issue #1213: whether the function currently being bound belongs to
    /// <paramref name="type"/> (or a type derived from it). Used to gate
    /// in-type resolution of a field-like event to its private backing
    /// delegate field, matching C# (an event name in expression position is
    /// only valid inside the declaring type).
    /// </summary>
    private bool IsWithinType(StructSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        var enclosingType = (this.function?.ReceiverType as StructSymbol)
            ?? (this.function?.StaticOwnerType as StructSymbol);

        for (var t = enclosingType; t != null; t = t.BaseClass)
        {
            if (ReferenceEquals(t, type)
                || (t.Declaration != null && ReferenceEquals(t.Declaration, type.Declaration)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1069: returns the leftmost identifier of an accessor-chain segment
    /// (the head of a call, index, accessor, or bare name), used to detect when a
    /// qualified reference targets a nested type by its simple name.
    /// </summary>
    private static bool TryGetHeadIdentifier(ExpressionSyntax expression, out string identifier)
    {
        switch (expression)
        {
            case NameExpressionSyntax name:
                identifier = name.IdentifierToken.Text;
                return true;
            case CallExpressionSyntax call:
                identifier = call.Identifier.Text;
                return true;
            case AccessorExpressionSyntax accessor:
                return TryGetHeadIdentifier(accessor.LeftPart, out identifier);
            case IndexExpressionSyntax index:
                return TryGetHeadIdentifier(index.Target, out identifier);
            case StructLiteralExpressionSyntax structLiteral:
                identifier = structLiteral.TypeIdentifier.Text;
                return true;
            case ObjectCreationExpressionSyntax objectCreation:
                return TryGetHeadIdentifier(objectCreation.Target, out identifier);
            default:
                identifier = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #919: resolves a lowercase predefined primitive type alias used as
    /// the receiver of a static member access (e.g. <c>string.Empty</c>,
    /// <c>int32.MaxValue</c>, <c>object.ReferenceEquals(...)</c>) to an
    /// <see cref="ImportedClassSymbol"/> over its underlying CLR type.
    /// </summary>
    /// <remarks>
    /// This runs only after the import/alias/imported-class lookups have failed,
    /// so it never shadows a user alias or an imported type. The keyword aliases
    /// (<c>string</c>, <c>int32</c>, <c>bool</c>, ...) are reserved names that
    /// cannot be redeclared, so resolving them here is unambiguous and mirrors
    /// the capitalized CLR-name form (<c>String</c>, <c>Int32</c>) that already
    /// binds through <see cref="BoundScope.TryLookupImportedClass"/>.
    /// </remarks>
    /// <param name="name">The identifier text written as the accessor receiver.</param>
    /// <param name="declaration">The receiver name syntax (for symbol provenance).</param>
    /// <param name="classSymbol">The resolved CLR class symbol on success.</param>
    /// <returns><see langword="true"/> when <paramref name="name"/> is a predefined primitive alias with a backing CLR type.</returns>
    private bool TryResolvePredefinedTypeReceiver(string name, ExpressionSyntax declaration, out ImportedClassSymbol classSymbol)
    {
        classSymbol = null;

        var typeSymbol = lookupType(name);

        // Only genuine predefined primitive aliases carry a non-null ClrType and
        // are not already handled by an earlier branch. User struct/enum aliases
        // (resolved by TryLookupTypeAlias) have a null ClrType and are excluded.
        // `void` has a CLR type but is meaningless as a static-access receiver, so
        // exclude it and let the normal "cannot find type" diagnostic apply.
        if (typeSymbol == null
            || typeSymbol.ClrType == null
            || ReferenceEquals(typeSymbol, TypeSymbol.Void))
        {
            return false;
        }

        classSymbol = new ImportedClassSymbol(typeSymbol.ClrType, declaration);
        return true;
    }

    private BoundExpression BindNullConditionalAccessExpression(AccessorExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.LeftPart);
        if (receiver is BoundErrorExpression)
        {
            return receiver;
        }

        return BindNullConditionalAccessExpressionCore(receiver, syntax.RightPart);
    }

    private BoundExpression BindNullConditionalAccessExpressionCore(BoundExpression receiver, ExpressionSyntax rightPart)
    {
        var receiverType = receiver.Type;
        TypeSymbol underlying;
        if (receiverType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
        }
        else if (receiverType == TypeSymbol.Null)
        {
            // `nil?.x` is statically nil.
            return new BoundLiteralExpression(null, null);
        }
        else
        {
            // Non-nullable receiver: `?.` collapses to `.`, but we still
            // produce a nullable result type for syntactic consistency.
            underlying = receiverType;
        }

        // Create a synthetic capture local. Name is not user-visible; we
        // include a leading `$` so it cannot collide with user identifiers.
        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);

        // Bind the access using the capture as the receiver. We push a temp
        // scope so the capture is in scope for any nested name lookup that
        // happens during access binding (defensive — current accessor paths
        // don't look up the receiver by name).
        scope = new BoundScope(scope);
        scope.TryDeclareVariable(capture);

        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = BindAccessorStep(captureRef, null, rightPart);

        scope = scope.Parent;

        // Issue #1213: a null-conditional invocation whose access produces no
        // value — the canonical event-raise form `evt?.Invoke(args)` where the
        // delegate returns `void` — is itself a `void` statement. Do not wrap
        // `void` in a nullable result type; that would force the emitter to
        // push a `null` on the nil branch with nothing to match it on the
        // not-null branch (a stack-imbalance). The emitter special-cases a
        // `void`-typed null-conditional to a plain null-guarded call.
        if (ReferenceEquals(whenNotNull.Type, TypeSymbol.Void))
        {
            return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, TypeSymbol.Void, resultSlot: null);
        }

        var resultType = whenNotNull.Type is NullableTypeSymbol ? whenNotNull.Type : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

        // P2-7 / Issue #421: when the access result is a value type, the
        // bound result type is `Nullable<T>` but the not-null branch pushes
        // a raw `T` and the nil branch would push `null`. The emitter needs
        // a typed temp slot to materialize `default(Nullable<T>)` for the
        // nil branch (initobj) and to host the wrapped value for the
        // not-null branch (newobj `Nullable<T>::.ctor(!0)`). We allocate
        // that synthetic slot here so the emit pre-pass can give it a
        // local index alongside the capture local.
        //
        // ADR-0073 / issue #710: chained `?.`/`?[]` can yield a
        // `WhenNotNull` that is itself already a `Nullable<T>`. In that
        // case both branches still need to leave a Nullable<T> on the
        // stack, so we MUST allocate the slot whenever the *result type's
        // underlying* is a value type — even if `whenNotNull.Type` is
        // already nullable. The emitter inspects `WhenNotNull.Type` to
        // decide whether to wrap with `newobj` or pass through.
        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && nullableResult.UnderlyingType?.ClrType is { IsValueType: true })
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }
}
