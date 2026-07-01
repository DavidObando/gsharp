// <copyright file="ExpressionBinder.Access.cs" company="GSharp">
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

    private BoundMethodGroupExpression BuildInstanceMethodGroup(BoundExpression receiver, ImmutableArray<FunctionSymbol> methods)
    {
        if (methods.Length == 1)
        {
            var only = methods[0];
            var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(only.Parameters.Length);
            foreach (var p in only.Parameters)
            {
                paramTypes.Add(p.Type);
            }

            var fnType = FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), this.MethodGroupObservableReturnType(only));
            return new BoundMethodGroupExpression(null, receiver, only, fnType);
        }

        return new BoundMethodGroupExpression(null, receiver, methods);
    }

    // Issue #1467: a method group's natural delegate return type must match the
    // method's *observable* (emitted) return type. An async method symbol carries
    // a Void result for "async no-result" but the emitted state machine returns
    // Task, so the method-group natural delegate is Func&lt;Task&gt; (not Action).
    // Async iterators keep their IAsyncEnumerable return unchanged.
    private TypeSymbol MethodGroupObservableReturnType(FunctionSymbol function)
    {
        var declared = function.Type ?? TypeSymbol.Void;
        if (function.IsAsync && !isAsyncIteratorReturnType(declared))
        {
            return lambdas.WrapAsTask(declared);
        }

        return declared;
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
    private bool TryBuildUserMethodGroup(BoundExpression receiver, ImmutableArray<FunctionSymbol> methods, out BoundExpression methodGroup)
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
    /// Binds a fully-qualified imported-type constructor written in expression
    /// position, e.g. <c>System.Text.StringBuilder()</c> or
    /// <c>System.Collections.Generic.List[int]()</c>. Such an expression parses
    /// as an accessor chain whose terminal segment is the constructor call, so
    /// it never reaches <see cref="TryBindClrConstructorCall"/> (which only sees
    /// simple-name calls). This walks the dotted name, resolves the closed CLR
    /// type via the active references/imports, and reuses the shared
    /// constructor-binding core (issue #293).
    /// </summary>
    /// <param name="syntax">The accessor expression to bind.</param>
    /// <param name="result">The bound constructor call on success.</param>
    /// <returns>Whether the accessor was a fully-qualified constructor call that bound successfully.</returns>
    private bool TryBindQualifiedClrConstructorCall(AccessorExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;

        if (syntax.IsNullConditional)
        {
            return false;
        }

        // Flatten the accessor chain into the leading namespace/type segments
        // and the terminal constructor call. Anything that isn't a pure
        // dotted-name chain ending in a call is not a qualified constructor.
        var segments = new List<string>();
        ExpressionSyntax current = syntax;
        CallExpressionSyntax terminalCall = null;
        while (true)
        {
            if (current is AccessorExpressionSyntax accessor)
            {
                if (accessor.IsNullConditional || !(accessor.LeftPart is NameExpressionSyntax leftName))
                {
                    return false;
                }

                segments.Add(leftName.IdentifierToken.Text);
                current = accessor.RightPart;
                continue;
            }

            if (current is CallExpressionSyntax call)
            {
                terminalCall = call;
                break;
            }

            // A bare trailing name (`System.Text.StringBuilder` with no call)
            // is not a constructor invocation.
            return false;
        }

        if (terminalCall == null || terminalCall.Identifier.IsMissing)
        {
            return false;
        }

        var typeSimpleName = terminalCall.Identifier.Text;
        var namespacePrefix = string.Join(".", segments);

        if (!TryResolveQualifiedClrType(namespacePrefix, typeSimpleName, terminalCall, out var clrType, out var openGenericDef, out var symbolicArgs))
        {
            return false;
        }

        return TryBindClrConstructorFromType(clrType, terminalCall, out result, openGenericDef, symbolicArgs);
    }

    /// <summary>
    /// Resolves a closed CLR type from a fully-qualified dotted name written in
    /// source. Tries the name as written, the name with the leading segment
    /// expanded from a matching import alias/path, and the name prefixed by each
    /// active import target. Generic type arguments on <paramref name="terminalCall"/>
    /// are honoured by resolving the mangled open generic and closing it.
    /// </summary>
    /// <param name="namespacePrefix">The dotted segments preceding the type name (may be empty).</param>
    /// <param name="typeSimpleName">The simple type name (the constructor call identifier).</param>
    /// <param name="terminalCall">The terminal call, used for generic arity/arguments.</param>
    /// <param name="clrType">The resolved closed CLR type on success.</param>
    /// <param name="openGenericDefinition">
    /// Issue #671: when one or more type arguments are G# user-defined types
    /// (no CLR type at bind time), the closed CLR shape is type-erased to
    /// <see cref="object"/> placeholders and this is set to the open generic
    /// definition so the emitter can recover the symbolic form.
    /// <see langword="null"/> otherwise.
    /// </param>
    /// <param name="symbolicTypeArgs">
    /// Issue #671: the original symbolic type arguments in source order when
    /// any user-defined type substitution is in effect; default otherwise.
    /// </param>
    /// <returns>Whether a type was resolved.</returns>
    private bool TryResolveQualifiedClrType(
        string namespacePrefix,
        string typeSimpleName,
        CallExpressionSyntax terminalCall,
        out System.Type clrType,
        out System.Type openGenericDefinition,
        out ImmutableArray<TypeSymbol> symbolicTypeArgs)
    {
        clrType = null;
        openGenericDefinition = null;
        symbolicTypeArgs = default;

        var arity = terminalCall.TypeArgumentList?.Arguments.Count ?? 0;

        // Build the candidate dotted prefixes (everything before the simple
        // type name), most specific first.
        var prefixCandidates = new List<string>();
        var seenPrefixes = new HashSet<string>(System.StringComparer.Ordinal);
        if (!string.IsNullOrEmpty(namespacePrefix))
        {
            prefixCandidates.Add(namespacePrefix);
        }

        // If the leading segment is an import alias/path, expand it to the
        // import target (`import t = System.Text` then `t.StringBuilder()`).
        var firstSegment = namespacePrefix.Contains('.', System.StringComparison.Ordinal)
            ? namespacePrefix.Substring(0, namespacePrefix.IndexOf('.', System.StringComparison.Ordinal))
            : namespacePrefix;
        if (!string.IsNullOrEmpty(firstSegment) && scope.TryLookupImport(firstSegment, out var matchedImport))
        {
            var rest = namespacePrefix.Length > firstSegment.Length
                ? namespacePrefix.Substring(firstSegment.Length + 1)
                : string.Empty;
            var expanded = string.IsNullOrEmpty(rest) ? matchedImport.Target : matchedImport.Target + "." + rest;
            prefixCandidates.Insert(0, expanded);
        }

        // Also try the name relative to each active import target, mirroring the
        // simple-name lookup in BoundScope.TryLookupImportedClass.
        foreach (var import in scope.GetDeclaredImports())
        {
            var prefixed = string.IsNullOrEmpty(namespacePrefix) ? import.Target : import.Target + "." + namespacePrefix;
            prefixCandidates.Add(prefixed);
        }

        foreach (var prefix in prefixCandidates)
        {
            // Issue #854: the candidate list frequently contains duplicate
            // prefixes (e.g. the raw namespacePrefix also surfaces as an
            // import-relative candidate). Resolution is deterministic per name,
            // so probing the same prefix twice can never change the outcome —
            // skip repeats to avoid redundant resolver lookups and, in the
            // generic branch, redundant type-argument binding.
            if (!seenPrefixes.Add(prefix))
            {
                continue;
            }

            if (arity > 0)
            {
                var mangled = prefix + "." + typeSimpleName + "`" + arity;
                if (scope.References.TryResolveType(mangled, out var openType))
                {
                    var clrArgs = new System.Type[arity];
                    var symbolic = ImmutableArray.CreateBuilder<TypeSymbol>(arity);
                    var argsResolved = true;
                    var hasSymbolicArg = false;
                    for (var i = 0; i < arity; i++)
                    {
                        var ta = bindTypeClause(terminalCall.TypeArgumentList.Arguments[i]);
                        if (ta == null)
                        {
                            argsResolved = false;
                            break;
                        }

                        symbolic.Add(ta);

                        if (ta.ClrType == null)
                        {
                            // Issue #313 / #671: in-scope type parameter or
                            // user-defined G# type argument — close with a
                            // System.Object placeholder and preserve the
                            // symbolic argument for the emitter to recover.
                            hasSymbolicArg = true;
                            clrArgs[i] = scope.References.GetCoreType("System.Object");
                            continue;
                        }

                        // Type arguments resolve to gsc-host CLR types (e.g.
                        // primitives map to host typeof(...)), but openType may
                        // come from the resolver's isolated MetadataLoadContext.
                        // MakeGenericType requires every argument to share the
                        // open generic's load context, so project each argument
                        // onto the resolver's reference set first.
                        clrArgs[i] = scope.References.MapClrTypeToReferences(ta.ClrType);
                    }

                    if (!argsResolved)
                    {
                        continue;
                    }

                    try
                    {
                        clrType = openType.MakeGenericType(clrArgs);
                        if (hasSymbolicArg)
                        {
                            openGenericDefinition = openType;
                            symbolicTypeArgs = symbolic.MoveToImmutable();
                        }

                        return true;
                    }
                    catch (System.ArgumentException)
                    {
                        continue;
                    }
                }
            }
            else
            {
                var fullName = prefix + "." + typeSimpleName;
                if (scope.References.TryResolveType(fullName, out var resolved) && !resolved.IsGenericTypeDefinition)
                {
                    clrType = resolved;
                    return true;
                }
            }
        }

        // Issue #569: the dotted prefix may name an outer type (not a namespace),
        // with the terminal identifier being a nested type. Try resolving the
        // prefix as a type and then walking the terminal name as a nested type.
        // This covers `Outer.Inner()`, `Ns.Outer.Inner()`, and deeply-nested
        // chains like `Outer.Middle.Inner()` where the prefix segments include
        // both namespace and outer-type components.
        if (TryResolveAsNestedTypeChain(namespacePrefix, typeSimpleName, arity, terminalCall, out clrType))
        {
            return true;
        }

        return false;
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
                    receiver = BuildNarrowedRead(
                        new BoundFieldAccessExpression(
                            null,
                            new BoundVariableExpression(null, implicitField.Receiver),
                            implicitField.StructType,
                            implicitField.Field),
                        implicitField.Field.Type,
                        TryGetNarrowedType(implicitField),
                        nt => new BoundFieldAccessExpression(
                            null,
                            new BoundVariableExpression(null, implicitField.Receiver),
                            implicitField.StructType,
                            implicitField.Field,
                            nt));
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
                else if (variable is ImplicitPropertyVariableSymbol implicitProp)
                {
                    // Issue #1339: a bare instance-property name used as the
                    // receiver of a member access (`Prop.Member`, e.g.
                    // `Entries.Values`/`Items.Count`) must rebind as
                    // `this.Prop` so the getter call is emitted before the
                    // member access. Without this the property falls through to
                    // the bare-variable case below and emits as a load of a
                    // non-existent local slot named after the property (GS9998).
                    // Mirrors the static-property arm above and the standalone
                    // bare-name path in BindNameExpression.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitProp.Property,
                        $"{implicitProp.StructType.Name}.{implicitProp.Property.Name}");

                    if (!implicitProp.Property.HasGetter)
                    {
                        Diagnostics.ReportCannotAssign(leftName.IdentifierToken.Location, implicitProp.Property.Name);
                        return new BoundErrorExpression(null);
                    }

                    receiver = new BoundPropertyAccessExpression(
                        null,
                        new BoundVariableExpression(null, implicitProp.Receiver),
                        implicitProp.StructType,
                        implicitProp.Property);
                }
                else
                {
                    receiver = BuildNarrowedRead(
                        new BoundVariableExpression(null, variable),
                        variable.Type,
                        TryGetNarrowedType(variable),
                        narrowed => new BoundVariableExpression(null, variable, narrowed));
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
        else if (leftPart is IndexExpressionSyntax nestedTypeIndex
            && !nestedTypeIndex.IsNullConditional
            && TryResolveUserNestedTypeExpression(nestedTypeIndex, out var nestedTypeIndexSymbol))
        {
            // Issue #1537: a per-segment generic nested-type chain whose deepest
            // segment carries a SINGLE type argument parses as an index over the
            // preceding accessor (`Outer[int32].Middle[string]` is
            // `((Outer[int32]).Middle)[string]`), so it never reaches the
            // NAME-target index branch above. Resolve it as the constructed
            // nested type receiver (`Outer`1+Middle`2<int32, string>`) so the
            // trailing member access / composite literal binds against a type
            // whose members substitute every enclosing level.
            switch (nestedTypeIndexSymbol)
            {
                case EnumSymbol nestedIndexEnum:
                    enumSymbol = nestedIndexEnum;
                    break;
                case StructSymbol nestedIndexStruct:
                    userStructSymbol = nestedIndexStruct;
                    break;
                case InterfaceSymbol nestedIndexInterface:
                    userInterfaceSymbol = nestedIndexInterface;
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
    /// Issue #1069: a user-defined aggregate type (class/struct, enum, or
    /// interface) declared in the current compilation, as opposed to an imported
    /// CLR type or a predefined primitive alias.
    /// </summary>
    private static bool IsUserAggregateType(TypeSymbol type) =>
        type is StructSymbol or EnumSymbol or InterfaceSymbol;

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
    /// Issue #1069: whether <paramref name="name"/> resolves to a user-defined
    /// type whose enclosing type is <paramref name="container"/>.
    /// </summary>
    private bool IsNestedTypeOf(string name, TypeSymbol container) =>
        scope.TryLookupTypeAlias(name, out var candidate)
        && IsUserAggregateType(candidate)
        && ReferenceEquals(GetSymbolContainingType(candidate), container);

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
    /// Issue #1069: resolves a dotted accessor of the form
    /// <c>Outer.Nested</c> (optionally deeper, <c>A.B.C</c>) to the user-defined
    /// nested type it names, by walking the enclosing-type chain. Each segment
    /// after the first must name a user type whose enclosing type is the symbol
    /// resolved for the preceding segment. Returns <see langword="false"/> when
    /// the chain is not a pure user nested-type reference.
    /// </summary>
    private bool TryResolveQualifiedUserNestedType(AccessorExpressionSyntax accessor, out TypeSymbol nestedType)
        => TryResolveUserNestedTypeExpression(accessor, out nestedType);

    /// <summary>
    /// Issue #942/#1537: returns the leftmost (root) identifier of a candidate
    /// user-type-naming chain — the head of a bare name, generic name,
    /// per-segment index, or accessor — WITHOUT binding any bracketed contents.
    /// Used to gate the nested-type-chain probe on the head naming a user
    /// aggregate TYPE before any bracket is speculatively bound as a type
    /// argument, so a genuine indexer whose index is an identifier
    /// (<c>xs[i]</c>) is never probed as a constructed nested type. Mirrors the
    /// shapes accepted by <see cref="TryFlattenUserTypeExpressionSegments"/> so
    /// the gate never rejects a chain the core would otherwise flatten.
    /// </summary>
    /// <param name="expr">The candidate type-naming expression.</param>
    /// <param name="headName">The resolved root identifier on success.</param>
    /// <returns>Whether a root identifier could be extracted.</returns>
    private static bool TryGetUserTypeChainHead(ExpressionSyntax expr, out string headName)
    {
        switch (expr)
        {
            case NameExpressionSyntax name:
                headName = name.IdentifierToken.Text;
                return true;
            case GenericNameExpressionSyntax generic:
                headName = generic.Identifier.Text;
                return true;
            case IndexExpressionSyntax index when !index.IsNullConditional:
                return TryGetUserTypeChainHead(index.Target, out headName);
            case AccessorExpressionSyntax accessor when !accessor.IsNullConditional:
                return TryGetUserTypeChainHead(accessor.LeftPart, out headName);
            default:
                headName = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #1069/#1506/#1521/#1537: resolves an expression that names a
    /// (possibly nested, possibly per-segment generic) user type — e.g.
    /// <c>Outer.Middle</c>, <c>Outer[int32].Middle</c>,
    /// <c>Outer[int32].Middle[string]</c>, or the arbitrarily deep
    /// <c>Outer[int32].Middle[string].Inner[bool]</c> — to its constructed type
    /// symbol. The chain is flattened to per-segment (name, own type-arguments)
    /// pairs, each segment is resolved as a nested type of the previous one, and
    /// the deepest segment is constructed threading BOTH the flattened enclosing
    /// construction's arguments (outermost-first, occupying the low ordinals)
    /// and its own arguments, so member lookup substitutes every level and the
    /// emitter encodes the reified nested type (<c>Outer`1+Middle`2&lt;int32,
    /// string&gt;</c>). Generalizes to arbitrary depth and mixed generic /
    /// non-generic levels; a fully non-generic chain returns the definition
    /// unchanged (preserving #1069 behavior).
    /// </summary>
    /// <param name="expr">The type-naming expression (accessor or index chain).</param>
    /// <param name="nestedType">The resolved (possibly constructed) type symbol.</param>
    /// <returns>Whether the expression resolved to a user nested type.</returns>
    private bool TryResolveUserNestedTypeExpression(ExpressionSyntax expr, out TypeSymbol nestedType)
    {
        nestedType = null;

        // Issue #942 regression guard: this probe speculatively binds each
        // bracketed segment's contents as TYPE arguments to decide whether
        // `expr` names a constructed nested type (#1537) rather than an indexer
        // receiver. In a genuine per-segment nested-type chain the ROOT names a
        // user aggregate TYPE (`Outer` in `Outer[int32].Middle[string]`); in a
        // real indexer the root is a VALUE — a local/parameter/field such as
        // `xs` in `xs[i]`. Gate on the head naming a user aggregate type (and
        // NOT a value) BEFORE binding any bracket as a type — mirroring
        // TryResolveConstructedGenericTypeReceiver — so a real indexer whose
        // index is an identifier is never probed as a nested type (which would
        // look the index up as a type and report a spurious GS0113).
        if (!TryGetUserTypeChainHead(expr, out var headName)
            || scope.TryLookupSymbol(headName) is VariableSymbol
            || !scope.TryLookupTypeAlias(headName, out var headCandidate)
            || !IsUserAggregateType(headCandidate))
        {
            return false;
        }

        return TryResolveUserNestedTypeExpressionCore(expr, out nestedType);
    }

    /// <summary>
    /// Issue #1537: the flatten-and-construct core of
    /// <see cref="TryResolveUserNestedTypeExpression"/>. Invoked only after the
    /// wrapper has confirmed the chain head names a user aggregate type, so the
    /// speculative type-argument binding it performs cannot mistake a genuine
    /// indexer receiver for a nested-type chain.
    /// </summary>
    /// <param name="expr">The type-naming expression (accessor or index chain).</param>
    /// <param name="nestedType">The resolved (possibly constructed) type symbol.</param>
    /// <returns>Whether the expression resolved to a user nested type.</returns>
    private bool TryResolveUserNestedTypeExpressionCore(ExpressionSyntax expr, out TypeSymbol nestedType)
    {
        nestedType = null;
        var segments = new List<(string Name, ImmutableArray<TypeSymbol> Args)>();
        if (!TryFlattenUserTypeExpressionSegments(expr, segments) || segments.Count < 2)
        {
            return false;
        }

        var headArity = segments[0].Args.IsDefaultOrEmpty ? -1 : segments[0].Args.Length;
        if (!scope.TryLookupTypeAlias(segments[0].Name, headArity, out var headDef) || !IsUserAggregateType(headDef))
        {
            return false;
        }

        var definitions = new TypeSymbol[segments.Count];
        definitions[0] = headDef;
        for (var i = 1; i < segments.Count; i++)
        {
            var containerDef = (definitions[i - 1] as StructSymbol)?.Definition ?? definitions[i - 1];
            var arity = segments[i].Args.IsDefaultOrEmpty ? -1 : segments[i].Args.Length;
            if (!scope.TryLookupNestedTypeAlias(containerDef, segments[i].Name, arity, out var nested))
            {
                return false;
            }

            definitions[i] = nested;
        }

        // Thread the flattened enclosing construction's arguments (the own
        // arguments of every generic enclosing segment, outermost-first) onto
        // the deepest segment, together with its own arguments. A generic
        // enclosing segment left without matching arguments cannot be threaded,
        // so the whole chain stays open (mirrors the type-clause path's
        // CollectConstructedEnclosingArguments).
        var enclosingBuilder = ImmutableArray.CreateBuilder<TypeSymbol>();
        for (var i = 0; i < segments.Count - 1; i++)
        {
            var ownParams = definitions[i] switch
            {
                StructSymbol s => (s.Definition ?? s).TypeParameters,
                InterfaceSymbol iface => (iface.Definition ?? iface).TypeParameters,
                _ => ImmutableArray<TypeParameterSymbol>.Empty,
            };

            if (ownParams.IsDefaultOrEmpty)
            {
                continue;
            }

            if (segments[i].Args.IsDefaultOrEmpty || segments[i].Args.Length != ownParams.Length)
            {
                enclosingBuilder = null;
                break;
            }

            enclosingBuilder.AddRange(segments[i].Args);
        }

        var enclosingArgs = enclosingBuilder != null && enclosingBuilder.Count > 0
            ? enclosingBuilder.ToImmutable()
            : default;
        var ownArgs = segments[segments.Count - 1].Args;

        switch (definitions[segments.Count - 1])
        {
            case StructSymbol nestedStruct:
                var def = nestedStruct.Definition ?? nestedStruct;
                if (!enclosingArgs.IsDefaultOrEmpty && !ownArgs.IsDefaultOrEmpty)
                {
                    nestedType = StructSymbol.ConstructNestedGeneric(def, enclosingArgs, ownArgs);
                }
                else if (!enclosingArgs.IsDefaultOrEmpty)
                {
                    nestedType = StructSymbol.ConstructNested(def, enclosingArgs);
                }
                else if (!ownArgs.IsDefaultOrEmpty)
                {
                    nestedType = StructSymbol.Construct(def, ownArgs);
                }
                else
                {
                    nestedType = def;
                }

                return true;

            case InterfaceSymbol nestedIface:
                var ifaceDef = nestedIface.Definition ?? nestedIface;
                nestedType = !ownArgs.IsDefaultOrEmpty
                    ? InterfaceSymbol.Construct(ifaceDef, ownArgs)
                    : ifaceDef;
                return true;

            default:
                nestedType = definitions[segments.Count - 1];
                return true;
        }
    }

    /// <summary>
    /// Issue #1537: flattens a user-type-naming expression into its ordered
    /// per-segment (simple name, bound own type-arguments) pairs. Because
    /// per-segment generics parse as an index over the preceding accessor
    /// (<c>Outer[int32].Middle[string]</c> is
    /// <c>((Outer[int32]).Middle)[string]</c>) and multi-argument segments parse
    /// as generic-name expressions, every shape (name, generic-name, index,
    /// accessor) is handled so arbitrary depth and arity flatten uniformly.
    /// </summary>
    /// <param name="expr">The type-naming expression.</param>
    /// <param name="segments">The accumulator for resolved segments (outermost-first).</param>
    /// <returns>Whether the expression is a well-formed user-type name chain.</returns>
    private bool TryFlattenUserTypeExpressionSegments(ExpressionSyntax expr, List<(string Name, ImmutableArray<TypeSymbol> Args)> segments)
    {
        // Issue #942 regression guard: flattening speculatively binds each
        // bracketed segment's contents as TYPE arguments. When the expression is
        // NOT a well-formed user-type name chain (e.g. a genuine indexer whose
        // index is a value), that speculative bind can report a type diagnostic
        // (GS0113) even though this probe ultimately returns false and the caller
        // falls back to normal binding. Snapshot the diagnostic bag and roll it
        // back on failure so the probe is side-effect-free for ANY chain shape.
        var diagMark = Diagnostics.Count;
        if (TryFlattenUserTypeExpressionSegmentsCore(expr, segments))
        {
            return true;
        }

        Diagnostics.TruncateTo(diagMark);
        return false;
    }

    /// <summary>
    /// Issue #1537: the recursive core of
    /// <see cref="TryFlattenUserTypeExpressionSegments"/>. The wrapper snapshots
    /// and rolls back the diagnostic bag around this method so a failed probe
    /// never leaks the speculative type-argument-binding diagnostics it emits.
    /// </summary>
    /// <param name="expr">The type-naming expression.</param>
    /// <param name="segments">The accumulator for resolved segments (outermost-first).</param>
    /// <returns>Whether the expression is a well-formed user-type name chain.</returns>
    private bool TryFlattenUserTypeExpressionSegmentsCore(ExpressionSyntax expr, List<(string Name, ImmutableArray<TypeSymbol> Args)> segments)
    {
        switch (expr)
        {
            case NameExpressionSyntax name:
                segments.Add((name.IdentifierToken.Text, default));
                return true;

            case GenericNameExpressionSyntax generic:
                if (!TryBindGenericSegmentArguments(generic, out var genericArgs))
                {
                    return false;
                }

                segments.Add((generic.Identifier.Text, genericArgs));
                return true;

            case IndexExpressionSyntax index when !index.IsNullConditional:
                if (index.Target is NameExpressionSyntax indexTargetName)
                {
                    if (!TryBindTypeArgumentExpressions(index.Index, out var rootArgs))
                    {
                        return false;
                    }

                    segments.Add((indexTargetName.IdentifierToken.Text, rootArgs));
                    return true;
                }

                if (!TryFlattenUserTypeExpressionSegments(index.Target, segments) || segments.Count == 0)
                {
                    return false;
                }

                var last = segments[segments.Count - 1];
                if (!last.Args.IsDefaultOrEmpty)
                {
                    return false;
                }

                if (!TryBindTypeArgumentExpressions(index.Index, out var lastArgs))
                {
                    return false;
                }

                segments[segments.Count - 1] = (last.Name, lastArgs);
                return true;

            case AccessorExpressionSyntax accessor when !accessor.IsNullConditional:
                if (!TryFlattenUserTypeExpressionSegments(accessor.LeftPart, segments))
                {
                    return false;
                }

                switch (accessor.RightPart)
                {
                    case NameExpressionSyntax rightName:
                        segments.Add((rightName.IdentifierToken.Text, default));
                        return true;
                    case GenericNameExpressionSyntax rightGeneric
                        when TryBindGenericSegmentArguments(rightGeneric, out var rightArgs):
                        segments.Add((rightGeneric.Identifier.Text, rightArgs));
                        return true;
                    default:
                        return false;
                }

            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #1537: binds the type-argument clauses of a generic-name segment
    /// (<c>Middle[string]</c>) to their type symbols for nested-type chain
    /// resolution in expression position.
    /// </summary>
    /// <param name="generic">The generic-name segment.</param>
    /// <param name="typeArgs">The bound type arguments on success.</param>
    /// <returns>Whether all type-argument clauses bound successfully.</returns>
    private bool TryBindGenericSegmentArguments(GenericNameExpressionSyntax generic, out ImmutableArray<TypeSymbol> typeArgs)
    {
        typeArgs = default;
        var argClauses = generic.TypeArgumentList.Arguments;
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(argClauses.Count);
        foreach (var clause in argClauses)
        {
            var bound = bindTypeClause(clause);
            if (bound == null)
            {
                return false;
            }

            builder.Add(bound);
        }

        typeArgs = builder.ToImmutable();
        return true;
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
        //
        // Issue #1475: the slot must be allocated for ANY value-type
        // underlying recognised by SYMBOL — user `EnumSymbol`, value-type
        // `StructSymbol`, a value-constrained type parameter, tuple — not only
        // when the underlying carries a runtime `ClrType.IsValueType`. User
        // enums/structs have a null `ClrType`, so the old gate skipped them and
        // emit fell to the reference (`ldnull`) branch, producing unverifiable
        // IL (`StackUnexpected`/`PathStackUnexpected`). Routing through the
        // canonical symbol-level value-type predicate keeps BCL behaviour
        // identical while covering user value types.
        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.IsValueTypeSymbol(nullableResult.UnderlyingType))
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }

    private bool TryBindImportAccessor(ImportSymbol import, ref ExpressionSyntax rightPart, out ImportedClassSymbol importedClass)
    {
        // Handle `<importName>.<Segment>(.<Segment>)*.<TypeName>(.<more>)*` where
        // <importName> is either an alias or the import's path. Walks the accessor
        // chain extending the namespace prefix until a segment resolves as a type;
        // unresolved leading segments are treated as additional namespace levels
        // (issue #687: e.g. `System.IO.Path.Combine(...)` with `import System.IO`
        // peels `IO` as a namespace continuation, then resolves `System.IO.Path`).
        importedClass = null;

        var currentPath = import.Target;
        var currentRight = rightPart;
        while (true)
        {
            NameExpressionSyntax typeNameSyntax;
            ExpressionSyntax remainder;
            bool hasMoreChain;

            switch (currentRight)
            {
                case AccessorExpressionSyntax nested when nested.LeftPart is NameExpressionSyntax leftName:
                    typeNameSyntax = leftName;
                    remainder = nested.RightPart;
                    hasMoreChain = true;
                    break;

                case NameExpressionSyntax ne:
                    typeNameSyntax = ne;
                    remainder = ne;
                    hasMoreChain = false;
                    break;

                default:
                    return false;
            }

            var fullTypeName = currentPath + "." + typeNameSyntax.IdentifierToken.Text;
            if (scope.References.TryResolveType(fullTypeName, out var type))
            {
                importedClass = new ImportedClassSymbol(type, typeNameSyntax);
                rightPart = remainder;
                return true;
            }

            // Not a type. If there's still a chain to consume, treat this segment
            // as another namespace level and keep walking. Otherwise, give up.
            if (!hasMoreChain)
            {
                return false;
            }

            currentPath = fullTypeName;
            currentRight = remainder;
        }
    }

    /// <summary>
    /// Issue #687 (Option A): when a name resolves to a value but also matches an
    /// in-scope type with the same simple name (an imported CLR class, user-defined
    /// struct/class, or enum), surface that type so the caller can apply the
    /// C#-style "color color" preference when the right-hand side of the accessor
    /// is a static member of the type.
    /// </summary>
    private bool TryResolveColorColorType(
        string name,
        NameExpressionSyntax leftName,
        out ImportedClassSymbol importedClassSymbol,
        out StructSymbol userStructSymbol,
        out EnumSymbol enumSymbol)
    {
        importedClassSymbol = null;
        userStructSymbol = null;
        enumSymbol = null;

        if (scope.TryLookupImportedClass(name, leftName, out var importedClass))
        {
            importedClassSymbol = importedClass;
            return true;
        }

        if (scope.TryLookupTypeAlias(name, out var typeAlias))
        {
            if (typeAlias is StructSymbol foundStruct)
            {
                userStructSymbol = foundStruct;
                return true;
            }

            if (typeAlias is EnumSymbol foundEnum)
            {
                enumSymbol = foundEnum;
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1147 (Facet A): finalizes a "Color Color" member-access CALL whose
    /// receiver name binds to BOTH a value (an in-scope property/field/local/
    /// parameter) and a same-named user struct/class (<paramref name="structSym"/>),
    /// when the invoked method name is declared as BOTH an instance and a static
    /// (<c>shared</c>) overload. The call is resolved against the unified
    /// instance + static overload set and routed by the selected method's
    /// <see cref="FunctionSymbol.IsStatic"/>:
    /// <list type="bullet">
    /// <item>instance overload → the value is bound as the receiver and the call
    /// is dispatched as an ordinary instance call;</item>
    /// <item>static overload → the call is bound as a static member call on the
    /// type.</item>
    /// </list>
    /// Returns <see langword="false"/> (leaving <paramref name="result"/> unset)
    /// when the method name is not declared in BOTH buckets, so the existing #687
    /// type path (static-only) and the value/instance path (instance-only) keep
    /// their current behavior unchanged.
    /// </summary>
    private bool TryBindColorColorUnifiedCall(
        StructSymbol structSym,
        NameExpressionSyntax leftName,
        CallExpressionSyntax ce,
        out BoundExpression result)
    {
        result = null;
        var methodName = ce.Identifier.Text;

        var instanceGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Instance(MemberKinds.Method));
        var staticGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Static(MemberKinds.Method));

        // Only intercept the genuinely-ambiguous case: the name is declared as
        // BOTH an instance and a static overload. Otherwise defer to the existing
        // paths so behavior is unchanged.
        if (instanceGroup.IsDefaultOrEmpty || staticGroup.IsDefaultOrEmpty)
        {
            return false;
        }

        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ce.Arguments.Count);
        foreach (var argument in ce.Arguments)
        {
            var argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argument);
            boundArguments.Add(argSyntax is RefArgumentExpressionSyntax refArg
                ? BindRefArgumentExpression(refArg, parameter: null)
                : BindArgumentDeferringBranchy(argSyntax));
        }

        var arguments = boundArguments.ToImmutable();
        var unified = instanceGroup.AddRange(staticGroup);
        var method = overloads.SelectInstanceOverloadOrReport(unified, arguments, ce, methodName, argumentNames);
        if (method == null)
        {
            result = new BoundErrorExpression(null);
            return true;
        }

        if (method.IsStatic)
        {
            // Static overload selected: bind as a static member call on the type
            // (re-resolves the static group, applying optional/variadic/generic
            // fidelity through the shared static-call finalizer).
            result = BindUserTypeStaticCall(structSym, ce);
            return true;
        }

        // Instance overload selected: materialize the value (property / field /
        // local / parameter) as the receiver and dispatch the instance call with
        // the already-bound arguments.
        var receiver = BindNameExpression(leftName);
        if (receiver is BoundErrorExpression)
        {
            result = receiver;
            return true;
        }

        result = overloads.BindUserInstanceCall(receiver, method, arguments, ce, argumentNames);
        return true;
    }

    /// <summary>
    /// Issue #687 (Option A): inspects the right-hand side of an accessor chain
    /// to determine whether it would bind as a static member (field, property,
    /// event, nested type, or method) of the supplied type. Used to decide
    /// between the value and type interpretation when a name collides with a
    /// same-named type in scope. When no static member matches, the binder
    /// falls back to the value interpretation so existing instance-access
    /// semantics continue to work unchanged.
    /// </summary>
    private bool RightPartLooksLikeStaticMember(
        ImportedClassSymbol importedClassSymbol,
        StructSymbol userStructSymbol,
        EnumSymbol enumSymbol,
        ExpressionSyntax rightPart)
    {
        if (!TryGetAccessorChainHead(rightPart, out var headName, out var isCall))
        {
            return false;
        }

        if (importedClassSymbol != null)
        {
            return HasStaticMember(importedClassSymbol.ClassType, headName, isCall);
        }

        if (userStructSymbol != null)
        {
            return HasUserTypeStaticMember(userStructSymbol, headName, isCall);
        }

        if (enumSymbol != null)
        {
            return !isCall && enumSymbol.TryGetMember(headName, out _);
        }

        return false;
    }

    private static bool TryGetAccessorChainHead(ExpressionSyntax rightPart, out string headName, out bool isCall)
    {
        switch (rightPart)
        {
            case CallExpressionSyntax ce when !ce.Identifier.IsMissing:
                headName = ce.Identifier.Text;
                isCall = true;
                return !string.IsNullOrEmpty(headName);

            case NameExpressionSyntax ne when !ne.IdentifierToken.IsMissing:
                headName = ne.IdentifierToken.Text;
                isCall = false;
                return !string.IsNullOrEmpty(headName);

            case AccessorExpressionSyntax acc:
                return TryGetAccessorChainHead(acc.LeftPart, out headName, out isCall);

            case IndexExpressionSyntax ix:
                return TryGetAccessorChainHead(ix.Target, out headName, out isCall);

            case ObjectCreationExpressionSyntax objCreate:
                return TryGetAccessorChainHead(objCreate.Target, out headName, out isCall);

            default:
                headName = null;
                isCall = false;
                return false;
        }
    }

    private bool HasStaticMember(System.Type clrType, string headName, bool isCall)
    {
        if (clrType == null)
        {
            return false;
        }

        if (isCall)
        {
            var methods = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(clrType, BindingFlags.Public | BindingFlags.Static);
            foreach (var m in methods)
            {
                if (m.Name == headName)
                {
                    return true;
                }
            }

            if (scope.References.TryResolveNestedType(clrType, headName, out _))
            {
                return true;
            }

            return false;
        }

        if (ClrTypeUtilities.SafeGetField(clrType, headName, BindingFlags.Public | BindingFlags.Static) != null)
        {
            return true;
        }

        var prop = ClrTypeUtilities.SafeGetProperty(clrType, headName, BindingFlags.Public | BindingFlags.Static);
        if (prop != null && prop.GetIndexParameters().Length == 0)
        {
            return true;
        }

        if (scope.References.TryResolveNestedType(clrType, headName, out _))
        {
            return true;
        }

        try
        {
            if (clrType.GetEvent(headName, BindingFlags.Public | BindingFlags.Static) != null)
            {
                return true;
            }
        }
        catch (System.Exception)
        {
            // Defensive: some metadata-load-context types throw on event lookup;
            // treat as "no event" so the binder falls back to instance semantics.
        }

        return false;
    }

    private static bool HasUserTypeStaticMember(StructSymbol structSym, string headName, bool isCall)
    {
        if (structSym == null)
        {
            return false;
        }

        // ADR-0112: route through the canonical member-resolution layer.
        if (isCall)
        {
            return !TypeMemberModel.GetMethods(structSym, headName, MemberQuery.Static(MemberKinds.Method)).IsEmpty;
        }

        return TypeMemberModel.LookupMember(
            structSym,
            headName,
            MemberQuery.Static(MemberKinds.Field | MemberKinds.Property)) != null;
    }

    private BoundExpression BindEnumAccessorStep(EnumSymbol enumSymbol, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                var head = BindEnumAccessorStep(enumSymbol, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case NameExpressionSyntax ne:
                var memberName = ne.IdentifierToken.Text;
                if (enumSymbol.TryGetMember(memberName, out var member))
                {
                    // Issue #188 / #175: every read of an `@Obsolete` enum
                    // member surfaces GS0204 at the member-identifier
                    // location (e.g. `Color.Red`).
                    reportObsoleteUseIfApplicable(ne.Location, member, $"{enumSymbol.Name}.{member.Name}");
                    return new BoundLiteralExpression(null, member.Value, enumSymbol);
                }

                Diagnostics.ReportUndefinedEnumMember(ne.Location, memberName, enumSymbol.Name);
                return new BoundErrorExpression(null);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Handles <c>TypeName.member</c> and <c>TypeName.method(args)</c> accessor
    /// resolution for user-defined struct/class static members (ADR-0053).
    /// </summary>
    private BoundExpression BindUserTypeStaticAccessorStep(StructSymbol structSym, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                // Issue #1537: the left portion may name a nested TYPE of the
                // constructed receiver (`Middle[string]` under `Outer[int32]`),
                // with the rightPart a composite literal / member / call on that
                // nested type — i.e. a per-segment generic chain of depth ≥ 3
                // (`Outer[int32].Middle[string].Inner{…}`) parses right-leaning
                // so the inner segments arrive here rather than at the top-level
                // accessor. Resolve the nested-type chain under the receiver
                // (threading the flattened enclosing arguments) and bind the
                // tail against it. Falls through to the value/static-member path
                // when the left portion is not a nested type.
                if (TryResolveNestedTypeChainUnderReceiver(structSym, nested.LeftPart, out var innerReceiver))
                {
                    return BindUserTypeStaticAccessorStep(innerReceiver, nested.RightPart);
                }

                var head = BindUserTypeStaticAccessorStep(structSym, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                return BindUserTypeStaticCall(structSym, ce);

            // Issue #1537: a composite literal for a type nested inside a
            // CONSTRUCTED generic enclosing type
            // (`Outer[int32].Middle[string]{…}`, `Box[int32].Tag{…}`). The outer
            // segment (`Outer[int32]`) resolves to the constructed struct
            // receiver `structSym`; resolve the nested type under its definition
            // and bind the literal against it, threading the enclosing
            // construction's flattened arguments so member types substitute the
            // enclosing parameters and the emitter encodes the reified nested
            // type. Mirrors the #1069 peel-off path in BindAccessorExpression
            // that already handles a NON-generic enclosing segment.
            case StructLiteralExpressionSyntax structLiteral:
                return BindQualifiedNestedStructLiteral(structSym, structLiteral);

            case NameExpressionSyntax ne:
                return BindUserTypeStaticMemberAccess(structSym, ne);

            // Issue #1291: element access on a qualified static field receiver
            // (`Type.staticField[i]`). The parser folds the trailing `[...]` into
            // the right-hand side of the `.`, so the indexer arrives here as the
            // rightPart. Bind the static-member target through the static
            // accessor path to get the correctly typed (array/map/...) receiver,
            // then route the index resolution through the shared helper — exactly
            // as the instance-receiver path does in BindAccessorStep. Without this
            // case the indexer fell through to `default` and bound to the error
            // type `?`.
            case IndexExpressionSyntax ix:
                var indexTarget = BindUserTypeStaticAccessorStep(structSym, ix.Target);
                if (indexTarget is BoundErrorExpression)
                {
                    return indexTarget;
                }

                if (ix.IsNullConditional)
                {
                    return BindNullConditionalIndexFromBoundTarget(indexTarget, ix);
                }

                return BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Issue #1537: binds a composite literal naming a type nested inside a
    /// CONSTRUCTED generic enclosing type
    /// (<c>Outer[int32].Middle[string]{…}</c>, <c>Box[int32].Tag{…}</c>). The
    /// nested type is resolved under <paramref name="outerConstructed"/>'s
    /// definition, and the enclosing construction's flattened type arguments
    /// (its own enclosing arguments followed by its own arguments, outermost
    /// first — aligned with <see cref="StructSymbol.CollectEnclosingTypeParameters(TypeSymbol)"/>)
    /// are threaded onto the constructed nested symbol so member types
    /// substitute the enclosing parameters and the emitter encodes the reified
    /// nested type. Generalizes to arbitrary depth: at each level the outer
    /// segment already carries the flattened arguments of everything above it.
    /// </summary>
    /// <param name="outerConstructed">The constructed generic enclosing segment (e.g. <c>Outer[int32]</c>).</param>
    /// <param name="structLiteral">The nested composite literal (e.g. <c>Middle[string]{…}</c>).</param>
    /// <returns>The bound nested struct literal, or a bound error expression.</returns>
    private BoundExpression BindQualifiedNestedStructLiteral(StructSymbol outerConstructed, StructLiteralExpressionSyntax structLiteral)
    {
        var container = outerConstructed.Definition ?? outerConstructed;
        var literalArity = structLiteral.TypeArgumentList != null ? structLiteral.TypeArgumentList.Arguments.Count : -1;
        if (!scope.TryLookupNestedTypeAlias(container, structLiteral.TypeIdentifier.Text, literalArity, out var nestedType)
            || nestedType is not StructSymbol nestedStructDef)
        {
            Diagnostics.ReportUnableToFindType(structLiteral.TypeIdentifier.Location, structLiteral.TypeIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        // The enclosing construction already flattens its own enclosing chain in
        // EnclosingTypeArguments; append its own TypeArguments so the nested
        // type sees the full outermost-first vector.
        var enclosingArgs = FlattenConstructedEnclosingArguments(outerConstructed);
        return BindStructLiteralExpression(structLiteral, nestedStructDef.Definition ?? nestedStructDef, enclosingArgs);
    }

    /// <summary>
    /// Issue #1537: resolves a nested-type-naming expression evaluated UNDER a
    /// constructed generic receiver — e.g. <c>Middle[string]</c> (or the deeper
    /// <c>Middle[string].Deeper[y]</c>) under a receiver <c>Outer[int32]</c> —
    /// to the constructed nested type symbol, threading the receiver's flattened
    /// enclosing arguments plus each intervening segment's own arguments so the
    /// deepest segment carries the full outermost-first argument vector
    /// (<c>Outer`1+Middle`2&lt;int32, string&gt;</c>). Returns <see langword="false"/>
    /// (without diagnostics) when the expression does not name a nested type of
    /// the receiver, so the caller can fall back to the value/static-member path.
    /// </summary>
    /// <param name="receiver">The constructed generic receiver the chain is nested under.</param>
    /// <param name="typeExpr">The nested-type-naming expression.</param>
    /// <param name="constructed">The resolved constructed nested type on success.</param>
    /// <returns>Whether the expression named a nested type of the receiver.</returns>
    private bool TryResolveNestedTypeChainUnderReceiver(StructSymbol receiver, ExpressionSyntax typeExpr, out StructSymbol constructed)
    {
        constructed = null;
        var segments = new List<(string Name, ImmutableArray<TypeSymbol> Args)>();
        if (!TryFlattenUserTypeExpressionSegments(typeExpr, segments) || segments.Count == 0)
        {
            return false;
        }

        var enclosingArgs = FlattenConstructedEnclosingArguments(receiver);
        TypeSymbol containerDef = receiver.Definition ?? receiver;
        for (var i = 0; i < segments.Count; i++)
        {
            var arity = segments[i].Args.IsDefaultOrEmpty ? -1 : segments[i].Args.Length;
            var lookupContainer = (containerDef as StructSymbol)?.Definition ?? containerDef;
            if (!scope.TryLookupNestedTypeAlias(lookupContainer, segments[i].Name, arity, out var nested))
            {
                return false;
            }

            if (i < segments.Count - 1)
            {
                // Enclosing segment: accumulate its own arguments (if generic)
                // onto the flattened vector threaded into the next level.
                if (!segments[i].Args.IsDefaultOrEmpty)
                {
                    enclosingArgs = enclosingArgs.IsDefaultOrEmpty
                        ? segments[i].Args
                        : enclosingArgs.AddRange(segments[i].Args);
                }

                containerDef = nested;
                continue;
            }

            if (nested is not StructSymbol nestedStruct)
            {
                return false;
            }

            var def = nestedStruct.Definition ?? nestedStruct;
            var ownArgs = segments[i].Args;
            if (!enclosingArgs.IsDefaultOrEmpty && !ownArgs.IsDefaultOrEmpty)
            {
                constructed = StructSymbol.ConstructNestedGeneric(def, enclosingArgs, ownArgs);
            }
            else if (!enclosingArgs.IsDefaultOrEmpty)
            {
                constructed = StructSymbol.ConstructNested(def, enclosingArgs);
            }
            else if (!ownArgs.IsDefaultOrEmpty)
            {
                constructed = StructSymbol.Construct(def, ownArgs);
            }
            else
            {
                constructed = def;
            }

            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1537: flattens the type arguments of a constructed generic
    /// enclosing segment into the outermost-first vector its nested types are
    /// reified over — the segment's own <see cref="StructSymbol.EnclosingTypeArguments"/>
    /// (from levels above it) followed by its own <see cref="StructSymbol.TypeArguments"/>.
    /// Returns <c>default</c> when the segment carries no type arguments (a
    /// non-generic enclosing type contributes nothing to thread).
    /// </summary>
    /// <param name="outerConstructed">The constructed (or open) enclosing segment.</param>
    /// <returns>The flattened enclosing-argument vector, or <c>default</c>.</returns>
    private static ImmutableArray<TypeSymbol> FlattenConstructedEnclosingArguments(StructSymbol outerConstructed)
    {
        var enclosing = outerConstructed.EnclosingTypeArguments;
        var own = outerConstructed.TypeArguments;
        if (enclosing.IsDefaultOrEmpty && own.IsDefaultOrEmpty)
        {
            return default;
        }

        var builder = ImmutableArray.CreateBuilder<TypeSymbol>();
        if (!enclosing.IsDefaultOrEmpty)
        {
            builder.AddRange(enclosing);
        }

        if (!own.IsDefaultOrEmpty)
        {
            builder.AddRange(own);
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// ADR-0089 / issue #1030: resolves <c>IName.StaticField</c> qualified
    /// access against an interface's static *state* (storage or const fields).
    /// Interface static fields have no per-implementer shape — they are plain
    /// CLR static fields on the interface TypeDef — so a read/write binds to a
    /// static (<c>receiver: null</c>) <see cref="BoundFieldAccessExpression"/>
    /// with a <c>null</c> declaring struct (the emitter resolves the field by
    /// symbol identity). Non-field members fall through to an error.
    /// </summary>
    /// <param name="interfaceSym">The interface receiver.</param>
    /// <param name="rightPart">The member being accessed.</param>
    /// <returns>The bound access, or a bound error expression.</returns>
    private BoundExpression BindInterfaceStaticAccessorStep(InterfaceSymbol interfaceSym, ExpressionSyntax rightPart)
    {
        // Issue #1030: a constructed generic interface (`IBox[int32]`) does not
        // re-declare its static fields — they live on the open definition. Look
        // the field up there, but keep `interfaceSym` (the constructed or open
        // symbol) as the carried owner so the emitter parents the field
        // reference at the correct TypeSpec and the interpreter keys storage per
        // construction.
        var fieldOwner = interfaceSym.Definition ?? interfaceSym;
        switch (rightPart)
        {
            // Issue #1433: `IName.method(args)` — a static (`shared`) method
            // declared on the interface. Route through the same canonical
            // member-resolution + overload machinery used for struct/class
            // statics; the only difference (a constructed generic interface
            // owner) is carried on the bound call for the emitter.
            case CallExpressionSyntax ce:
                return BindUserTypeStaticCall(interfaceSym, ce);

            case NameExpressionSyntax ne:
                return BindInterfaceStaticMemberAccess(interfaceSym, fieldOwner, ne);

            case AccessorExpressionSyntax nested:
                var head = BindInterfaceStaticAccessorStep(interfaceSym, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Issue #1433: resolves <c>IName.member</c> in non-call position against an
    /// interface's static members. A static field reads to a static
    /// <see cref="BoundFieldAccessExpression"/> (issue #1030); a static
    /// (<c>shared</c>) method named here is a method group with a null receiver
    /// (overload selection deferred to the conversion classifier), mirroring the
    /// struct/class path in <see cref="BindUserTypeStaticMemberAccess"/>.
    /// </summary>
    /// <param name="interfaceSym">The interface receiver (constructed or open).</param>
    /// <param name="fieldOwner">The interface definition owning static fields.</param>
    /// <param name="ne">The member being accessed.</param>
    /// <returns>The bound access, or a bound error expression.</returns>
    private BoundExpression BindInterfaceStaticMemberAccess(InterfaceSymbol interfaceSym, InterfaceSymbol fieldOwner, NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        var field = fieldOwner.GetStaticField(memberName);
        if (field != null)
        {
            return new BoundFieldAccessExpression(null, field, interfaceSym);
        }

        // Issue #1433: a default-bodied static (`shared`) property on the
        // interface (ADR-0089 / issue #1019) read in non-call position. Static
        // interface properties are modeled as static-virtual accessor methods,
        // not on a `StaticProperties` bucket, so a direct read is lowered to a
        // call of the getter MethodDef — reusing the static-method-call emit
        // path. Only a concrete (non-abstract, default-bodied) getter can be
        // invoked directly on the interface type.
        foreach (var prop in fieldOwner.Properties)
        {
            if (prop.IsStatic && !prop.IsIndexer && prop.Name == memberName)
            {
                if (prop.GetterSymbol != null && prop.HasGetter)
                {
                    return new BoundCallExpression(null, prop.GetterSymbol, ImmutableArray<BoundExpression>.Empty, prop.Type)
                    {
                        StaticGenericInterfaceOwnerType = interfaceSym.Definition != null ? interfaceSym : null,
                    };
                }

                Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                return new BoundErrorExpression(null);
            }
        }

        // ADR-0112: a static method named here in non-call position is a method
        // group with a null receiver, driven by the target delegate signature.
        var staticMethods = TypeMemberModel.GetMethods(interfaceSym, memberName, MemberQuery.Static(MemberKinds.Method));
        if (TryBuildUserMethodGroup(receiver: null, staticMethods, out var staticGroup))
        {
            return staticGroup;
        }

        Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
        return new BoundErrorExpression(null);
    }

    /// <summary>
    /// ADR-0089 / issue #1030: resolves an index-expression receiver of the
    /// form <c>IBox[int32]</c> to the constructed generic interface symbol when
    /// the indexed target names a generic interface definition and the index
    /// resolves to a type. Returns <c>false</c> for anything else (so the caller
    /// falls back to ordinary index/expression binding).
    /// </summary>
    /// <param name="index">The candidate <c>Target[Index]</c> receiver.</param>
    /// <param name="constructed">The constructed generic interface on success.</param>
    /// <returns>Whether a constructed generic interface receiver was resolved.</returns>
    private bool TryResolveConstructedGenericInterfaceReceiver(IndexExpressionSyntax index, out InterfaceSymbol constructed)
    {
        constructed = null;
        if (index.Target is not NameExpressionSyntax targetName)
        {
            return false;
        }

        if (!scope.TryLookupTypeAlias(targetName.IdentifierToken.Text, out var alias)
            || alias is not InterfaceSymbol ifaceDef
            || !ifaceDef.IsGenericDefinition)
        {
            return false;
        }

        if (!TryBindTypeArgumentExpressions(index.Index, out var typeArgs)
            || typeArgs.Length != ifaceDef.TypeParameters.Length)
        {
            return false;
        }

        constructed = InterfaceSymbol.Construct(ifaceDef, typeArgs);
        return true;
    }

    /// <summary>
    /// Issue #1209: resolves a <c>Name[TypeArg]</c> index-expression receiver
    /// that appears in expression / member-access position to the constructed
    /// generic *type* it names — a user class/struct, a user interface, or an
    /// imported CLR generic type — so qualified static-member access
    /// (<c>Box[int32].Default</c>, <c>ArrayPool[uint8].Shared</c>) and static
    /// method calls bind against the construction rather than as element access.
    /// <para>
    /// Disambiguation rule (avoids breaking genuine indexing such as
    /// <c>arr[i]</c> / <c>dict[key]</c>): the target must be a simple name that
    /// does NOT resolve to a value/variable in scope, AND must resolve to a
    /// generic type definition (user generic class/struct/interface, or imported
    /// CLR generic) whose arity matches the bracketed type-argument count, AND
    /// the bracket contents must parse as type arguments. When the name resolves
    /// to a value, this returns <c>false</c> and the caller binds element access
    /// as before.
    /// </para>
    /// </summary>
    /// <param name="index">The candidate <c>Name[TypeArg]</c> receiver.</param>
    /// <param name="constructedStruct">The constructed generic class/struct on success.</param>
    /// <param name="constructedInterface">The constructed generic interface on success.</param>
    /// <param name="constructedImported">The constructed imported CLR generic type on success.</param>
    /// <returns>Whether a constructed generic type receiver was resolved.</returns>
    private bool TryResolveConstructedGenericTypeReceiver(
        IndexExpressionSyntax index,
        out StructSymbol constructedStruct,
        out InterfaceSymbol constructedInterface,
        out ImportedClassSymbol constructedImported)
    {
        constructedStruct = null;
        constructedInterface = null;
        constructedImported = null;

        if (index.Target is not NameExpressionSyntax targetName)
        {
            return false;
        }

        var name = targetName.IdentifierToken.Text;

        // Genuine indexing (`arr[i]`, `dict[key]`) requires the target to name a
        // value. Only when the name is NOT a value do we consider the
        // constructed-generic-type interpretation.
        if (scope.TryLookupSymbol(name) is VariableSymbol)
        {
            return false;
        }

        // Gate on the name actually naming a generic type definition before
        // binding the bracket contents as type arguments, so that we never emit
        // spurious type diagnostics for a non-generic-type target.
        var arity = FlattenCommaList(index.Index).Count();

        // Issue #1395: when a non-generic (arity-0) type and a generic type
        // share the same simple name (arity overloading, e.g. `Box` and
        // `Box[T]`), the arity-unaware lookup prefers the arity-0 type and the
        // generic receiver fails to resolve. Disambiguate using the bracketed
        // type-argument count so `Box[int32]` selects the arity-1 `Box[T]`.
        var userGenericDef = scope.TryLookupTypeAlias(name, preferredArity: arity, out var alias)
            && ((alias is StructSymbol sDef && sDef.IsGenericDefinition && sDef.TypeParameters.Length == arity)
                || (alias is InterfaceSymbol iDef && iDef.IsGenericDefinition && iDef.TypeParameters.Length == arity));
        Type openClrType = null;
        var clrGenericDef = !userGenericDef
            && scope.TryLookupImportedGenericClass(name, arity, out openClrType);

        if (!userGenericDef && !clrGenericDef)
        {
            return false;
        }

        if (!TryBindTypeArgumentExpressions(index.Index, out var typeArgs)
            || typeArgs.Length != arity)
        {
            return false;
        }

        if (userGenericDef)
        {
            switch (alias)
            {
                case StructSymbol structDef:
                    constructedStruct = StructSymbol.Construct(structDef, typeArgs);
                    return true;
                case InterfaceSymbol ifaceDef:
                    constructedInterface = InterfaceSymbol.Construct(ifaceDef, typeArgs);
                    return true;
            }
        }

        // Imported CLR generic type: close the open generic definition over the
        // CLR types of the bound type arguments (e.g. ArrayPool`1 + byte ->
        // ArrayPool<byte>) and surface it as an imported class so the existing
        // static-member / static-call binding path resolves members against the
        // closed construction.
        return TryCloseImportedGenericTypeReceiver(openClrType, typeArgs, index, out constructedImported);
    }

    /// <summary>
    /// Issue #1323: resolves a constructed generic type receiver from a
    /// <see cref="GenericNameExpressionSyntax"/> (<c>Box[int32?]</c>,
    /// <c>Pair[int, string]</c>, <c>List[List[int32]]</c>). Unlike the
    /// index-expression form, the type arguments are real
    /// <see cref="TypeClauseSyntax"/> nodes, so nullable/array/nested-generic
    /// arguments bind directly without needing to be reshaped from an
    /// expression. Mirrors the gating of the index-expression overload: the name
    /// must NOT be a value and must name a generic type definition (user
    /// class/struct/interface or imported CLR generic) of matching arity.
    /// </summary>
    /// <param name="generic">The constructed-generic type reference.</param>
    /// <param name="constructedStruct">The constructed generic class/struct on success.</param>
    /// <param name="constructedInterface">The constructed generic interface on success.</param>
    /// <param name="constructedImported">The constructed imported CLR generic type on success.</param>
    /// <returns>Whether a constructed generic type receiver was resolved.</returns>
    private bool TryResolveConstructedGenericTypeReceiver(
        GenericNameExpressionSyntax generic,
        out StructSymbol constructedStruct,
        out InterfaceSymbol constructedInterface,
        out ImportedClassSymbol constructedImported)
    {
        constructedStruct = null;
        constructedInterface = null;
        constructedImported = null;

        var name = generic.Identifier.Text;

        // A value-named receiver is genuine element access, never a type.
        if (scope.TryLookupSymbol(name) is VariableSymbol)
        {
            return false;
        }

        var argClauses = generic.TypeArgumentList.Arguments;
        var arity = argClauses.Count;

        // Issue #1395: same arity-collision disambiguation as the
        // index-expression overload — select the same-name type whose generic
        // arity matches the supplied type-argument count so `Box[int32]`
        // resolves to `Box[T]` rather than the non-generic `Box`.
        var userGenericDef = scope.TryLookupTypeAlias(name, preferredArity: arity, out var alias)
            && ((alias is StructSymbol sDef && sDef.IsGenericDefinition && sDef.TypeParameters.Length == arity)
                || (alias is InterfaceSymbol iDef && iDef.IsGenericDefinition && iDef.TypeParameters.Length == arity));
        Type openClrType = null;
        var clrGenericDef = !userGenericDef
            && scope.TryLookupImportedGenericClass(name, arity, out openClrType);

        if (!userGenericDef && !clrGenericDef)
        {
            return false;
        }

        var typeArgsBuilder = ImmutableArray.CreateBuilder<TypeSymbol>(arity);
        foreach (var clause in argClauses)
        {
            var bound = bindTypeClause(clause);
            if (bound == null)
            {
                return false;
            }

            typeArgsBuilder.Add(bound);
        }

        var typeArgs = typeArgsBuilder.ToImmutable();

        if (userGenericDef)
        {
            switch (alias)
            {
                case StructSymbol structDef:
                    constructedStruct = StructSymbol.Construct(structDef, typeArgs);
                    return true;
                case InterfaceSymbol ifaceDef:
                    constructedInterface = InterfaceSymbol.Construct(ifaceDef, typeArgs);
                    return true;
            }
        }

        return TryCloseImportedGenericTypeReceiver(openClrType, typeArgs, generic, out constructedImported);
    }

    /// <summary>
    /// Issue #1559: syntax-shape-agnostic dispatcher over the two
    /// constructed-generic-type receiver resolvers. A qualified generic-type
    /// receiver <c>G[T1..Tn]</c> reaches the binder as either an
    /// <see cref="IndexExpressionSyntax"/> (single type argument that also reads
    /// as an index — <c>Foo[T]</c>, <c>Box[int32]</c>) or a
    /// <see cref="GenericNameExpressionSyntax"/> (arguments the parser could only
    /// shape as types — <c>Box[int32?]</c>, <c>Pair[int32, string]</c>,
    /// <c>Box[List[int32]]</c>). Both read (member access) and write (assignment
    /// target) receiver resolution route through here so the WRITE path mirrors
    /// the READ path (<see cref="BindAccessorExpression"/>) exactly rather than
    /// duplicating shape-specific logic.
    /// </summary>
    /// <param name="receiver">The candidate constructed-generic-type receiver syntax.</param>
    /// <param name="constructedStruct">The constructed generic class/struct on success.</param>
    /// <param name="constructedInterface">The constructed generic interface on success.</param>
    /// <param name="constructedImported">The constructed imported CLR generic type on success.</param>
    /// <returns>Whether a constructed generic type receiver was resolved.</returns>
    private bool TryResolveConstructedGenericTypeReceiver(
        ExpressionSyntax receiver,
        out StructSymbol constructedStruct,
        out InterfaceSymbol constructedInterface,
        out ImportedClassSymbol constructedImported)
    {
        constructedStruct = null;
        constructedInterface = null;
        constructedImported = null;

        switch (receiver)
        {
            case IndexExpressionSyntax index when !index.IsNullConditional:
                return TryResolveConstructedGenericTypeReceiver(index, out constructedStruct, out constructedInterface, out constructedImported);
            case GenericNameExpressionSyntax generic:
                return TryResolveConstructedGenericTypeReceiver(generic, out constructedStruct, out constructedInterface, out constructedImported);
            default:
                return false;
        }
    }

    /// <summary>
    /// Closes an open imported CLR generic definition over the CLR types of the
    /// bound type arguments (e.g. <c>ArrayPool`1</c> + <c>byte</c> -&gt;
    /// <c>ArrayPool&lt;byte&gt;</c>) and surfaces it as an
    /// <see cref="ImportedClassSymbol"/> so the existing static-member /
    /// static-call binding path resolves members against the closed
    /// construction. Shared by the index-expression and generic-name receiver
    /// resolvers (Issue #1209 / Issue #1323).
    /// </summary>
    private bool TryCloseImportedGenericTypeReceiver(
        Type openClrType,
        ImmutableArray<TypeSymbol> typeArgs,
        ExpressionSyntax receiverSyntax,
        out ImportedClassSymbol constructedImported)
    {
        constructedImported = null;

        var clrArgs = new Type[typeArgs.Length];
        for (var i = 0; i < typeArgs.Length; i++)
        {
            // Issue #1330 (#313 / #671): an in-scope generic type-parameter
            // argument (`Comparer[TResult].Create(...)`, `Comparer[U].Default`)
            // — or any other symbolic type that has no CLR type yet (a
            // not-yet-emitted user type) — has no concrete System.Type to close
            // the imported generic over. Mirror ConstructIfGeneric's type-erased
            // generic model and project such an argument onto System.Object for
            // the closed CLR shape, so the constructed-generic *type* receiver is
            // well formed and static-member access / static calls resolve. This
            // keeps the type-parameter receiver consistent with how the same
            // `Comparer[TResult]` shape binds in type-clause position.
            var clr = TypeSymbol.ContainsTypeParameter(typeArgs[i])
                ? typeof(object)
                : NullableTypeSymbol.GetEffectiveClrType(typeArgs[i]);
            clr ??= typeof(object);

            // Project the host CLR type argument onto the resolver's reference
            // set so it shares the open type's load context (its
            // MetadataLoadContext when references are supplied via /reference:),
            // which MakeGenericType requires (mirrors Binder.BindGenericClrType).
            clrArgs[i] = scope.References.MapClrTypeToReferences(clr);
        }

        try
        {
            var closed = openClrType.MakeGenericType(clrArgs);

            // Issue #1330: when any type argument is symbolic (an in-scope
            // generic type parameter, or a user type with no CLR type yet), the
            // closed CLR shape above is type-erased to `object`. Carry the
            // symbolic constructed view alongside it so static-member access and
            // static calls recover symbolic member/return types
            // (`Comparer[TResult].Default : Comparer[TResult]`) and the emitter
            // parents the static member reference at the constructed
            // `Comparer<!TResult>` TypeSpec instead of the erased
            // `Comparer<object>` — yielding verifiable IL exactly as the
            // concrete-argument receiver does.
            var symbolicReceiver = typeArgs.Any(static a => TypeSymbol.ContainsTypeParameter(a) || a.ClrType == null)
                ? ImportedTypeSymbol.GetConstructed(closed, openClrType, typeArgs)
                : null;
            constructedImported = new ImportedClassSymbol(closed, receiverSyntax, symbolicReceiver);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    /// <summary>
    /// ADR-0089 / issue #1030: binds the type-argument expression(s) of a
    /// generic-interface index receiver (<c>int32</c> in <c>IBox[int32]</c>) to
    /// <see cref="TypeSymbol"/>s. Supports a single argument or a comma list
    /// (<c>IPair[int32, string]</c>). Each argument must be a simple/qualified
    /// name or a nested generic; non-type expressions cause a <c>false</c>
    /// result.
    /// </summary>
    /// <param name="argsSyntax">The index expression's argument syntax.</param>
    /// <param name="typeArgs">The bound type arguments on success.</param>
    /// <returns>Whether every argument resolved to a type.</returns>
    private bool TryBindTypeArgumentExpressions(ExpressionSyntax argsSyntax, out ImmutableArray<TypeSymbol> typeArgs)
    {
        typeArgs = default;
        var builder = ImmutableArray.CreateBuilder<TypeSymbol>();
        foreach (var argExpr in FlattenCommaList(argsSyntax))
        {
            if (!TryBuildTypeClauseFromExpression(argExpr, out var typeClause))
            {
                return false;
            }

            var bound = bindTypeClause(typeClause);
            if (bound == null)
            {
                return false;
            }

            builder.Add(bound);
        }

        if (builder.Count == 0)
        {
            return false;
        }

        typeArgs = builder.ToImmutable();
        return true;
    }

    private static IEnumerable<ExpressionSyntax> FlattenCommaList(ExpressionSyntax expr)
    {
        // The parser models `a, b` inside `[...]` as a right-leaning
        // BinaryExpression over comma tokens in some positions; most generic
        // arities used here are single-argument. Yield a single element unless
        // a comma-separated shape is recognised.
        yield return expr;
    }

    /// <summary>
    /// ADR-0089 / issue #1030: reshapes a type-name expression (a simple name
    /// such as <c>int32</c> or a nested generic such as <c>IBox[int32]</c>) into
    /// a <see cref="TypeClauseSyntax"/> so it can be bound by the shared
    /// type-clause binder. Returns <c>false</c> for non-type shapes.
    /// </summary>
    /// <param name="expr">The candidate type expression.</param>
    /// <param name="typeClause">The synthesized type clause on success.</param>
    /// <returns>Whether the expression names a type.</returns>
    private static bool TryBuildTypeClauseFromExpression(ExpressionSyntax expr, out TypeClauseSyntax typeClause)
    {
        typeClause = null;
        if (expr is NameExpressionSyntax ne && !ne.IdentifierToken.IsMissing)
        {
            typeClause = new TypeClauseSyntax(ne.SyntaxTree, ne.IdentifierToken);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1201 (C# <c>using static</c>): attempts to resolve an unqualified
    /// identifier against the <c>shared</c> (static) members — field, property,
    /// or method group — of a type brought into scope by a non-alias type import
    /// (<c>import Ns.Type</c>). Binds against the single match through the same
    /// <see cref="BindUserTypeStaticMemberAccess"/> path used by an explicit
    /// <c>Type.Member</c> access; reports GS0414 when two or more imported types
    /// expose a member of that name (the value/identifier analog of the
    /// call-site ambiguity rule in <c>OverloadResolver</c>).
    /// </summary>
    /// <param name="syntax">The bare-name reference being resolved.</param>
    /// <param name="result">The bound static-member access, when one is produced.</param>
    /// <returns><c>true</c> when an imported static member matched (or an ambiguity was reported).</returns>
    private bool TryBindImportedStaticMember(NameExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;
        var name = syntax.IdentifierToken.Text;

        StructSymbol match = null;
        var ambiguous = false;
        foreach (var importedType in binderCtx.GetStaticImportTypes())
        {
            if (!ImportedTypeExposesStaticMember(importedType, name))
            {
                continue;
            }

            if (match == null)
            {
                match = importedType;
            }
            else if (!ReferenceEquals(match, importedType))
            {
                ambiguous = true;
                break;
            }
        }

        if (ambiguous)
        {
            Diagnostics.ReportAmbiguousImportedStaticMember(syntax.IdentifierToken.Location, name);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (match != null)
        {
            result = BindUserTypeStaticMemberAccess(match, syntax);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #1201: whether <paramref name="structSym"/> declares a <c>shared</c>
    /// (static) field, property, or method named <paramref name="name"/> —
    /// i.e. a member a type import would expose for unqualified reference.
    /// </summary>
    /// <param name="structSym">The imported type.</param>
    /// <param name="name">The member name.</param>
    /// <returns><c>true</c> when a matching static member exists.</returns>
    private static bool ImportedTypeExposesStaticMember(StructSymbol structSym, string name)
        => TypeMemberModel.TryGetStaticField(structSym, name, out _)
            || TypeMemberModel.TryGetStaticProperty(structSym, name, out _)
            || !TypeMemberModel.GetMethods(structSym, name, MemberQuery.Static(MemberKinds.Method)).IsDefaultOrEmpty;

    private BoundExpression BindUserTypeStaticMemberAccess(StructSymbol structSym, NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        // ADR-0112: static field/property lookups go through the canonical layer.
        if (TypeMemberModel.TryGetStaticField(structSym, memberName, out var field))
        {
            return new BoundFieldAccessExpression(null, receiver: null, structSym, field);
        }

        if (TypeMemberModel.TryGetStaticProperty(structSym, memberName, out var prop))
        {
            return new BoundPropertyAccessExpression(null, receiver: null, structSym, prop);
        }

        // ADR-0112: a static (shared) method named here in non-call position is a
        // method group with a null receiver. Overload selection (when more than
        // one shared overload shares the name) is deferred to the conversion
        // classifier, driven by the target delegate signature.
        var staticMethods = TypeMemberModel.GetMethods(structSym, memberName, MemberQuery.Static(MemberKinds.Method));
        if (TryBuildUserMethodGroup(receiver: null, staticMethods, out var staticGroup))
        {
            return staticGroup;
        }

        Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
        return new BoundErrorExpression(null);
    }

    internal BoundExpression BindUserTypeStaticCall(StructSymbol structSym, CallExpressionSyntax ce)
        => BindUserTypeStaticCall((TypeSymbol)structSym, ce);

    /// <summary>
    /// Issue #1433: resolves <c>TypeName.method(args)</c> for a static
    /// (<c>shared</c>) method declared on a user struct/class OR interface. The
    /// member-resolution and overload/substitution logic is identical for both
    /// owner kinds (it routes through the canonical <see cref="TypeMemberModel"/>
    /// layer, ADR-0112); only the generic-owner carried to the emitter differs:
    /// a constructed generic struct goes through
    /// <see cref="BoundCallExpression.StaticGenericOwnerType"/> (issue #1209) and
    /// a constructed generic interface through
    /// <see cref="BoundCallExpression.StaticGenericInterfaceOwnerType"/> (issue
    /// #1030 parenting extended to methods) so the call is parented at the
    /// correct construction <c>TypeSpec</c>. A non-generic owner of either kind
    /// emits a bare <c>MethodDef</c> token.
    /// </summary>
    internal BoundExpression BindUserTypeStaticCall(TypeSymbol ownerType, CallExpressionSyntax ce)
    {
        var structSym = ownerType as StructSymbol;
        var ifaceSym = ownerType as InterfaceSymbol;
        var ownerDefinition = structSym?.Definition ?? (TypeSymbol)ifaceSym?.Definition;
        var ownerDefTypeParameters = structSym?.Definition?.TypeParameters
            ?? ifaceSym?.Definition?.TypeParameters
            ?? ImmutableArray<TypeParameterSymbol>.Empty;
        var ownerTypeArguments = structSym?.TypeArguments
            ?? ifaceSym?.TypeArguments
            ?? ImmutableArray<TypeSymbol>.Empty;

        var methodName = ce.Identifier.Text;

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        List<int> deferredStaticLambdaIndices = null;
        var staticArgIndex = 0;
        foreach (var argument in ce.Arguments)
        {
            if (argument is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else if (IsUntypedArrowLambda(OverloadResolver.UnwrapNamedArgumentValue(argument)))
            {
                // Issue #951: defer un-typed arrow lambdas until the static
                // method overload (and its delegate-typed parameters) is known.
                (deferredStaticLambdaIndices ??= new List<int>()).Add(staticArgIndex);
                boundArguments.Add(new BoundErrorExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
            }
            else
            {
                boundArguments.Add(BindExpression(argument));
            }

            staticArgIndex++;
        }

        var arguments = boundArguments.ToImmutable();

        // Issue #940: resolve static (shared) method overloads against the FULL
        // method group by arity, parameter types, and ref-kinds — identical to
        // the instance-method path — instead of taking the first by-name match
        // and arity-checking it (which rejected every overload but the first,
        // surfacing GS0144). The group is obtained through the ADR-0112
        // canonical member-resolution layer; OverloadResolver selects the best
        // candidate (and reports ambiguity / no-applicable-overload exactly as
        // for instance methods). A single-candidate group is returned unchanged
        // so the legacy per-position arity/optional/variadic diagnostics below
        // still apply (e.g. genuine arity mismatch on a non-overloaded method).
        var staticMethodGroup = TypeMemberModel.GetMethods(ownerType, methodName, MemberQuery.Static(MemberKinds.Method));
        if (!staticMethodGroup.IsDefaultOrEmpty)
        {
            var method = overloads.SelectInstanceOverloadOrReport(staticMethodGroup, arguments, ce, methodName, argumentNames: default);
            if (method == null)
            {
                return new BoundErrorExpression(null);
            }

            // Issue #951: bind any deferred un-typed arrow lambda against the
            // selected static method's delegate-typed parameter so its omitted
            // parameter type(s) and inferred return type are filled in from the
            // parameter shape. Static (`shared`) methods carry no receiver
            // parameter, so the argument index maps directly to the parameter
            // index. A non-delegate parameter leaves the lambda deferred; it is
            // then bound with no target (surfacing GS0304).
            if (deferredStaticLambdaIndices != null)
            {
                var rebound = arguments.ToBuilder();
                foreach (var idx in deferredStaticLambdaIndices)
                {
                    if (rebound[idx] is not BoundErrorExpression { Syntax: LambdaExpressionSyntax staticLambda })
                    {
                        continue;
                    }

                    if (idx < method.Parameters.Length
                        && MemberLookup.TryGetDelegateFunctionTypeFromSymbol(method.Parameters[idx].Type, out var staticTarget)
                        && staticTarget != null)
                    {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda, staticTarget);
                    }
                    else
                    {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda);
                    }
                }

                arguments = rebound.ToImmutable();
            }

            // ADR-0101 follow-up / issue #812: a user-declared static method
            // may declare a trailing variadic parameter. Allow flexible
            // arity, infer the element type from trailing args (if generic),
            // and pack / pass-through trailing args into a single slice
            // argument before the per-position conversion loop.
            var isVariadic = method.Parameters.Length > 0 && method.Parameters[method.Parameters.Length - 1].IsVariadic;
            var fixedParamCount = isVariadic ? method.Parameters.Length - 1 : method.Parameters.Length;

            // ADR-0063 / issue #936: count the leading non-optional parameters.
            // A static (`shared`) call may omit any trailing parameter that
            // declares a default value, mirroring the instance-call path in
            // OverloadResolver. Omitted slots are synthesized below from each
            // parameter's captured default constant.
            var requiredParamCount = method.Parameters.Length;
            for (var i = method.Parameters.Length - 1; i >= 0; i--)
            {
                if (method.Parameters[i].HasExplicitDefaultValue)
                {
                    requiredParamCount = i;
                }
                else
                {
                    break;
                }
            }

            if (isVariadic)
            {
                if (arguments.Length < fixedParamCount)
                {
                    Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, method.Name, fixedParamCount, arguments.Length);
                    return new BoundErrorExpression(null);
                }
            }
            else if (arguments.Length < requiredParamCount || arguments.Length > method.Parameters.Length)
            {
                Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, method.Parameters.Length, arguments.Length);
                return new BoundErrorExpression(null);
            }

            // Issue #1379: a `shared` (static) method on a generic user type may
            // reference the type's own type parameter(s) in its return type
            // and/or parameter types (`func Make(v T) Box[T]`). When the receiver
            // is a closed construction (`Box[int32]`), seed the substitution map
            // with the struct's type parameters -> the construction's type
            // arguments so the call's return (and parameter) types are surfaced
            // closed (`Box[int32]`), not the raw/open form (which fails the
            // conversion to the closed type, GS0155). This is the user-defined
            // counterpart of the imported-generic fix in issue #1216 and exercises
            // the binding receiver added in issue #1323.
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
            if (ownerDefinition != null
                && !ReferenceEquals(ownerDefinition, ownerType)
                && !ownerTypeArguments.IsDefaultOrEmpty
                && !ownerDefTypeParameters.IsDefaultOrEmpty)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
                var defParams = ownerDefTypeParameters;
                var count = Math.Min(defParams.Length, ownerTypeArguments.Length);
                for (var i = 0; i < count; i++)
                {
                    substitution[defParams[i]] = ownerTypeArguments[i];
                }
            }

            // Issue #312 / ADR-0020: resolve a generic static method's own type
            // arguments from an explicit `[T1, T2]` list at the call site or by
            // left-to-right inference from argument types.
            if (method.IsGeneric)
            {
                substitution ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                if (ce.TypeArgumentList != null)
                {
                    var explicitArgs = ce.TypeArgumentList.Arguments;
                    if (explicitArgs.Count != method.TypeParameters.Length)
                    {
                        Diagnostics.ReportWrongTypeArgumentCount(ce.TypeArgumentList.Location, method.Name, method.TypeParameters.Length, explicitArgs.Count);
                        return new BoundErrorExpression(null);
                    }

                    for (var i = 0; i < explicitArgs.Count; i++)
                    {
                        var ta = bindTypeClause(explicitArgs[i]);
                        if (ta == null)
                        {
                            return new BoundErrorExpression(null);
                        }

                        substitution[method.TypeParameters[i]] = ta;
                    }
                }
                else
                {
                    // ADR-0101 follow-up / issue #812: when the static method is
                    // variadic, fixed parameters infer pairwise as before;
                    // for the variadic slot, infer the element type from each
                    // trailing argument. A single trailing `[]U` arg with
                    // pass-through inference still infers `T=U`.
                    var inferenceLimit = isVariadic ? fixedParamCount : arguments.Length;
                    for (var i = 0; i < inferenceLimit; i++)
                    {
                        Binder.InferTypeArguments(method.Parameters[i].Type, arguments[i].Type, substitution);
                    }

                    if (isVariadic)
                    {
                        var variadicParam = method.Parameters[method.Parameters.Length - 1];
                        var variadicElementType = ((SliceTypeSymbol)variadicParam.Type).ElementType;
                        var trailingCount = arguments.Length - fixedParamCount;
                        if (trailingCount == 1 && arguments[fixedParamCount].Type is SliceTypeSymbol singleSlice)
                        {
                            Binder.InferTypeArguments(variadicElementType, singleSlice.ElementType, substitution);
                        }
                        else
                        {
                            for (var i = fixedParamCount; i < arguments.Length; i++)
                            {
                                Binder.InferTypeArguments(variadicElementType, arguments[i].Type, substitution);
                            }
                        }
                    }

                    foreach (var tp in method.TypeParameters)
                    {
                        if (!substitution.ContainsKey(tp))
                        {
                            Diagnostics.ReportTypeArgumentInferenceFailed(ce.Identifier.Location, method.Name, tp.Name);
                            return new BoundErrorExpression(null);
                        }
                    }
                }

                var constraintLocation = ce.TypeArgumentList != null
                    ? ce.TypeArgumentList.Location
                    : ce.Identifier.Location;
                foreach (var tp in method.TypeParameters)
                {
                    var typeArg = substitution[tp];
                    if (!Binder.SatisfiesConstraint(typeArg, tp))
                    {
                        Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, Binder.DescribeConstraint(tp));
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // ADR-0101 follow-up / issue #812: pack / pass-through for the
            // variadic slot. A single trailing arg whose type already equals
            // the substituted slice type passes through; otherwise wrap the
            // trailing args in a fresh `[]T` slice. Empty trailing => empty
            // slice.
            ImmutableArray<BoundExpression> permutedArgs;
            if (isVariadic)
            {
                var variadicParam = method.Parameters[method.Parameters.Length - 1];
                var sliceType = (SliceTypeSymbol)variadicParam.Type;
                var substitutedSlice = substitution != null
                    ? (SliceTypeSymbol)Binder.SubstituteType(sliceType, substitution)
                    : sliceType;
                var trailingCount = arguments.Length - fixedParamCount;
                var passThrough = trailingCount == 1 && arguments[fixedParamCount].Type == substitutedSlice;
                if (passThrough)
                {
                    permutedArgs = arguments;
                }
                else
                {
                    var packedTrailing = ImmutableArray.CreateBuilder<BoundExpression>(trailingCount);
                    for (var i = fixedParamCount; i < arguments.Length; i++)
                    {
                        packedTrailing.Add(arguments[i]);
                    }

                    var newArgs = ImmutableArray.CreateBuilder<BoundExpression>(fixedParamCount + 1);
                    for (var i = 0; i < fixedParamCount; i++)
                    {
                        newArgs.Add(arguments[i]);
                    }

                    newArgs.Add(new BoundArrayCreationExpression(ce, substitutedSlice, packedTrailing.MoveToImmutable()));
                    permutedArgs = newArgs.ToImmutable();
                }
            }
            else
            {
                // ADR-0063 / issue #936: pad any trailing optional parameters
                // the static call omitted with their captured default values so
                // the per-position conversion loop binds the full parameter
                // list (matching instance-method behavior).
                if (arguments.Length < method.Parameters.Length)
                {
                    var padded = ImmutableArray.CreateBuilder<BoundExpression>(method.Parameters.Length);
                    padded.AddRange(arguments);
                    for (var i = arguments.Length; i < method.Parameters.Length; i++)
                    {
                        padded.Add(OverloadResolver.CreateOptionalUserDefaultArgument(method.Parameters[i]));
                    }

                    permutedArgs = padded.MoveToImmutable();
                }
                else
                {
                    permutedArgs = arguments;
                }
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
            for (var i = 0; i < permutedArgs.Length; i++)
            {
                var paramType = method.Parameters[i].Type;

                // ADR-0060 / issue #1139: an inline-decl `out var n` / `out let
                // n` / `out _` was bound with TypeSymbol.Error in the first
                // pass (before the static method was resolved) and never
                // declared a local. Now that overload resolution has chosen the
                // method — and the method type-argument substitution is known —
                // re-bind it (via the shared helper used by the instance path)
                // so the synthesized local is typed from the resolved
                // (substituted) out-parameter pointee type and leaks into the
                // enclosing block scope. The out-var arg always sits in the
                // fixed-parameter region, so permutedArgs[i] / ce.Arguments[i] /
                // method.Parameters[i] line up. This must run BEFORE the
                // open-type-parameter shortcut so generic static out-parameters
                // (`func G[T](out r T)`) are handled too.
                var slotSyntax = i < ce.Arguments.Count ? ce.Arguments[i] : null;
                var substitutedPointeeType = substitution != null ? Binder.SubstituteType(paramType, substitution) : paramType;
                var reboundOutVar = TryRebindInlineOutVarPlaceholder(permutedArgs[i], slotSyntax, method.Parameters[i], substitutedPointeeType);
                if (reboundOutVar != null)
                {
                    convertedArgs.Add(reboundOutVar);
                    continue;
                }

                // Issue #1379: a parameter typed by the GENERIC STRUCT's own type
                // parameter (`func Make(v T)` on `Box[T]`) is substituted to the
                // closed receiver type argument (`int32`) so the argument is
                // converted to the concrete type. A parameter typed by an
                // unsubstituted (method) type parameter still passes through.
                if (paramType is TypeParameterSymbol typeParamParam
                    && (substitution == null || !substitution.ContainsKey(typeParamParam)))
                {
                    convertedArgs.Add(permutedArgs[i]);
                    continue;
                }

                if (substitution != null
                    && paramType is FunctionTypeSymbol openFunctionParameter
                    && LambdaBinder.TryGetFunctionLiteral(permutedArgs[i], out var functionLiteralArgument))
                {
                    // ADR-0087 §3 R6: substitute the open target before
                    // routing through the adapter. When the substituted
                    // target matches the literal's declared shape the
                    // adapter returns the literal unchanged (see
                    // IsIdentityAdapter), so the emitted MethodDef carries
                    // the literal's concrete signature and the reified
                    // Func/Action TypeSpec at the call site dispatches
                    // through real Invoke without DynamicInvoke marshalling.
                    var substitutedOpenTarget = (Binder.SubstituteType(openFunctionParameter, substitution) as FunctionTypeSymbol)
                        ?? openFunctionParameter;
                    convertedArgs.Add(lambdas.CreateErasedFunctionLiteralAdapter(functionLiteralArgument, substitutedOpenTarget));
                    continue;
                }

                var expectedType = substitution != null ? Binder.SubstituteType(paramType, substitution) : paramType;
                var argLoc = i < ce.Arguments.Count ? ce.Arguments[i].Location : ce.Location;
                convertedArgs.Add(conversions.BindCallArgumentWithRefKind(argLoc, permutedArgs[i], expectedType, method.Parameters[i]));
            }

            // Issue #1209: when the static call dispatches on a constructed
            // generic user type, carry the construction so the emitter parents
            // the call at the construction's TypeSpec (a bare MethodDef token is
            // invalid for a method of a generic type). Null for non-generic
            // receivers leaves the ordinary MethodDef path unchanged.
            // Issue #1433: the same parenting requirement applies to a
            // constructed generic INTERFACE owner; it is carried separately
            // because the emitter resolves interface- and struct-declared
            // statics through different TypeSpec helpers.
            var staticGenericOwner = structSym?.Definition != null ? structSym : null;
            var staticGenericInterfaceOwner = ifaceSym?.Definition != null ? ifaceSym : null;

            if (substitution != null)
            {
                var substitutedReturn = Binder.SubstituteType(method.Type, substitution);
                if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
                {
                    substitutedReturn = lambdas.WrapAsTask(substitutedReturn);
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn) { StaticGenericOwnerType = staticGenericOwner, StaticGenericInterfaceOwnerType = staticGenericInterfaceOwner };
                }

                if (!ReferenceEquals(substitutedReturn, method.Type))
                {
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn) { StaticGenericOwnerType = staticGenericOwner, StaticGenericInterfaceOwnerType = staticGenericInterfaceOwner };
                }
            }

            if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
            {
                var asyncReturn = lambdas.WrapAsTask(method.Type);
                return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), asyncReturn) { StaticGenericOwnerType = staticGenericOwner, StaticGenericInterfaceOwnerType = staticGenericInterfaceOwner };
            }

            return new BoundCallExpression(null, method, convertedArgs.ToImmutable()) { StaticGenericOwnerType = staticGenericOwner, StaticGenericInterfaceOwnerType = staticGenericInterfaceOwner };
        }

        Diagnostics.ReportUnableToFindMember(ce.Location, methodName);
        return new BoundErrorExpression(null);
    }

    private BoundExpression BindAccessorStep(BoundExpression receiver, ImportedClassSymbol classSymbol, ExpressionSyntax rightPart)
    {
        switch (rightPart)
        {
            case AccessorExpressionSyntax nested:
                // Issue #672: when the LHS is a CLR type symbol, check whether
                // the left segment of the nested accessor names a nested type
                // (e.g. `Environment.SpecialFolder.ApplicationData` — here
                // `SpecialFolder` is a nested enum inside `Environment`). If so,
                // create a new ImportedClassSymbol for the nested type and bind
                // the right segment against it, enabling chained static/enum
                // member access on nested types.
                if (classSymbol != null && TryResolveNestedTypeFromAccessorLeft(classSymbol, nested.LeftPart, out var nestedClassSymbol))
                {
                    if (nested.IsNullConditional)
                    {
                        // Null-conditional on a type is semantically meaningless
                        // but fall through to avoid a crash.
                        return new BoundErrorExpression(null);
                    }

                    return BindAccessorStep(null, nestedClassSymbol, nested.RightPart);
                }

                var head = BindAccessorStep(receiver, classSymbol, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                // Issue #507 follow-up: ParseNameOrCallExpression folds the
                // right-hand side of an accessor through ParsePostfixChain, so
                // `a.b?.c` parses as `AccessorExpression(a, ., AccessorExpression(b, ?., c))`.
                // The nested accessor's `?.` token must be honored here, or the
                // read/write degenerates into a plain `.c` against `b`'s nullable
                // type and reports "Cannot find member c".
                if (nested.IsNullConditional)
                {
                    return BindNullConditionalAccessExpressionCore(head, nested.RightPart);
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                var callResult = BindAccessorCall(receiver, classSymbol, ce);
                CheckValueTaskGetAwaiterGetResult(callResult, ce);
                return callResult;

            // Issue #569: an object-initializer suffix on a nested-type
            // constructor (`Outer.Inner() { Prop = val }`) parses as
            // ObjectCreationExpressionSyntax wrapping the call. Bind the
            // inner call through the accessor path (which resolves the
            // nested type constructor), then apply the initializer
            // assignments against the constructed instance.
            case ObjectCreationExpressionSyntax objCreate
                when objCreate.Target is CallExpressionSyntax innerCall:
                var ctorResult = BindAccessorCall(receiver, classSymbol, innerCall);
                if (ctorResult is BoundErrorExpression)
                {
                    return ctorResult;
                }

                return BindObjectInitializerSuffix(objCreate, ctorResult);

            // Issue #507 follow-up: support indexer reads through a member chain
            // (`obj.Member[k]`, `obj.A.B[k]`, `obj?.Member[k]`). ParsePostfixChain
            // folds a trailing `[...]` into the right-hand side of the most
            // recent `.`, so the indexer arrives here as the rightPart of an
            // AccessorExpression. We bind the indexer's target through the
            // accessor chain so we get the correct member-rooted bound receiver,
            // then route the index resolution through the shared helper.
            //
            // ADR-0073 / issue #710: when the indexer is null-conditional
            // (`a.b?[i]`, `a?.b?[i]?.c`), capture the bound receiver chain into
            // a synthetic local first and wrap the index in a
            // BoundNullConditionalAccessExpression — mirroring the handling of
            // a nested `?.` accessor a few lines above.
            case IndexExpressionSyntax ix:
                var indexTarget = BindAccessorStep(receiver, classSymbol, ix.Target);
                if (indexTarget is BoundErrorExpression)
                {
                    return indexTarget;
                }

                if (ix.IsNullConditional)
                {
                    return BindNullConditionalIndexFromBoundTarget(indexTarget, ix);
                }

                return BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location);

            case NameExpressionSyntax ne:
                if (ne.IdentifierToken.IsMissing)
                {
                    // Incomplete member access such as `x.` with no member name yet.
                    // The parser already reported the missing identifier; binding a
                    // null member name would throw (e.g. Type.GetProperty(null)), so
                    // bail out gracefully. This keeps completion / semantic tokens
                    // working while the user is mid-typing.
                    return new BoundErrorExpression(null);
                }

                if (classSymbol != null)
                {
                    var foundMember = classSymbol.TryLookupMember(ne.IdentifierToken.Text, ne, out var staticMember);
                    if (!foundMember)
                    {
                        // Issue #337: a static member name that resolves to a
                        // method (not a field/property) is a method group. In a
                        // delegate-conversion context it materializes as a
                        // delegate over the selected overload; the conversion
                        // classifier decides which overload (if any) applies.
                        if (TryBindClrMethodGroup(receiver: null, classSymbol.ClassType, wantStatic: true, ne.IdentifierToken.Text, out var staticGroup))
                        {
                            return staticGroup;
                        }

                        Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                        return new BoundErrorExpression(null);
                    }

                    // Stream B: static field/property read on imported type.
                    // `Receiver == null` flags the access as static. Literal
                    // (const) fields aren't real runtime fields, so we inline
                    // their constant value rather than emit `ldsfld`.
                    if (staticMember is FieldInfo litField && litField.IsLiteral)
                    {
                        return new BoundLiteralExpression(null, litField.GetRawConstantValue(), TypeSymbol.FromClrType(litField.FieldType));
                    }

                    var staticType = staticMember switch
                    {
                        PropertyInfo sp => TypeSymbol.FromClrType(sp.PropertyType),
                        FieldInfo sf => TypeSymbol.FromClrType(sf.FieldType),
                        _ => TypeSymbol.Error,
                    };

                    // Issue #1330: when the receiver is a generic type
                    // constructed over an in-scope generic type parameter
                    // (`Comparer[TResult].Default`), the closed CLR member type
                    // is type-erased (`Comparer<object>`). Recover the symbolic
                    // member type (`Comparer[TResult]`) by substituting the
                    // receiver's symbolic arguments through the open member, and
                    // carry the symbolic container so the emitter parents the
                    // static read at the constructed `Comparer<!TResult>`
                    // TypeSpec rather than the erased `Comparer<object>`.
                    if (classSymbol.SymbolicReceiver != null)
                    {
                        var symbolicMemberType = ResolveStaticMemberTypeFromSymbolicReceiver(classSymbol.SymbolicReceiver, staticMember);
                        if (symbolicMemberType != null)
                        {
                            staticType = symbolicMemberType;
                        }

                        return new BoundClrPropertyAccessExpression(null, null, staticMember, staticType, classSymbol.SymbolicReceiver);
                    }

                    return new BoundClrPropertyAccessExpression(null, null, staticMember, staticType);
                }
                else if (receiver != null && receiver.Type is StructSymbol structSym)
                {
                    // ADR-0112 A3: this-first base-chain instance field walk via
                    // the canonical member-resolution layer, surfacing the
                    // declaring struct so the emitted field token names the right owner.
                    if (TypeMemberModel.TryGetFieldIncludingInherited(structSym, ne.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Field), out var field, out var declaringType))
                    {
                        // Issue #186 / #175: dotted field read fires
                        // GS0204 if the field carries `@Obsolete`.
                        reportObsoleteUseIfApplicable(ne.IdentifierToken.Location, field, $"{declaringType.Name}.{field.Name}");

                        // Issue #950: enforce `protected` field access — only the
                        // declaring type and its derived types may read it.
                        if (!AccessibilityChecker.IsAccessible(field.Accessibility, declaringType, this.function))
                        {
                            Diagnostics.ReportProtectedMemberInaccessible(ne.IdentifierToken.Location, field.Name, declaringType.Name);
                        }

                        // ADR-0122 §10 / issue #1035: a fixed-size buffer field
                        // decays to a `*T` to the first element. Lower
                        // `recv.buf` to a reinterpret of `&recv.buf` (the
                        // address of the inline backing struct, whose first
                        // element sits at offset 0) to the element pointer
                        // type. Indexing / passing then flows through the
                        // existing unmanaged-pointer machinery.
                        if (field.IsFixedBuffer)
                        {
                            return MakeFixedBufferPointer(receiver, declaringType, field);
                        }

                        return ApplyMemberNarrowing(new BoundFieldAccessExpression(null, receiver, declaringType, field));
                    }

                    // ADR-0051: check properties before reporting "unable to find member".
                    if (TypeMemberModel.TryGetProperty(structSym, ne.IdentifierToken.Text, out var prop, out var propDeclaringType))
                    {
                        if (!prop.HasGetter)
                        {
                            Diagnostics.ReportCannotAssign(ne.Location, ne.IdentifierToken.Text);
                            return new BoundErrorExpression(null);
                        }

                        // Issue #950: enforce `protected` property access.
                        if (!AccessibilityChecker.IsAccessible(prop.Accessibility, propDeclaringType, this.function))
                        {
                            Diagnostics.ReportProtectedMemberInaccessible(ne.IdentifierToken.Location, prop.Name, propDeclaringType.Name);
                        }

                        return ApplyMemberNarrowing(new BoundPropertyAccessExpression(null, receiver, structSym, prop));
                    }

                    // Issue #1213 / #1221: an `event` member referenced in
                    // expression position (e.g. `this.MyEvent?.Invoke(args)`)
                    // binds to its backing delegate field, mirroring how C#
                    // compiles a raise of a field-like event to a read of the
                    // backing field. Issue #1213 enabled this for an event
                    // declared on the receiver type; issue #1221 walks the base
                    // chain so an event inherited from a base class can be raised
                    // from a derived type — the field access targets the base
                    // type that declares the (now `family`/protected) backing
                    // field. Restricted to access from inside the declaring type
                    // or a derived type (`IsWithinType`); cross-type reads
                    // continue to fall through to the existing member-lookup
                    // diagnostics so the `+=`/`-=` subscription path is
                    // unaffected.
                    if (IsWithinType(structSym))
                    {
                        for (var evtDeclType = structSym; evtDeclType != null; evtDeclType = evtDeclType.BaseClass)
                        {
                            var evt = evtDeclType.Events.FirstOrDefault(e =>
                                e.Name == ne.IdentifierToken.Text && e.IsFieldLike && e.BackingField != null);
                            if (evt != null)
                            {
                                return ApplyMemberNarrowing(new BoundFieldAccessExpression(null, receiver, evtDeclType, evt.BackingField));
                            }
                        }
                    }

                    // Issue #296 / #1582: a GSharp class inheriting an imported
                    // CLR base (directly or through user classes) exposes the
                    // base's instance properties/fields — including inherited
                    // `protected` / `protected internal` members. Resolve the
                    // inherited CLR base type by walking the user base chain,
                    // then reflect the member (reflection walks the CLR chain).
                    if (GetInheritedClrBaseType(structSym) is System.Type inheritedBaseClr)
                    {
                        var memberName = ne.IdentifierToken.Text;
                        var clrProp = ClrTypeUtilities.SafeGetInheritedInstanceProperty(inheritedBaseClr, memberName);
                        if (clrProp != null && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = ClrTypeUtilities.SafeGetInheritedInstanceField(inheritedBaseClr, memberName);
                        if (clrFld != null)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrFld, TypeSymbol.FromClrType(clrFld.FieldType));
                        }
                    }

                    // ADR-0112: an instance method named here in non-call position
                    // is a method group captured against the bound receiver. The
                    // conversion classifier selects the overload (if any) from the
                    // target delegate signature; the emitter binds the delegate's
                    // Target to this receiver (boxing value-type receivers).
                    var instanceMethods = TypeMemberModel.GetMethods(structSym, ne.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Method));
                    if (TryBuildUserMethodGroup(receiver, instanceMethods, out var instanceUserGroup))
                    {
                        return instanceUserGroup;
                    }

                    // Issue #1136: an inherited System.Object instance member
                    // (GetType/ToString/GetHashCode/Equals) named in method-group
                    // position. When the user type declares no explicit imported
                    // base, fall back to typeof(object) so the member is captured
                    // as a CLR method group resolvable against a target delegate.
                    var inheritedMgClr = structSym.ImportedBaseType?.ClrType ?? typeof(object);
                    if (TryBindClrMethodGroup(receiver, inheritedMgClr, wantStatic: false, ne.IdentifierToken.Text, out var inheritedClrGroup))
                    {
                        return inheritedClrGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else if (receiver != null && receiver.Type is EnumSymbol)
                {
                    // Issue #1218: an inherited System.Enum / ValueType / Object
                    // instance member (HasFlag/ToString/GetHashCode/Equals/GetType)
                    // named in method-group position on an enum value. Capture it
                    // as a CLR method group over typeof(System.Enum) so it resolves
                    // against a target delegate signature; the emitter boxes the
                    // value-type receiver into the delegate Target.
                    if (TryBindClrMethodGroup(receiver, typeof(System.Enum), wantStatic: false, ne.IdentifierToken.Text, out var enumClrGroup))
                    {
                        return enumClrGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else if (receiver != null && receiver.Type is InterfaceSymbol ifaceSym)
                {
                    // Issue #1068: read a property declared on the static
                    // interface type (or any base interface) through an
                    // interface-typed receiver. Interface methods already
                    // dispatch via the InterfaceSymbol path in
                    // ExpressionBinder.Calls.cs; this mirrors that for
                    // properties so `b.H` (b : IBase) resolves the abstract
                    // accessor and emits a verifiable `callvirt get_H`.
                    // Inherited base-interface members are surfaced because
                    // TypeMemberModel.TryGetProperty walks SelfAndAllBaseInterfaces.
                    if (TypeMemberModel.TryGetProperty(ifaceSym, ne.IdentifierToken.Text, out var ifaceProp, out _))
                    {
                        if (!ifaceProp.HasGetter)
                        {
                            Diagnostics.ReportCannotAssign(ne.Location, ne.IdentifierToken.Text);
                            return new BoundErrorExpression(null);
                        }

                        return new BoundPropertyAccessExpression(null, receiver, null, ifaceProp);
                    }

                    // Issue #1397: an instance method declared on the static
                    // interface type (or any user base interface) named in
                    // method-group position is captured against the bound
                    // receiver, mirroring the class-receiver path above. The
                    // emitter dispatches via `ldvirtftn` so the delegate invokes
                    // the concrete implementation through interface dispatch.
                    // TypeMemberModel.GetMethods walks SelfAndAllBaseInterfaces
                    // so an inherited base-interface method binds too.
                    var ifaceInstanceMethods = TypeMemberModel.GetMethods(ifaceSym, ne.IdentifierToken.Text, MemberQuery.Instance(MemberKinds.Method));
                    if (TryBuildUserMethodGroup(receiver, ifaceInstanceMethods, out var ifaceUserGroup))
                    {
                        return ifaceUserGroup;
                    }

                    // Issue #1181: a user interface that extends an imported/BCL
                    // interface (e.g. `interface IBox : ICollection`) inherits
                    // that interface's properties/fields/methods. Mirror the
                    // imported-base-class fallback above by probing the
                    // transitive imported base interfaces so `b.Count`
                    // (b : IBox) resolves and emits a verifiable
                    // `callvirt get_Count`. The receiver carries an
                    // InterfaceImpl row to each imported base interface, so a
                    // CLR member access on it is verifiable.
                    var ifaceMemberName = ne.IdentifierToken.Text;
                    foreach (var clrBaseIface in MemberLookup.GetTransitiveClrBaseInterfaces(ifaceSym))
                    {
                        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBaseIface, ifaceMemberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrProp != null && clrProp.GetIndexParameters().Length == 0 && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = ClrTypeUtilities.SafeGetField(clrBaseIface, ifaceMemberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrFld != null)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrFld, TypeSymbol.FromClrType(clrFld.FieldType));
                        }
                    }

                    // Issue #1181: an inherited imported-base-interface method
                    // named in method-group position (e.g. `b.Dispose` passed
                    // to a delegate) is captured against the bound receiver.
                    foreach (var clrBaseIface in MemberLookup.GetTransitiveClrBaseInterfaces(ifaceSym))
                    {
                        if (TryBindClrMethodGroup(receiver, clrBaseIface, wantStatic: false, ifaceMemberName, out var ifaceClrGroup))
                        {
                            return ifaceClrGroup;
                        }
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else if (receiver != null && receiver.Type is TupleTypeSymbol tupleSym)
                {
                    // Phase 4.5: tuple element access via Item1..ItemN.
                    var memberName = ne.IdentifierToken.Text;
                    if (memberName.StartsWith("Item", System.StringComparison.Ordinal)
                        && int.TryParse(memberName.Substring(4), out var oneBased)
                        && oneBased >= 1 && oneBased <= tupleSym.Arity)
                    {
                        return new BoundTupleElementAccessExpression(null, receiver, tupleSym, oneBased - 1);
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is NullableTypeSymbol nullableSym
                    && nullableSym.UnderlyingType?.ClrType is { IsValueType: true } nullableInnerClr
                    && this.memberLookup.TryGetNullableConstructedType(nullableInnerClr, out var nullableClr))
                {
                    // Issue #517: a value-type `T?` lowers to `System.Nullable<T>`
                    // at the CLR layer (see `EncodeTypeSymbol`). Resolve `.Value`,
                    // `.HasValue`, etc. against that constructed generic so the
                    // BCL instance API surfaces the same way it does for any
                    // other CLR struct. NRT receivers (reference-type underlying)
                    // have no `Nullable<T>` projection and continue to fall
                    // through to the existing GS0158 path below.
                    var nullableMemberName = ne.IdentifierToken.Text;
                    var nullableProp = ClrTypeUtilities.SafeGetProperty(nullableClr, nullableMemberName, BindingFlags.Public | BindingFlags.Instance);
                    if (nullableProp != null && nullableProp.GetIndexParameters().Length == 0 && nullableProp.CanRead)
                    {
                        var nullablePropType = ClrNullability.GetPropertyTypeSymbol(nullableProp);
                        return new BoundClrPropertyAccessExpression(null, receiver, nullableProp, nullablePropType);
                    }

                    if (TryBindClrMethodGroup(receiver, nullableClr, wantStatic: false, nullableMemberName, out var nullableGroup))
                    {
                        return nullableGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, nullableMemberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is NullableTypeSymbol openNullableSym
                    && openNullableSym.UnderlyingType is TypeParameterSymbol openTp
                    && openTp.HasValueTypeConstraint)
                {
                    // Issue #806: a `T?` receiver where T is an open value-type
                    // type parameter still lowers to `Nullable<T>` at IL emit
                    // time, but the closed `Nullable<T>` CLR instance is not
                    // available here. Resolve the member name against the open
                    // `typeof(Nullable<>)` definition so `.HasValue`, `.Value`
                    // and `.GetValueOrDefault()` bind successfully and lower
                    // to a normal property/method access on the symbolic
                    // constructed receiver.
                    var openNullableMemberName = ne.IdentifierToken.Text;
                    var openNullableDef = typeof(System.Nullable<>);
                    var openProp = ClrTypeUtilities.SafeGetProperty(openNullableDef, openNullableMemberName, BindingFlags.Public | BindingFlags.Instance);
                    if (openProp != null && openProp.GetIndexParameters().Length == 0 && openProp.CanRead)
                    {
                        // HasValue → bool (concrete); Value → the open T (the
                        // property's PropertyType IS the open type parameter
                        // itself in the reflection model). Substitute back to
                        // the binder's symbolic T so downstream type checks
                        // see the right symbol.
                        TypeSymbol openPropType;
                        if (openProp.PropertyType.IsGenericParameter)
                        {
                            openPropType = openTp;
                        }
                        else
                        {
                            openPropType = ClrNullability.GetPropertyTypeSymbol(openProp);
                        }

                        return new BoundClrPropertyAccessExpression(null, receiver, openProp, openPropType);
                    }

                    if (TryBindClrMethodGroup(receiver, openNullableDef, wantStatic: false, openNullableMemberName, out var openNullableGroup))
                    {
                        return openNullableGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, openNullableMemberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type != null && receiver.Type is not NullableTypeSymbol && receiver.Type.ClrType != null)
                {
                    // Phase 4 exit: read a public instance property or field on
                    // a CLR receiver (e.g. `lst.Count`, `sb.Length`,
                    // `kvp.Key`). Static members are reached through
                    // ImportedClassSymbol; this path covers instances. Nullable
                    // receivers must be narrowed or use `?.` before this path.
                    var clrReceiverType = receiver.Type.ClrType;
                    var memberName = ne.IdentifierToken.Text;

                    // Issue #529: use interface-aware lookup so that members
                    // declared on a base interface (e.g. IReadOnlyCollection<T>.Count
                    // surfaced through IReadOnlyList<T>) are found.
                    var prop = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (prop != null && prop.GetIndexParameters().Length == 0 && prop.CanRead)
                    {
                        // Issue #504 follow-up: properties with NRT
                        // annotations (e.g. `DirectoryInfo.Parent` is
                        // `DirectoryInfo?`) must surface as
                        // NullableTypeSymbol so callers can compare to
                        // `nil` without GS0129. ByRef-returning properties
                        // are rare on CLR types and stay on the existing
                        // MapClrMemberType path, which preserves the
                        // ByRefTypeSymbol wrapper.
                        // Issue #794: substitute the receiver's symbolic
                        // type arguments back through the property's open
                        // declaring type so e.g. `Dictionary[K, V]().Keys`
                        // surfaces as `ICollection[K]` (a generic shape
                        // containing the in-scope `K`) instead of the
                        // type-erased `ICollection<object>`.
                        var receiverOverride = ResolveInstancePropertyTypeFromReceiver(receiver.Type, prop);
                        var propType = receiverOverride
                            ?? (prop.PropertyType.IsByRef
                                ? MapClrMemberType(prop.PropertyType)
                                : ClrNullability.GetPropertyTypeSymbol(prop));
                        return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrPropertyAccessExpression(null, receiver, prop, propType));
                    }

                    var fld = ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrReceiverType, memberName, BindingFlags.Public | BindingFlags.Instance);
                    if (fld != null)
                    {
                        return new BoundClrPropertyAccessExpression(null, receiver, fld, ClrNullability.GetFieldTypeSymbol(fld));
                    }

                    // Issue #337: an instance member name that resolves to a
                    // method (not a field/property) is a method group bound to
                    // this receiver. In a delegate-conversion context it captures
                    // the receiver as the delegate target over the selected
                    // overload.
                    if (TryBindClrMethodGroup(receiver, clrReceiverType, wantStatic: false, memberName, out var instanceGroup))
                    {
                        return instanceGroup;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null
                    && receiver.Type is SliceTypeSymbol or ArrayTypeSymbol
                    && receiver.Type.ClrType == null)
                {
                    // Issue #1162: a slice/array whose element is a
                    // same-compilation user type has a null backing
                    // ClrType during binding, so the CLR-property arm
                    // above (gated on `receiver.Type.ClrType != null`)
                    // cannot reflect `System.Array` members such as
                    // `.Length`/`.Rank`/`.LongLength`. The runtime
                    // receiver is the real `T[]`, which derives from
                    // `System.Array`, so reflect the member directly
                    // against `typeof(System.Array)` and bind it as an
                    // ordinary CLR property read; the IL is correct
                    // because the array genuinely exposes the member.
                    var arrayMemberName = ne.IdentifierToken.Text;
                    var arrayProp = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(typeof(System.Array), arrayMemberName, BindingFlags.Public | BindingFlags.Instance);
                    if (arrayProp != null && arrayProp.GetIndexParameters().Length == 0 && arrayProp.CanRead)
                    {
                        return new BoundClrPropertyAccessExpression(null, receiver, arrayProp, ClrNullability.GetPropertyTypeSymbol(arrayProp));
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, arrayMemberName);
                    return new BoundErrorExpression(null);
                }
                else if (receiver != null && receiver.Type is TypeParameterSymbol tpRecv)
                {
                    // Issue #1235: a value whose static type is a type parameter
                    // constrained to a class (or interface) exposes that
                    // constraint's FULL instance member surface — fields and
                    // properties, not only methods (instance method calls are
                    // resolved through the constraint in ExpressionBinder.Calls).
                    // Field reads lower to a `box !!T; ldfld` against the
                    // constraint class; property reads dispatch through a
                    // verifiable `box !!T; callvirt get_X` (see the emitter).
                    var tpMember = BindTypeParameterInstanceMemberAccess(tpRecv, receiver, ne);
                    if (tpMember != null)
                    {
                        return tpMember;
                    }

                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }
                else
                {
                    Diagnostics.ReportUnableToFindMember(ne.Location, ne.IdentifierToken.Text);
                }

                return new BoundErrorExpression(null);

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// Issue #672: resolves a nested CLR type from the left part of an
    /// accessor expression when the enclosing type is already known (i.e.
    /// <paramref name="classSymbol"/> is non-null). Supports single-level
    /// nesting (left part is a <see cref="NameExpressionSyntax"/>) and
    /// multi-level nesting (left part is an <see cref="AccessorExpressionSyntax"/>
    /// whose segments form a chain of nested types).
    /// </summary>
    private bool TryResolveNestedTypeFromAccessorLeft(ImportedClassSymbol classSymbol, ExpressionSyntax leftPart, out ImportedClassSymbol nestedClassSymbol)
    {
        nestedClassSymbol = null;

        if (leftPart is NameExpressionSyntax nameExpr)
        {
            var name = nameExpr.IdentifierToken.Text;

            // Only resolve as a nested type when the name is NOT a static
            // field/property or method group — those take precedence.
            if (classSymbol.TryLookupMember(name, nameExpr, out _))
            {
                return false;
            }

            if (TryBindClrMethodGroup(receiver: null, classSymbol.ClassType, wantStatic: true, name, out _))
            {
                return false;
            }

            if (scope.References.TryResolveNestedType(classSymbol.ClassType, name, out var nestedType))
            {
                nestedClassSymbol = new ImportedClassSymbol(nestedType, nameExpr);
                return true;
            }

            return false;
        }

        if (leftPart is AccessorExpressionSyntax accessor)
        {
            // Multi-level nesting: recursively resolve the left side first,
            // then resolve the right side as a nested type of that.
            if (!TryResolveNestedTypeFromAccessorLeft(classSymbol, accessor.LeftPart, out var intermediateSymbol))
            {
                return false;
            }

            if (accessor.RightPart is NameExpressionSyntax innerName)
            {
                var innerNameText = innerName.IdentifierToken.Text;
                if (scope.References.TryResolveNestedType(intermediateSymbol.ClassType, innerNameText, out var deepNested))
                {
                    nestedClassSymbol = new ImportedClassSymbol(deepNested, innerName);
                    return true;
                }
            }

            return false;
        }

        return false;
    }

    private BoundExpression BindIndexExpression(IndexExpressionSyntax syntax)
    {
        if (syntax.IsNullConditional)
        {
            // ADR-0073 / issue #710: `a?[i]` evaluates `a` once; if nil, the
            // whole expression is nil (without touching the indexer or the
            // index operand). Otherwise it indexes the captured value once.
            return BindNullConditionalIndexExpression(syntax);
        }

        var target = BindExpression(syntax.Target);
        return BindIndexAgainstTarget(target, syntax.Index, syntax.Target.Location);
    }

    // ADR-0073 / issue #710: bind `target?[index]`. The receiver is evaluated
    // exactly once into a synthetic capture local; the indexed access is then
    // bound against the capture and wrapped in a
    // BoundNullConditionalAccessExpression so the existing lowering and emit
    // pipeline (which already handles `?.`) covers the new form for free.
    private BoundExpression BindNullConditionalIndexExpression(IndexExpressionSyntax syntax)
    {
        var receiver = BindExpression(syntax.Target);
        if (receiver is BoundErrorExpression)
        {
            return receiver;
        }

        return BindNullConditionalIndexFromBoundTarget(receiver, syntax);
    }

    // ADR-0073 / issue #710: shared core for `?[i]` binding. Splits the
    // already-bound receiver into capture + indexed access so nested
    // accessor-chain entry points (e.g. the `IndexExpressionSyntax` case in
    // BindAccessorStep that handles `a.b?[i]`) can reuse the same logic.
    private BoundExpression BindNullConditionalIndexFromBoundTarget(BoundExpression receiver, IndexExpressionSyntax syntax)
    {
        var receiverType = receiver.Type;
        TypeSymbol underlying;
        if (receiverType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
        }
        else if (receiverType == TypeSymbol.Null)
        {
            // `nil?[i]` is statically nil.
            return new BoundLiteralExpression(null, null);
        }
        else
        {
            // GS0300 (warning): the receiver of `?[...]` is non-nullable, so
            // the null-check is dead code. Suggest the plain `[...]` form.
            Diagnostics.ReportNullConditionalIndexReceiverNotNullable(
                syntax.OpenBracketToken.Location,
                receiverType);
            underlying = receiverType;
        }

        var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);

        // Push a temp scope so the capture is in scope while we bind the
        // indexed access against it.
        scope = new BoundScope(scope);
        scope.TryDeclareVariable(capture);

        var captureRef = new BoundVariableExpression(null, capture);
        var whenNotNull = BindIndexAgainstTarget(captureRef, syntax.Index, syntax.Target.Location);

        scope = scope.Parent;

        if (whenNotNull is BoundErrorExpression || whenNotNull.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var resultType = whenNotNull.Type is NullableTypeSymbol
            ? whenNotNull.Type
            : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

        // Issue #1475: allocate the result slot for ANY value-type underlying
        // recognised by symbol (user enum/struct, value-constrained type
        // parameter, tuple), not only when `ClrType.IsValueType`. Mirrors the
        // member-access `?.` path so `?[]` over a user value type also
        // materialises `default(Nullable<T>)` on the nil branch instead of
        // `ldnull`.
        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.IsValueTypeSymbol(nullableResult.UnderlyingType))
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }

    private BoundExpression BindIndexAgainstTarget(BoundExpression target, ExpressionSyntax indexSyntax, TextLocation targetLocation)
    {
        // ADR-0122 / issue #1014: pointer indexing `p[i]` == `*(p + i)`.
        if (target.Type is PointerTypeSymbol pointerTarget)
        {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so `p[i]` (which lowers to `*(p + i)`) is rejected (GS0403); cast
            // to a typed pointer `*T` first.
            if (TypeSymbol.IsVoidPointer(target.Type))
            {
                Diagnostics.ReportVoidPointerOperationNotAllowed(targetLocation, "index");
                return new BoundErrorExpression(null);
            }

            var pointerIndex = BindExpression(indexSyntax);
            if (pointerIndex is BoundErrorExpression)
            {
                return pointerIndex;
            }

            if (!IsPointerOffsetType(pointerIndex.Type))
            {
                pointerIndex = conversions.BindConversion(indexSyntax, TypeSymbol.NInt);
            }

            var elementPointer = LowerPointerOffset(target, pointerTarget, pointerIndex, subtract: false);
            return new BoundDereferenceExpression(null, elementPointer);
        }

        // Issue #1016: a range operand (`a[lo..hi]`) slices the target rather
        // than indexing a single element.
        if (indexSyntax is RangeExpressionSyntax rangeSyntax)
        {
            return BindRangeSlice(target, rangeSyntax, targetLocation);
        }

        // Issue #1022: a from-end index (`a[^n]`) reads the single element
        // `length - n`.
        if (indexSyntax is FromEndIndexExpressionSyntax fromEndSyntax)
        {
            return BindFromEndIndex(target, fromEndSyntax, targetLocation);
        }

        // Issue #1038: an index whose value is a `System.Range` slices the
        // target (`let r = 1..3; a[r]`, or the inline `a[(1..3)]`), dispatching
        // to the same array/string/span/`this[System.Range]` shapes used by the
        // syntactic `a[1..3]` form. Bind the index once here and reuse the bound
        // expression in the ordinary index paths below to avoid re-binding.
        // `default`/interpolated index syntaxes can never be a range value and
        // keep their dedicated conversion handling, so they are not pre-bound.
        BoundExpression boundIndex = null;
        if (indexSyntax is not DefaultExpressionSyntax && indexSyntax is not InterpolatedStringExpressionSyntax)
        {
            boundIndex = BindExpression(indexSyntax);
            if (boundIndex is BoundErrorExpression)
            {
                return boundIndex;
            }

            if (IsSystemRangeType(boundIndex.Type))
            {
                return BindRangeValueSlice(target, boundIndex, targetLocation);
            }
        }

        BoundExpression ConvertIndex(TypeSymbol conversionTargetType) =>
            boundIndex != null
                ? conversions.BindConversion(indexSyntax.Location, boundIndex, conversionTargetType)
                : conversions.BindConversion(indexSyntax, conversionTargetType);

        BoundExpression BoundIndexArg() => boundIndex ?? BindExpression(indexSyntax);

        // Phase 3.A.4: map indexing `m[k]` — key bound to K, result type V.
        // The Go convention "zero value if missing" applies at evaluation;
        // the bound representation reuses BoundIndexExpression with the
        // element type set to V.
        if (target.Type is MapTypeSymbol mapType)
        {
            var key = ConvertIndex(mapType.KeyType);
            return new BoundIndexExpression(null, target, key, mapType.ValueType);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            // Issue #1279: array/slice element access accepts any integer-typed
            // index (matching C#). `boundIndex` is non-null for every non-
            // default/interpolated index; those two carry no natural type and
            // keep the historical int32 conversion driven by the target type.
            var index = boundIndex != null
                ? ConvertArrayElementIndex(indexSyntax.Location, boundIndex)
                : ConvertIndex(TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, element);
        }

        // Issue #1129: `string` is the primitive `TypeSymbol.String` (not an
        // `ImportedTypeSymbol`), so it matches none of the indexer-resolution
        // branches below. Model `s[i]` against .NET's `String` indexer
        // (`char this[int]` / `get_Chars(int)`), yielding a `char`. Issue #1279:
        // any integer-typed index is accepted; because `get_Chars` takes an
        // int32, the wider integer types convert (narrow) to int32. Emit already
        // lowers a `BoundIndexExpression` whose target is `string` to `get_Chars`
        // (#537).
        if (target.Type == TypeSymbol.String)
        {
            var index = boundIndex != null
                ? ConvertStringCharIndex(indexSyntax.Location, boundIndex)
                : ConvertIndex(TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, TypeSymbol.Char);
        }

        // Phase 4 exit: CLR indexer read on an imported reference type
        // (e.g. `d["k"]` on Dictionary[string, int]). Pick a public
        // instance indexer (a `PropertyInfo` whose `GetIndexParameters()`
        // matches the single argument by assignability).
        // Issue #209: when the target carries inner-position nullable flags,
        // use them to type the element correctly (e.g., `list[0]` on `List<string?>` → `string?`).
        if (target.Type is NullabilityAnnotatedTypeSymbol annotIdx && annotIdx.ClrType is System.Type clrAnnotIdx)
        {
            var idxArgsAnnot = ImmutableArray.Create(BoundIndexArg());
            if (this.memberLookup.TryResolveClrIndexer(clrAnnotIdx, idxArgsAnnot, out var idxPropAnnot))
            {
                var elemTypeAnnot = annotIdx.GetTypeArgumentSymbolForClrType(idxPropAnnot.PropertyType);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxPropAnnot, idxArgsAnnot, elemTypeAnnot));
            }
        }
        else if (target.Type is ImportedTypeSymbol && target.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BoundIndexArg());
            if (this.memberLookup.TryResolveClrIndexer(clrTarget, idxArgs, out var idxProp))
            {
                var elementType = MapErasedIndexerElementType((ImportedTypeSymbol)target.Type, idxProp);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxProp, idxArgs, elementType));
            }
        }

        // ADR-0118 / issue #944: index access on a user-defined type that
        // declares an indexer member (`prop this[i T] U`). Binds `obj[i]` to a
        // call of the indexer getter (`obj.get_Item(i)`).
        if (target.Type is StructSymbol userIndexTarget
            && TryGetUserIndexer(userIndexTarget, out var readIndexer, out var readSubstitution)
            && readIndexer.Parameters.Length == 1)
        {
            if (readIndexer.GetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
                return new BoundErrorExpression(null);
            }

            var paramType = readSubstitution != null
                ? Binder.SubstituteType(readIndexer.Parameters[0].Type, readSubstitution)
                : readIndexer.Parameters[0].Type;
            var indexArg = ConvertIndex(paramType);
            var elementType = readSubstitution != null
                ? Binder.SubstituteType(readIndexer.Type, readSubstitution)
                : readIndexer.Type;
            return new BoundUserInstanceCallExpression(
                null,
                target,
                readIndexer.GetterSymbol,
                ImmutableArray.Create(indexArg),
                elementType);
        }

        if (target.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
        }

        return new BoundErrorExpression(null);
    }

    private BoundExpression BindIndexedWriteThroughChain(
        BoundExpression chainBase,
        ExpressionSyntax remainingChain,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        SyntaxToken compoundOperatorToken,
        ExpressionSyntax compoundRhsSyntax,
        TextLocation diagnosticLocation,
        SyntaxNode outerSyntax)
    {
        if (TrySplitAtLeftmostNullConditional(remainingChain, out var leftSyntax, out var rightSyntax))
        {
            BoundExpression boundLeft = chainBase == null
                ? BindExpression(leftSyntax)
                : BindAccessorStep(chainBase, null, leftSyntax);
            if (boundLeft is BoundErrorExpression || boundLeft.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            TypeSymbol underlying;
            if (boundLeft.Type is NullableTypeSymbol nullable)
            {
                underlying = nullable.UnderlyingType;
            }
            else if (boundLeft.Type == TypeSymbol.Null)
            {
                // Statically nil receiver: assignment is a no-op. Produce a
                // bound literal null so the surrounding expression sees a
                // well-typed value; lowering treats `null` literals as
                // statement-position no-ops.
                return new BoundLiteralExpression(null, null);
            }
            else
            {
                // Non-nullable receiver: `?.` degenerates to `.`, but we still
                // produce a nullable result type for syntactic consistency
                // with the read-side null-conditional path.
                underlying = boundLeft.Type;
            }

            var captureName = "$ncap_" + (++binderCtx.NullConditionalCaptureCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var capture = new LocalVariableSymbol(captureName, isReadOnly: true, type: underlying);
            scope = new BoundScope(scope);
            scope.TryDeclareVariable(capture);

            var captureRef = new BoundVariableExpression(null, capture);
            var whenNotNull = BindIndexedWriteThroughChain(
                chainBase: captureRef,
                remainingChain: rightSyntax,
                indexSyntax,
                valueSyntax,
                boundValueOverride,
                compoundOperatorToken,
                compoundRhsSyntax,
                diagnosticLocation,
                outerSyntax);

            scope = scope.Parent;

            if (whenNotNull is BoundErrorExpression)
            {
                return whenNotNull;
            }

            var resultType = whenNotNull.Type is NullableTypeSymbol
                ? whenNotNull.Type
                : (TypeSymbol)NullableTypeSymbol.Get(whenNotNull.Type);

            LocalVariableSymbol resultSlot = null;
            if (resultType is NullableTypeSymbol nullableResult
                && nullableResult.UnderlyingType?.ClrType is { IsValueType: true })
            {
                var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
                resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
            }

            return new BoundNullConditionalAccessExpression(null, boundLeft, capture, whenNotNull, resultType, resultSlot);
        }

        BoundExpression boundReceiver = chainBase == null
            ? BindExpression(remainingChain)
            : BindAccessorStep(chainBase, null, remainingChain);
        if (boundReceiver is BoundErrorExpression || boundReceiver.Type == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var tempName = $"<idxAsn{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, boundReceiver.Type);
        if (!scope.TryDeclareVariable(tempVar))
        {
            // Defensive: synthesized names cannot collide with user identifiers
            // (the `<...>` prefix is not a valid identifier token), so a failure
            // here means a duplicate synthesized name within the same scope,
            // which Interlocked.Increment guarantees against. Treat as fatal.
            throw new System.InvalidOperationException(
                $"Failed to declare synthesized index-assignment target local '{tempName}'.");
        }

        var declaration = new BoundVariableDeclaration(outerSyntax, tempVar, boundReceiver);

        BoundExpression assignment;
        if (compoundOperatorToken != null)
        {
            if (!SyntaxFacts.TryGetCompoundAssignmentBaseOperator(compoundOperatorToken.Kind, out var baseOpKind))
            {
                // Defensive: parser only emits this node for kinds recognised
                // by TryGetCompoundAssignmentBaseOperator above.
                return new BoundErrorExpression(null);
            }

            var tempRef = new BoundVariableExpression(null, tempVar);
            var indexRead = BindIndexAgainstTarget(tempRef, indexSyntax, diagnosticLocation);
            if (indexRead is BoundErrorExpression)
            {
                return indexRead;
            }

            var rhsBound = BindExpression(compoundRhsSyntax);
            if (rhsBound is BoundErrorExpression || rhsBound.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            // issue #1226 / #1246: the right operand of a compound element/indexer
            // assignment (`data[i] op= v`, including the synthetic `1` for
            // `++`/`--`) participates in the SAME constant-integer-literal
            // adaptation and implicit numeric widening as the equivalent binary
            // `data[i] op v`, via the shared adaptation helper.
            var combined = TryBindCompoundBinaryOperation(baseOpKind, indexRead, rhsBound, compoundRhsSyntax.Location);
            if (combined == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(
                    compoundOperatorToken.Location,
                    compoundOperatorToken.Text,
                    indexRead.Type,
                    rhsBound.Type);
                return new BoundErrorExpression(null);
            }

            assignment = BindIndexedAssignmentToVariableWithBoundValue(tempVar, indexSyntax, combined, diagnosticLocation);
        }
        else if (boundValueOverride != null)
        {
            assignment = BindIndexedAssignmentToVariableWithBoundValue(tempVar, indexSyntax, boundValueOverride, diagnosticLocation);
        }
        else
        {
            assignment = BindIndexedAssignmentToVariable(tempVar, indexSyntax, valueSyntax, diagnosticLocation);
        }

        if (assignment is BoundErrorExpression)
        {
            return assignment;
        }

        return new BoundBlockExpression(outerSyntax, ImmutableArray.Create<BoundStatement>(declaration), assignment);
    }

    private bool TrySplitAtLeftmostNullConditional(
        ExpressionSyntax chain,
        out ExpressionSyntax left,
        out ExpressionSyntax right)
    {
        // ParseNameOrCallExpression makes accessor chains RIGHT-recursive: in
        // `a.b?.c.d`, the outer accessor is `.` with LeftPart `a` and RightPart
        // `AccessorExpression(b, ?., AccessorExpression(c, ., d))`. To find the
        // leftmost `?.` we walk the RIGHT spine: if the current node is itself
        // `?.`, it is the split point; otherwise recurse into RightPart and
        // rebuild the LEFT side by re-attaching the prefix with the inner
        // `?.` replaced by its own LeftPart.
        if (chain is AccessorExpressionSyntax acc)
        {
            if (acc.IsNullConditional)
            {
                left = acc.LeftPart;
                right = acc.RightPart;
                return true;
            }

            if (TrySplitAtLeftmostNullConditional(acc.RightPart, out var innerLeft, out var innerRight))
            {
                left = new AccessorExpressionSyntax(acc.SyntaxTree, acc.LeftPart, acc.DotToken, innerLeft);
                right = innerRight;
                return true;
            }
        }

        left = null;
        right = null;
        return false;
    }

    private BoundExpression BindIndexedAssignmentToVariable(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        TextLocation diagnosticLocation)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax, boundValueOverride: null, diagnosticLocation);
    }

    private BoundExpression BindIndexedAssignmentToVariableWithBoundValue(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        BoundExpression boundValue,
        TextLocation diagnosticLocation)
    {
        return BindIndexedAssignmentToVariableCore(
            variable, indexSyntax, valueSyntax: null, boundValueOverride: boundValue, diagnosticLocation);
    }

    private BoundExpression BindIndexedAssignmentToVariableCore(
        VariableSymbol variable,
        ExpressionSyntax indexSyntax,
        ExpressionSyntax valueSyntax,
        BoundExpression boundValueOverride,
        TextLocation diagnosticLocation)
    {
        BoundExpression BindValue(TypeSymbol elementType)
        {
            if (boundValueOverride != null)
            {
                return conversions.BindConversion(diagnosticLocation, boundValueOverride, elementType);
            }

            return conversions.BindConversion(valueSyntax, elementType);
        }

        var element = GetIndexElementType(variable.Type);
        if (element != null)
        {
            var index = BindArrayElementIndex(indexSyntax);
            var value = BindValue(element);
            return new BoundIndexAssignmentExpression(null, variable, index, value, element);
        }

        // ADR-0122 / issue #1014: pointer indexed write `p[i] = v` == `*(p + i) = v`.
        if (variable.Type is PointerTypeSymbol pointerType)
        {
            // ADR-0122 §3 / issue #1033: a `*void` pointer has no element type,
            // so an indexed write `p[i] = v` is rejected (GS0403); cast to a
            // typed pointer `*T` first.
            if (TypeSymbol.IsVoidPointer(variable.Type))
            {
                Diagnostics.ReportVoidPointerOperationNotAllowed(diagnosticLocation, "index");
                return new BoundErrorExpression(null);
            }

            var pointerIndex = BindExpression(indexSyntax);
            if (pointerIndex is BoundErrorExpression)
            {
                return pointerIndex;
            }

            if (!IsPointerOffsetType(pointerIndex.Type))
            {
                pointerIndex = conversions.BindConversion(indexSyntax, TypeSymbol.NInt);
            }

            var elementPointer = LowerPointerOffset(new BoundVariableExpression(null, variable), pointerType, pointerIndex, subtract: false);
            var pointerValue = BindValue(pointerType.PointeeType);
            return new BoundIndirectAssignmentExpression(null, elementPointer, pointerValue);
        }

        // Phase 3.A.4: map indexed assignment `m[k] = v` — key bound to K,
        // value bound to V.
        if (variable.Type is MapTypeSymbol mapType)
        {
            var keyExpr = conversions.BindConversion(indexSyntax, mapType.KeyType);
            var valExpr = BindValue(mapType.ValueType);
            return new BoundIndexAssignmentExpression(null, variable, keyExpr, valExpr, mapType.ValueType);
        }

        // Phase 4 exit: CLR indexer write on an imported reference type
        // (e.g. `d["k"] = 1` on Dictionary[string, int]).
        // Issue #209: honour inner-position nullable flags when present.
        if (variable.Type is NullabilityAnnotatedTypeSymbol annotWr && variable.Type.ClrType is System.Type clrAnnotWr)
        {
            var idxArgsAnnotWr = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrAnnotWr, idxArgsAnnotWr, out var idxPropAnnotWr))
            {
                if (!idxPropAnnotWr.CanWrite)
                {
                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                    return new BoundErrorExpression(null);
                }

                var valueTypeAnnotWr = annotWr.GetTypeArgumentSymbolForClrType(idxPropAnnotWr.PropertyType);
                var boundValueAnnotWr = BindValue(valueTypeAnnotWr);
                return new BoundClrIndexAssignmentExpression(null, variable, idxPropAnnotWr, idxArgsAnnotWr, boundValueAnnotWr, valueTypeAnnotWr);
            }
        }
        else if (variable.Type is ImportedTypeSymbol && variable.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrTarget, idxArgs, out var idxProp))
            {
                // ADR-0056 §2: span element write. `Span[T]` has no `set_Item`; its
                // indexer is a `ref T`-returning getter and writes go through that
                // managed pointer. Detect the ref-returning getter and store through
                // it. A `ReadOnlySpan[T]` getter is `ref readonly T` — writing is a
                // hard error (GS0226).
                if (!idxProp.CanWrite)
                {
                    var refGetter = idxProp.GetGetMethod(nonPublic: false);
                    if (refGetter != null && refGetter.ReturnType.IsByRef)
                    {
                        if (IsReadOnlyRefReturn(idxProp, refGetter))
                        {
                            Diagnostics.ReportCannotAssignReadOnlySpanElement(diagnosticLocation, variable.Type);
                            return new BoundErrorExpression(null);
                        }

                        var pointeeType = TypeSymbol.FromClrType(refGetter.ReturnType.GetElementType()!);
                        var refValue = BindValue(pointeeType);
                        return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, refValue, pointeeType);
                    }

                    Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                    return new BoundErrorExpression(null);
                }

                // Issue #968: recover the symbolic element type the same way
                // the READ path does (MapErasedIndexerElementType). On a
                // `List[T]` whose element `T` is the enclosing type's generic
                // parameter, `idxProp.PropertyType` is the type-erased CLR
                // `object` (T -> object). Typing the write value as `object`
                // here would reject the assignment `_items[i] = value` (where
                // `value: T`) with GS0155 ("Cannot convert type 'T' to
                // 'object'"). Substituting the open `set_Item` value parameter
                // back through the receiver's symbolic type arguments yields the
                // real element type (`T`), so the `T` value binds without a
                // spurious boxing conversion — the WRITE-path counterpart to the
                // READ-path element-type recovery (issues #313 / #671 / #957).
                var valueType = MapErasedIndexerElementType((ImportedTypeSymbol)variable.Type, idxProp);
                var boundValue = BindValue(valueType);
                return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, boundValue, valueType);
            }
        }

        // ADR-0118 / issue #944: index assignment on a user-defined type that
        // declares an indexer member. Binds `obj[i] = v` to a call of the
        // indexer setter (`obj.set_Item(i, v)`).
        if (variable.Type is StructSymbol userIndexTarget
            && TryGetUserIndexer(userIndexTarget, out var writeIndexer, out var writeSubstitution)
            && writeIndexer.Parameters.Length == 1)
        {
            if (writeIndexer.SetterSymbol == null)
            {
                Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
                return new BoundErrorExpression(null);
            }

            var paramType = writeSubstitution != null
                ? Binder.SubstituteType(writeIndexer.Parameters[0].Type, writeSubstitution)
                : writeIndexer.Parameters[0].Type;
            var elementType = writeSubstitution != null
                ? Binder.SubstituteType(writeIndexer.Type, writeSubstitution)
                : writeIndexer.Type;

            var indexArg = conversions.BindConversion(indexSyntax, paramType);
            var value = BindValue(elementType);
            return new BoundUserInstanceCallExpression(
                null,
                new BoundVariableExpression(null, variable),
                writeIndexer.SetterSymbol,
                ImmutableArray.Create(indexArg, value));
        }

        if (variable.Type != TypeSymbol.Error)
        {
            Diagnostics.ReportTypeNotIndexable(diagnosticLocation, variable.Type);
        }

        return new BoundErrorExpression(null);
    }

    private static TypeSymbol MapErasedIndexerElementType(ImportedTypeSymbol target, PropertyInfo closedIndexer)
    {
        // Issue #313 (HasTypeParameterArgument): substitute the open indexer's
        // generic-parameter result back through the target's symbolic type
        // arguments so `list[i]` on `List[T]` is typed as `T`.
        // Issue #671: also substitute when the target is a constructed
        // generic with G# user-defined or nested-symbolic type arguments
        // (e.g. `outer[0]` on `List[List[MyGs]]` -> `List[MyGs]`); without
        // this the element would type-erase to `List<object>` and downstream
        // member access on the result would emit against the wrong parent.
        var hasSubstitutableArgs = !target.TypeArguments.IsDefaultOrEmpty
            && (target.HasTypeParameterArgument
                || target.TypeArguments.Any(static a => a.ClrType == null
                    || (a is ImportedTypeSymbol nested
                        && nested.OpenDefinition != null
                        && !nested.TypeArguments.IsDefaultOrEmpty)));
        if (hasSubstitutableArgs
            && target.OpenDefinition is System.Type openDefinition)
        {
            try
            {
                var openIndexer = ClrTypeUtilities.SafeGetProperty(
                    openDefinition,
                    closedIndexer.Name,
                    BindingFlags.Public | BindingFlags.Instance);
                if (openIndexer?.PropertyType is System.Type openElement)
                {
                    // ADR-0056 §1/§2: a ref-returning indexer (e.g. `Span[T]`)
                    // surfaces its element as `T&`; map it through a
                    // `ByRefTypeSymbol` so §1 auto-dereference applies.
                    var openCore = openElement.IsByRef ? openElement.GetElementType()! : openElement;
                    if (openCore.IsGenericParameter)
                    {
                        var position = openCore.GenericParameterPosition;
                        if (position >= 0 && position < target.TypeArguments.Length)
                        {
                            var arg = target.TypeArguments[position];
                            return openElement.IsByRef ? ByRefTypeSymbol.Get(arg) : arg;
                        }
                    }
                }
            }
            catch (System.Reflection.AmbiguousMatchException)
            {
                // Fall back to the erased element type below.
            }
        }

        // ADR-0056 §2: a closed ref-returning indexer (e.g. `ReadOnlySpan[int32]`
        // / `Span[int32]`) reports its element as `int32&`. Surface it as a
        // `ByRefTypeSymbol` over the pointee so the read auto-dereferences (§1)
        // and the emitter loads through the managed pointer.
        var propertyType = closedIndexer.PropertyType;
        if (propertyType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(propertyType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(propertyType);
    }

    // Issue #1301: resolve the element type of a closed indexer against the
    // receiver's symbolic type arguments, mirroring the normal `this[int]`
    // index path. Routing the from-end (`a[^n]`) / `System.Index` indexer
    // paths through here keeps a user-defined element type `T` (whose
    // `ClrType` is null during binding) typed as `T` instead of erasing to
    // `object`.
    private static TypeSymbol ResolveIndexerElementType(TypeSymbol targetType, PropertyInfo indexer)
    {
        if (targetType is NullabilityAnnotatedTypeSymbol annot && annot.ClrType is System.Type)
        {
            return annot.GetTypeArgumentSymbolForClrType(indexer.PropertyType);
        }

        if (targetType is ImportedTypeSymbol imported)
        {
            return MapErasedIndexerElementType(imported, indexer);
        }

        var propertyType = indexer.PropertyType;
        if (propertyType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(propertyType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(propertyType);
    }

    private static TypeSymbol MapClrMemberType(System.Type clrType)
    {
        if (clrType != null && clrType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(clrType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(clrType);
    }

    /// <summary>
    /// Issue #1354: maps an imported method's return type to a
    /// <see cref="TypeSymbol"/>, applying the reference-type nullability rule
    /// (oblivious/unannotated → <c>T?</c>, explicit <c>[Nullable(1)]</c> →
    /// non-null) via <see cref="ClrNullability.GetReturnTypeSymbol"/>. This is
    /// the call-return-type counterpart of <see cref="MapClrMemberType"/>:
    /// without it, the non-generic instance-method fallback chain would land on
    /// a bare <see cref="TypeSymbol.FromClrType"/> and treat oblivious imported
    /// reference returns as non-null. The existing by-ref-return handling
    /// (e.g. <c>ref T</c> returns) is preserved.
    /// </summary>
    /// <param name="method">The imported method whose return type to map.</param>
    /// <returns>The nullability-aware return type symbol.</returns>
    private static TypeSymbol MapClrMethodReturnType(System.Reflection.MethodInfo method)
    {
        if (method == null)
        {
            return TypeSymbol.FromClrType(null);
        }

        var returnClrType = method.ReturnType;
        if (returnClrType != null && returnClrType.IsByRef)
        {
            // Preserve by-ref-return handling exactly as MapClrMemberType does.
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(returnClrType.GetElementType()!));
        }

        return ClrNullability.GetReturnTypeSymbol(method);
    }

    // ADR-0118 / issue #944: locate a user-declared indexer member on a (possibly
    // constructed-generic) user type and, for a constructed type, build the
    // type-parameter substitution from the receiver's type arguments. The
    // returned PropertySymbol is the OPEN indexer on the type definition so its
    // get_Item/set_Item accessors resolve to the emitted MethodDef handles.
    private static bool TryGetUserIndexer(
        StructSymbol target,
        out PropertySymbol indexer,
        out Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        indexer = null;
        substitution = null;

        var definition = target.Definition ?? target;
        for (var c = definition; c != null; c = c.BaseClass)
        {
            foreach (var p in c.Properties)
            {
                if (p.IsIndexer)
                {
                    indexer = p;
                    break;
                }
            }

            if (indexer != null)
            {
                break;
            }
        }

        if (indexer == null)
        {
            return false;
        }

        // Build the type-parameter substitution for a constructed generic
        // receiver (e.g. `Repo[int32]` over `class Repo[T]`).
        if (!target.TypeArguments.IsDefaultOrEmpty
            && target.Definition != null
            && !ReferenceEquals(target.Definition, target))
        {
            var defTps = target.Definition.TypeParameters;
            if (!defTps.IsDefaultOrEmpty && defTps.Length == target.TypeArguments.Length)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>(defTps.Length);
                for (var i = 0; i < defTps.Length; i++)
                {
                    substitution[defTps[i]] = target.TypeArguments[i];
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1330: recover the symbolic type of a static member read on a
    /// generic type constructed over an in-scope generic type parameter (e.g.
    /// <c>Comparer[TResult].Default</c>). The receiver's closed CLR shape is
    /// type-erased (<c>Comparer&lt;object&gt;</c>), so reflection reports the
    /// member's open type closed over <c>object</c>. Walk the open member on the
    /// receiver's <see cref="ImportedTypeSymbol.OpenDefinition"/> and project its
    /// type using the receiver's symbolic <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// Returns <see langword="null"/> when no substitution applies.
    /// </summary>
    private static TypeSymbol ResolveStaticMemberTypeFromSymbolicReceiver(ImportedTypeSymbol symbolicReceiver, MemberInfo closedMember)
    {
        if (symbolicReceiver?.OpenDefinition == null
            || symbolicReceiver.TypeArguments.IsDefaultOrEmpty
            || closedMember == null)
        {
            return null;
        }

        try
        {
            const BindingFlags staticFlags = BindingFlags.Public | BindingFlags.Static;
            Type openMemberType = closedMember switch
            {
                PropertyInfo => ClrTypeUtilities.SafeGetProperty(symbolicReceiver.OpenDefinition, closedMember.Name, staticFlags)?.PropertyType,
                FieldInfo => symbolicReceiver.OpenDefinition.GetField(closedMember.Name, staticFlags)?.FieldType,
                _ => null,
            };
            if (openMemberType == null)
            {
                return null;
            }

            var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openMemberType, symbolicReceiver.OpenDefinition, symbolicReceiver.TypeArguments);
            return TypeSymbol.ContainsTypeParameter(mapped)
                || TypeSymbol.IsSameCompilationUserTypeTopLevel(mapped)
                || openMemberType.IsGenericParameter
                || openMemberType.IsGenericType
                ? mapped
                : null;
        }
        catch (System.Reflection.AmbiguousMatchException)
        {
            return null;
        }
    }

    /// <summary>
    /// Issue #794: substitute the receiver's symbolic type arguments back
    /// through a CLR property's open declaring type. The closed `clrReceiverType`
    /// is the type-erased shape (#313 / #671), so reflection's
    /// <see cref="PropertyInfo.PropertyType"/> reports the property's open type
    /// closed over `object` — e.g. `Dictionary[K, V].Keys` surfaces as
    /// `ICollection&lt;object&gt;`. Walk the open property on the receiver's
    /// <see cref="ImportedTypeSymbol.OpenDefinition"/> and project its property
    /// type using the receiver's <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// Returns <see langword="null"/> when no substitution applies.
    /// </summary>
    private static TypeSymbol ResolveInstancePropertyTypeFromReceiver(TypeSymbol receiverType, PropertyInfo closedProperty)
    {
        if (receiverType is not ImportedTypeSymbol imp
            || imp.OpenDefinition == null
            || imp.TypeArguments.IsDefaultOrEmpty
            || closedProperty == null)
        {
            return null;
        }

        try
        {
            // Match by name + indexer arity to find the open counterpart.
            // Properties on closed generic instances carry stable
            // metadata-name overlap with their open declaration; an exact
            // name lookup on the open type with the same instance-binding
            // flags is sufficient for the single-name, non-indexer
            // properties that surface real receiver-type generics.
            var openType = closedProperty.DeclaringType != imp.ClrType && closedProperty.DeclaringType?.IsGenericType == true
                ? imp.OpenDefinition.GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == closedProperty.DeclaringType.GetGenericTypeDefinition())
                    ?? imp.OpenDefinition
                : imp.OpenDefinition;
            var openProperty = ClrTypeUtilities.SafeGetProperty(
                openType,
                closedProperty.Name,
                BindingFlags.Public | BindingFlags.Instance);
            if (openProperty == null || openProperty.GetIndexParameters().Length != 0)
            {
                return null;
            }

            var openPropType = openProperty.PropertyType;
            if (openPropType == null)
            {
                return null;
            }

            var mapped = MemberLookup.MapOpenClrTypeToSymbolic(openPropType, imp.OpenDefinition, imp.TypeArguments);

            // Issue #794 surfaced this projection for in-scope type parameters
            // (e.g. `Dictionary[K, V].Keys` -> `ICollection[K]`). Issue #1304
            // extends it to same-compilation user-defined type arguments: a
            // member whose open type is a generic parameter — e.g.
            // `IEnumerator[Ch].Current` -> `Ch` — must keep the user element
            // `Ch` instead of erasing to `object`. A user-defined `Ch` has a
            // null `ClrType` during binding, so the closed reflection property
            // reports the erased `object`; surface the symbolic projection.
            //
            // Issue #1418 generalizes the #1304/#1328/#1344 progression: surface
            // the symbolic projection whenever it carries a same-compilation
            // user type ANYWHERE — whether the member is the user type itself
            // (`IEnumerator[Ch].Current` -> `Ch`, #1304), a constructed generic
            // that is an enumerable collection (`Dictionary[K, V].Values` ->
            // `ValueCollection[K, V]`, #1328), a channel reader/writer
            // (`Channel[Entry].Reader` -> `ChannelReader[Entry]`, #1344), or any
            // OTHER constructed CLR generic over a user element
            // (`TaskCompletionSource[Entry].Task` -> `Task[Entry]`,
            // `Lazy[Entry]`, `IReadOnlyList[Entry]`, …). In every case the
            // mapped type keeps the type-erased closed `ClrType` (e.g.
            // `Task<object>`) for member/extension lookup — which resolves
            // against the erased shape exactly as before (proven by #1088) —
            // while its symbolic `[Entry]` argument keeps the element type from
            // collapsing to `object` for downstream projections (`await`,
            // `await for`, `.Result`, the `for … in` surface, LINQ terminals).
            //
            // The earlier #1305 worry — that surfacing a constructed generic
            // over a user element would regress method lookup — does not
            // materialize precisely because lookup reads `ClrType`, not the
            // symbolic arguments; #1328 and #1344 already proved this for the
            // collection and channel shapes, and `ContainsSameCompilationUserType`
            // simply removes the type-specific allow-list.
            //
            // When the OPEN property type is itself a bare generic parameter
            // (e.g. `KeyValuePair[K, V].Key` -> `K`, `.Value` -> `V`), the
            // receiver's closed `ClrType` may have erased *every* type argument
            // to `object` because a SIBLING argument is a same-compilation user
            // type (a constructed generic over a user element erases the whole
            // closed shape — so `KeyValuePair[uint32, E]` closes to
            // `KeyValuePair<object, object>`, erasing the concrete `uint32`
            // too). The symbolic projection is then authoritative, so prefer it
            // via the `openPropType.IsGenericParameter` arm even when the mapped
            // result no longer mentions the user type.
            return TypeSymbol.ContainsTypeParameter(mapped)
                || TypeSymbol.ContainsSameCompilationUserType(mapped)
                || openPropType.IsGenericParameter
                ? mapped
                : null;
        }
        catch (System.Reflection.AmbiguousMatchException)
        {
            return null;
        }
    }

    private static bool IsReadOnlyRefReturn(PropertyInfo indexer, MethodInfo getter)
    {
        static bool HasInModifier(System.Type[] modifiers)
        {
            foreach (var m in modifiers)
            {
                if (m.Name == "InAttribute")
                {
                    return true;
                }
            }

            return false;
        }

        if (HasInModifier(indexer.GetRequiredCustomModifiers()))
        {
            return true;
        }

        return HasInModifier(getter.ReturnParameter.GetRequiredCustomModifiers());
    }

    // Issue #1016: bind a range/slice expression `target[lo..hi]` (and the
    // open-ended forms). The bound representation reuses existing nodes wrapped
    // in a BoundBlockExpression so emit and the interpreter both work without a
    // new bound-node kind. Sliceable shapes mirror C#:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> new T[len] + Array.Copy.
    //   - `string` -> Substring(start, len).
    //   - span-like types with `int Length`/`int Count` + `Slice(int, int)`.
    //   - types with a `this[System.Range]` indexer -> call it directly.
    // Issue #1022: bind a single from-end index `target[^n]` to the element at
    // `length - n`. The bound representation reuses existing nodes wrapped in a
    // BoundBlockExpression (no new bound-node kind). Indexable shapes mirror C#:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> `src[len(src) - n]`.
    //   - types with a `this[System.Index]` indexer -> call it with `^n`.
    //   - types with `int Length`/`int Count` + a `this[int]` indexer (string,
    //     List<T>, span-like) -> `src[Length - n]`.
    private BoundExpression BindFromEndIndex(BoundExpression target, FromEndIndexExpressionSyntax fromEnd, TextLocation targetLocation)
    {
        if (target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == null)
        {
            _ = BindExpression(fromEnd.Operand);
            return new BoundErrorExpression(null);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);
            var idx = MakeFromEndOffset(fromEnd, new BoundLenExpression(null, new BoundVariableExpression(null, srcLocal)));
            var read = new BoundIndexExpression(null, new BoundVariableExpression(null, srcLocal), idx, element);
            return new BoundBlockExpression(fromEnd, statements.ToImmutable(), read);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindIndexIndexer(clrType, out var indexIndexer))
            {
                var indexCtor = typeof(System.Index).GetConstructor(new[] { typeof(int), typeof(bool) });
                var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
                var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
                var indexValue = new BoundClrConstructorCallExpression(
                    null,
                    typeof(System.Index),
                    indexCtor,
                    ImmutableArray.Create<BoundExpression>(offset, new BoundLiteralExpression(null, true)),
                    indexSym);
                var resultType = ResolveIndexerElementType(target.Type, indexIndexer);
                return new BoundClrIndexExpression(fromEnd, target, indexIndexer, ImmutableArray.Create<BoundExpression>(indexValue), resultType);
            }

            if (TryFindCountedIntIndexer(clrType, out var lengthMember, out var intIndexer))
            {
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);
                var lengthExpr = new BoundClrPropertyAccessExpression(null, new BoundVariableExpression(null, srcLocal), lengthMember, TypeSymbol.Int32);
                var idx = MakeFromEndOffset(fromEnd, lengthExpr);
                var resultType = ResolveIndexerElementType(target.Type, intIndexer);
                var read = new BoundClrIndexExpression(
                    null,
                    new BoundVariableExpression(null, srcLocal),
                    intIndexer,
                    ImmutableArray.Create<BoundExpression>(idx),
                    resultType);
                return new BoundBlockExpression(fromEnd, statements.ToImmutable(), read);
            }
        }

        Diagnostics.ReportTypeNotIndexable(targetLocation, target.Type);
        return new BoundErrorExpression(null);
    }

    // `length - n` for a from-end index `^n`.
    private BoundExpression MakeFromEndOffset(FromEndIndexExpressionSyntax fromEnd, BoundExpression lengthExpr)
    {
        var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
        var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
        return new BoundBinaryExpression(null, lengthExpr, subtractOp, offset);
    }

    private BoundExpression BindRangeSlice(BoundExpression target, RangeExpressionSyntax range, TextLocation targetLocation)
    {
        if (target is BoundErrorExpression || target.Type == TypeSymbol.Error || target.Type == null)
        {
            if (range.LowerBound != null)
            {
                _ = BindExpression(range.LowerBound);
            }

            if (range.UpperBound != null)
            {
                _ = BindExpression(range.UpperBound);
            }

            return new BoundErrorExpression(null);
        }

        var arrayElement = GetArraySliceElementType(target.Type);
        if (arrayElement != null)
        {
            return BindArraySlice(target, range, arrayElement);
        }

        if (target.Type == TypeSymbol.String)
        {
            return BindStringSlice(target, range);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindRangeIndexer(clrType, out var rangeIndexer))
            {
                return BindRangeIndexerSlice(target, range, rangeIndexer);
            }

            if (TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod))
            {
                return BindSpanLikeSlice(target, range, lengthMember, sliceMethod);
            }
        }

        Diagnostics.ReportTypeNotSliceable(range.Location, target.Type);
        return new BoundErrorExpression(null);
    }

    // Element type for the array/slice slicing path, or null if the target is
    // not an array/slice. Result of slicing is always a `[]T` slice.
    private static TypeSymbol GetArraySliceElementType(TypeSymbol type)
    {
        return type switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,
            ImportedTypeSymbol imp when imp.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => TypeSymbol.FromClrType(clr.GetElementType()),
            NullabilityAnnotatedTypeSymbol annot when annot.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => annot.GetTypeArgumentSymbolForClrType(clr.GetElementType()),
            _ => null,
        };
    }

    private LocalVariableSymbol DeclareRangeTemp(string role, TypeSymbol type, BoundExpression initializer, ImmutableArray<BoundStatement>.Builder statements)
    {
        var name = "$slice_" + role + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var local = new LocalVariableSymbol(name, isReadOnly: true, type: type);
        scope.TryDeclareVariable(local);
        statements.Add(new BoundVariableDeclaration(null, local, initializer));
        return local;
    }

    // Binds the lower/upper bounds (each optional, each possibly a from-end
    // `^n` marker — issue #1022) as int32 expressions and emits the `src`,
    // source-length, `start`, and `len` temporaries shared by the array,
    // string, and span-like slicing paths. A from-end bound `^n` lowers to
    // `srcLen - n`; an open lower bound is `0` and an open upper bound is
    // `srcLen`. `len = upper - start`.
    private (BoundExpression Src, BoundExpression Start, BoundExpression Len) BuildSliceBounds(
        BoundExpression target,
        RangeExpressionSyntax range,
        Func<BoundExpression, BoundExpression> lengthOf,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);

        BoundExpression SrcRef() => new BoundVariableExpression(null, srcLocal);

        // Compute the source length once; required for open upper bounds and for
        // any from-end (`^n`) bound, and harmless otherwise.
        var srcLenLocal = DeclareRangeTemp("srclen", TypeSymbol.Int32, lengthOf(SrcRef()), statements);

        BoundExpression SrcLenRef() => new BoundVariableExpression(null, srcLenLocal);

        var lowerBound = BindRangeBoundValue(range.LowerBound, SrcLenRef, new BoundLiteralExpression(null, 0));
        var startLocal = DeclareRangeTemp("start", TypeSymbol.Int32, lowerBound, statements);
        var startRef = new BoundVariableExpression(null, startLocal);

        var upperBound = BindRangeBoundValue(range.UpperBound, SrcLenRef, SrcLenRef());

        var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
        var lengthExpr = new BoundBinaryExpression(null, upperBound, subtractOp, startRef);
        var lenLocal = DeclareRangeTemp("len", TypeSymbol.Int32, lengthExpr, statements);

        return (
            new BoundVariableExpression(null, srcLocal),
            new BoundVariableExpression(null, startLocal),
            new BoundVariableExpression(null, lenLocal));
    }

    // Issue #1022: bind a single range bound to an int32 offset. A from-end
    // marker `^n` lowers to `srcLen - n`; a missing bound uses
    // <paramref name="defaultValue"/>; otherwise the bound is the plain value.
    private BoundExpression BindRangeBoundValue(ExpressionSyntax boundSyntax, Func<BoundExpression> srcLenRef, BoundExpression defaultValue)
    {
        if (boundSyntax == null)
        {
            return defaultValue;
        }

        if (boundSyntax is FromEndIndexExpressionSyntax fromEnd)
        {
            var offset = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
            var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
            return new BoundBinaryExpression(null, srcLenRef(), subtractOp, offset);
        }

        return conversions.BindConversion(boundSyntax, TypeSymbol.Int32);
    }

    private BoundExpression BindArraySlice(BoundExpression target, RangeExpressionSyntax range, TypeSymbol elementType)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var (srcRef, startRef, lenRef) = BuildSliceBounds(
            target,
            range,
            src => new BoundLenExpression(null, src),
            statements);

        var resultType = SliceTypeSymbol.Get(elementType);

        // dst = new T[len]
        var dstLocal = DeclareRangeTemp("dst", resultType, new BoundArrayCreationExpression(null, resultType, lenRef), statements);
        var dstRef = new BoundVariableExpression(null, dstLocal);

        // Array.Copy(src, start, dst, 0, len)
        var copyMethod = typeof(System.Array).GetMethod(
            "Copy",
            new[] { typeof(System.Array), typeof(int), typeof(System.Array), typeof(int), typeof(int) });
        var copyCall = new BoundClrStaticCallExpression(
            null,
            copyMethod,
            TypeSymbol.Void,
            ImmutableArray.Create<BoundExpression>(
                srcRef,
                startRef,
                dstRef,
                new BoundLiteralExpression(null, 0),
                lenRef));
        statements.Add(new BoundExpressionStatement(null, copyCall));

        return new BoundBlockExpression(range, statements.ToImmutable(), new BoundVariableExpression(null, dstLocal));
    }

    private BoundExpression BindStringSlice(BoundExpression target, RangeExpressionSyntax range)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var (srcRef, startRef, lenRef) = BuildSliceBounds(
            target,
            range,
            src => new BoundLenExpression(null, src),
            statements);

        var substring = typeof(string).GetMethod("Substring", new[] { typeof(int), typeof(int) });
        var call = new BoundImportedInstanceCallExpression(
            null,
            srcRef,
            substring,
            TypeSymbol.String,
            ImmutableArray.Create<BoundExpression>(startRef, lenRef));

        return new BoundBlockExpression(range, statements.ToImmutable(), call);
    }

    private BoundExpression BindSpanLikeSlice(BoundExpression target, RangeExpressionSyntax range, MemberInfo lengthMember, MethodInfo sliceMethod)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var (srcRef, startRef, lenRef) = BuildSliceBounds(
            target,
            range,
            src => new BoundClrPropertyAccessExpression(null, src, lengthMember, TypeSymbol.Int32),
            statements);

        var returnType = TypeSymbol.FromClrType(sliceMethod.ReturnType);
        var call = new BoundImportedInstanceCallExpression(
            null,
            srcRef,
            sliceMethod,
            returnType,
            ImmutableArray.Create<BoundExpression>(startRef, lenRef));

        return new BoundBlockExpression(range, statements.ToImmutable(), call);
    }

    private BoundExpression BindRangeIndexerSlice(BoundExpression target, RangeExpressionSyntax range, PropertyInfo indexer)
    {
        var rangeValue = BuildSystemRangeValue(range);
        var resultType = TypeSymbol.FromClrType(indexer.PropertyType);
        return new BoundClrIndexExpression(range, target, indexer, ImmutableArray.Create(rangeValue), resultType);
    }

    // Issue #1016/#1022/#1038: construct a `System.Range` value from a range
    // expression's bounds. Each bound becomes a `System.Index`: an open lower
    // defaults to the start (`Index(0, fromEnd: false)`), an open upper to the
    // end (`Index(0, fromEnd: true)`), a `^n` marker to `Index(n, fromEnd:
    // true)`, and a plain value `v` to `Index(v, fromEnd: false)`. Shared by the
    // `this[System.Range]` indexer-slice path (#1016) and the standalone range
    // value `let r = 1..3` (#1038).
    private BoundExpression BuildSystemRangeValue(RangeExpressionSyntax range)
    {
        var indexCtor = typeof(System.Index).GetConstructor(new[] { typeof(int), typeof(bool) });
        var rangeCtor = typeof(System.Range).GetConstructor(new[] { typeof(System.Index), typeof(System.Index) });
        var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
        var rangeSym = TypeSymbol.FromClrType(typeof(System.Range));

        BoundExpression MakeIndex(ExpressionSyntax boundSyntax, bool defaultFromEnd)
        {
            // Issue #1022: a `^n` bound becomes System.Index(n, fromEnd: true);
            // the System.Range value resolves the concrete offset at runtime.
            if (boundSyntax is FromEndIndexExpressionSyntax fromEnd)
            {
                var endValue = conversions.BindConversion(fromEnd.Operand, TypeSymbol.Int32);
                return new BoundClrConstructorCallExpression(
                    null,
                    typeof(System.Index),
                    indexCtor,
                    ImmutableArray.Create<BoundExpression>(endValue, new BoundLiteralExpression(null, true)),
                    indexSym);
            }

            var value = boundSyntax != null
                ? conversions.BindConversion(boundSyntax, TypeSymbol.Int32)
                : new BoundLiteralExpression(null, 0);
            return new BoundClrConstructorCallExpression(
                null,
                typeof(System.Index),
                indexCtor,
                ImmutableArray.Create<BoundExpression>(value, new BoundLiteralExpression(null, defaultFromEnd)),
                indexSym);
        }

        // Open lower defaults to the start (0, from-start); open upper defaults
        // to the end (^0, i.e. value 0 from-end).
        var startIndex = MakeIndex(range.LowerBound, defaultFromEnd: false);
        var endIndex = range.UpperBound != null
            ? MakeIndex(range.UpperBound, defaultFromEnd: false)
            : MakeIndex(null, defaultFromEnd: true);

        return new BoundClrConstructorCallExpression(
            null,
            typeof(System.Range),
            rangeCtor,
            ImmutableArray.Create<BoundExpression>(startIndex, endIndex),
            rangeSym);
    }

    // Issue #1038: bind a standalone range expression (`let r = 1..3`) to a
    // constructed `System.Range` value. A leading `^` at the very start is
    // genuinely ambiguous with the one's-complement unary operator, so the
    // parser reads `^a..` as `(~a)..`; reject that here (GS0410) so the from-end
    // intent isn't silently misread — use an indexer (`arr[^a..]`) or
    // parenthesise the complement (`(^a)..`).
    private BoundExpression BindStandaloneRange(RangeExpressionSyntax range)
    {
        if (range.LowerBound is UnaryExpressionSyntax leadingUnary
            && leadingUnary.OperatorToken.Kind == SyntaxKind.HatToken)
        {
            Diagnostics.ReportFromEndMarkerNotAllowedInStandaloneRange(leadingUnary.OperatorToken.Location);
            _ = BindExpression(leadingUnary.Operand);
            if (range.UpperBound != null)
            {
                _ = BindExpression(range.UpperBound is FromEndIndexExpressionSyntax fe ? fe.Operand : range.UpperBound);
            }

            return new BoundErrorExpression(range);
        }

        return BuildSystemRangeValue(range);
    }

    // Issue #1038: slice a target by a runtime `System.Range` value (`a[r]`,
    // where `r : System.Range`). Mirrors the syntactic `a[1..3]` shapes from
    // #1016 but reads the concrete `start`/`length` from the range value via
    // `System.Index.GetOffset(length)` rather than from syntactic bounds:
    //   - arrays / slices (`[N]T`, `[]T`, CLR `T[]`) -> new T[len] + Array.Copy.
    //   - `string` -> Substring(start, len).
    //   - span-like types (`int Length`/`Count` + `Slice(int, int)`).
    //   - a type exposing `this[System.Range]` -> call it with the value directly.
    private BoundExpression BindRangeValueSlice(BoundExpression target, BoundExpression rangeValue, TextLocation targetLocation)
    {
        var arrayElement = GetArraySliceElementType(target.Type);
        if (arrayElement != null)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                target,
                rangeValue,
                src => new BoundLenExpression(null, src),
                statements);

            var resultType = SliceTypeSymbol.Get(arrayElement);
            var dstLocal = DeclareRangeTemp("dst", resultType, new BoundArrayCreationExpression(null, resultType, lenRef), statements);
            var dstRef = new BoundVariableExpression(null, dstLocal);

            var copyMethod = typeof(System.Array).GetMethod(
                "Copy",
                new[] { typeof(System.Array), typeof(int), typeof(System.Array), typeof(int), typeof(int) });
            var copyCall = new BoundClrStaticCallExpression(
                null,
                copyMethod,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(srcRef, startRef, dstRef, new BoundLiteralExpression(null, 0), lenRef));
            statements.Add(new BoundExpressionStatement(null, copyCall));

            return new BoundBlockExpression(null, statements.ToImmutable(), new BoundVariableExpression(null, dstLocal));
        }

        if (target.Type == TypeSymbol.String)
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                target,
                rangeValue,
                src => new BoundLenExpression(null, src),
                statements);

            var substring = typeof(string).GetMethod("Substring", new[] { typeof(int), typeof(int) });
            var call = new BoundImportedInstanceCallExpression(
                null,
                srcRef,
                substring,
                TypeSymbol.String,
                ImmutableArray.Create<BoundExpression>(startRef, lenRef));
            return new BoundBlockExpression(null, statements.ToImmutable(), call);
        }

        var clrType = target.Type.ClrType;
        if (clrType != null)
        {
            if (TryFindRangeIndexer(clrType, out var rangeIndexer))
            {
                var resultType = TypeSymbol.FromClrType(rangeIndexer.PropertyType);
                return new BoundClrIndexExpression(null, target, rangeIndexer, ImmutableArray.Create(rangeValue), resultType);
            }

            if (TryFindSliceShape(clrType, out var lengthMember, out var sliceMethod))
            {
                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                var (srcRef, startRef, lenRef) = BuildRangeValueBounds(
                    target,
                    rangeValue,
                    src => new BoundClrPropertyAccessExpression(null, src, lengthMember, TypeSymbol.Int32),
                    statements);

                var returnType = TypeSymbol.FromClrType(sliceMethod.ReturnType);
                var call = new BoundImportedInstanceCallExpression(
                    null,
                    srcRef,
                    sliceMethod,
                    returnType,
                    ImmutableArray.Create<BoundExpression>(startRef, lenRef));
                return new BoundBlockExpression(null, statements.ToImmutable(), call);
            }
        }

        Diagnostics.ReportTypeNotSliceable(targetLocation, target.Type);
        return new BoundErrorExpression(null);
    }

    // Issue #1038: emit the `src`/`start`/`len` temporaries for slicing by a
    // runtime `System.Range` value. The source length is computed once; the
    // range's `Start`/`End` indices are resolved to concrete offsets via
    // `System.Index.GetOffset(length)`, and `len = end - start`.
    private (BoundExpression Src, BoundExpression Start, BoundExpression Len) BuildRangeValueBounds(
        BoundExpression target,
        BoundExpression rangeValue,
        Func<BoundExpression, BoundExpression> lengthOf,
        ImmutableArray<BoundStatement>.Builder statements)
    {
        var indexSym = TypeSymbol.FromClrType(typeof(System.Index));
        var startProp = typeof(System.Range).GetProperty("Start");
        var endProp = typeof(System.Range).GetProperty("End");
        var getOffset = typeof(System.Index).GetMethod("GetOffset", new[] { typeof(int) });

        var srcLocal = DeclareRangeTemp("src", target.Type, target, statements);

        BoundExpression SrcRef() => new BoundVariableExpression(null, srcLocal);

        var srcLenLocal = DeclareRangeTemp("srclen", TypeSymbol.Int32, lengthOf(SrcRef()), statements);

        BoundExpression SrcLenRef() => new BoundVariableExpression(null, srcLenLocal);

        var rngLocal = DeclareRangeTemp("rng", rangeValue.Type, rangeValue, statements);

        BoundExpression RngRef() => new BoundVariableExpression(null, rngLocal);

        // Resolve Start/End (System.Index) into addressable locals so the
        // struct-receiver GetOffset call has an address to load.
        var startIdxLocal = DeclareRangeTemp(
            "startidx",
            indexSym,
            new BoundClrPropertyAccessExpression(null, RngRef(), startProp, indexSym),
            statements);
        var endIdxLocal = DeclareRangeTemp(
            "endidx",
            indexSym,
            new BoundClrPropertyAccessExpression(null, RngRef(), endProp, indexSym),
            statements);

        var startExpr = new BoundImportedInstanceCallExpression(
            null,
            new BoundVariableExpression(null, startIdxLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create<BoundExpression>(SrcLenRef()));
        var startLocal = DeclareRangeTemp("start", TypeSymbol.Int32, startExpr, statements);

        var endExpr = new BoundImportedInstanceCallExpression(
            null,
            new BoundVariableExpression(null, endIdxLocal),
            getOffset,
            TypeSymbol.Int32,
            ImmutableArray.Create<BoundExpression>(SrcLenRef()));
        var endLocal = DeclareRangeTemp("end", TypeSymbol.Int32, endExpr, statements);

        var subtractOp = BoundBinaryOperator.Bind(SyntaxKind.MinusToken, TypeSymbol.Int32, TypeSymbol.Int32);
        var lengthExpr = new BoundBinaryExpression(
            null,
            new BoundVariableExpression(null, endLocal),
            subtractOp,
            new BoundVariableExpression(null, startLocal));
        var lenLocal = DeclareRangeTemp("len", TypeSymbol.Int32, lengthExpr, statements);

        return (
            new BoundVariableExpression(null, srcLocal),
            new BoundVariableExpression(null, startLocal),
            new BoundVariableExpression(null, lenLocal));
    }

    // Issue #1038: a `System.Range`-typed value used as an index argument
    // (`a[r]`) slices the target. Uses ClrTypeUtilities.IsSameAs per the issue
    // #835 guard against reference-identity typeof comparisons.
    private static bool IsSystemRangeType(TypeSymbol type)
    {
        return type?.ClrType != null && type.ClrType.IsSameAs(typeof(System.Range));
    }

    private static bool TryFindRangeIndexer(Type clrType, out PropertyInfo indexer)
    {
        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(System.Range)))
            {
                indexer = property;
                return true;
            }
        }

        indexer = null;
        return false;
    }

    // Issue #1022: a type that exposes a `this[System.Index]` indexer can serve
    // a from-end index directly (the indexer resolves `^n` at runtime).
    private static bool TryFindIndexIndexer(Type clrType, out PropertyInfo indexer)
    {
        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(System.Index)))
            {
                indexer = property;
                return true;
            }
        }

        indexer = null;
        return false;
    }

    // Issue #1022: a type with an `int Length`/`int Count` property and a
    // `this[int]` indexer (string, List<T>, span-like) can serve a from-end
    // index as `this[Length - n]`.
    private static bool TryFindCountedIntIndexer(Type clrType, out MemberInfo lengthMember, out PropertyInfo intIndexer)
    {
        lengthMember = null;
        intIndexer = null;

        var lengthProp = clrType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance);
        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            lengthProp = clrType.GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
        }

        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            return false;
        }

        foreach (var property in clrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var indexParams = property.GetIndexParameters();
            if (indexParams.Length == 1 && indexParams[0].ParameterType.IsSameAs(typeof(int)))
            {
                lengthMember = lengthProp;
                intIndexer = property;
                return true;
            }
        }

        return false;
    }

    private static bool TryFindSliceShape(Type clrType, out MemberInfo lengthMember, out MethodInfo sliceMethod)
    {
        lengthMember = null;
        sliceMethod = null;

        var lengthProp = clrType.GetProperty("Length", BindingFlags.Public | BindingFlags.Instance);
        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            lengthProp = clrType.GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
        }

        if (lengthProp == null || !lengthProp.PropertyType.IsSameAs(typeof(int)))
        {
            return false;
        }

        var slice = clrType.GetMethod("Slice", BindingFlags.Public | BindingFlags.Instance, binder: null, new[] { typeof(int), typeof(int) }, modifiers: null);
        if (slice == null)
        {
            return false;
        }

        lengthMember = lengthProp;
        sliceMethod = slice;
        return true;
    }

    // Issue #1279: array/slice element access accepts any integer-typed index
    // (matching C#). Integer types that implicitly widen to int32
    // (int8/uint8/int16/uint16/char/int32) convert to int32; the wider integer
    // types (uint32/int64/uint64/nint/nuint) convert to native int (nint),
    // which CIL ldelem/stelem/ldelema accept as the index operand. Non-integer
    // indices fall through to the int32 conversion, which reports GS0156.
    private static bool IsWideIntegerIndexType(TypeSymbol type) =>
        type == TypeSymbol.UInt32 || type == TypeSymbol.Int64 || type == TypeSymbol.UInt64
        || type == TypeSymbol.NInt || type == TypeSymbol.NUInt;

    private BoundExpression ConvertArrayElementIndex(TextLocation location, BoundExpression boundIndex)
    {
        if (IsWideIntegerIndexType(boundIndex.Type))
        {
            return conversions.BindConversion(location, boundIndex, TypeSymbol.NInt, allowExplicit: true);
        }

        return conversions.BindConversion(location, boundIndex, TypeSymbol.Int32);
    }

    // Issue #1279: `string` char-indexing (`s[i]`) lowers to the CLR
    // `get_Chars(int32)` accessor, so any integer index converts to int32 (an
    // explicit narrowing for the wider integer types). Non-integer indices
    // report GS0156 via the implicit int32 conversion.
    private BoundExpression ConvertStringCharIndex(TextLocation location, BoundExpression boundIndex)
    {
        return conversions.BindConversion(
            location, boundIndex, TypeSymbol.Int32, allowExplicit: IsWideIntegerIndexType(boundIndex.Type));
    }

    // Issue #1279: bind an array/slice element index from syntax. A
    // default/interpolated index carries no natural type, so it keeps the
    // historical target-typed int32 conversion; every other index is bound and
    // then converted via the integer-aware element-index rule above.
    private BoundExpression BindArrayElementIndex(ExpressionSyntax indexSyntax)
    {
        if (indexSyntax is DefaultExpressionSyntax || indexSyntax is InterpolatedStringExpressionSyntax)
        {
            return conversions.BindConversion(indexSyntax, TypeSymbol.Int32);
        }

        var boundIndex = BindExpression(indexSyntax);
        if (boundIndex is BoundErrorExpression)
        {
            return boundIndex;
        }

        return ConvertArrayElementIndex(indexSyntax.Location, boundIndex);
    }

    private static TypeSymbol GetIndexElementType(TypeSymbol type)
    {
        return type switch
        {
            ArrayTypeSymbol arr => arr.ElementType,
            SliceTypeSymbol slice => slice.ElementType,

            // Issue #664: CLR T[] arrays (e.g. result of string.Split) are indexable.
            ImportedTypeSymbol imp when imp.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => TypeSymbol.FromClrType(clr.GetElementType()),
            NullabilityAnnotatedTypeSymbol annot when annot.ClrType is { IsArray: true } clr && clr.GetArrayRank() == 1
                => annot.GetTypeArgumentSymbolForClrType(clr.GetElementType()),
            _ => null,
        };
    }

    /// <summary>
    /// Issue #662: detect the pattern <c>valueTask.GetAwaiter().GetResult()</c> and
    /// emit warning GS0275. The pattern is unsafe due to ValueTask's single-await
    /// semantics. The safe form is <c>valueTask.AsTask().GetAwaiter().GetResult()</c>.
    /// </summary>
    private void CheckValueTaskGetAwaiterGetResult(BoundExpression boundCall, CallExpressionSyntax callSyntax)
    {
        // The outermost call must be GetResult() with 0 args on a CLR instance.
        if (boundCall is not BoundImportedInstanceCallExpression getResultCall)
        {
            return;
        }

        if (getResultCall.Method.Name != "GetResult" || getResultCall.Arguments.Length != 0)
        {
            return;
        }

        // Its receiver must be a CLR instance call to GetAwaiter() with 0 args.
        if (getResultCall.Receiver is not BoundImportedInstanceCallExpression getAwaiterCall)
        {
            return;
        }

        if (getAwaiterCall.Method.Name != "GetAwaiter" || getAwaiterCall.Arguments.Length != 0)
        {
            return;
        }

        // The receiver of GetAwaiter() must have a ValueTask or ValueTask<T> type.
        var awaiterReceiverType = getAwaiterCall.Receiver?.Type?.ClrType;
        if (awaiterReceiverType == null)
        {
            return;
        }

        string fullName;
        if (awaiterReceiverType.IsGenericType && !awaiterReceiverType.IsGenericTypeDefinition)
        {
            fullName = awaiterReceiverType.GetGenericTypeDefinition()?.FullName;
        }
        else
        {
            fullName = awaiterReceiverType.FullName;
        }

        if (fullName == "System.Threading.Tasks.ValueTask" || fullName == "System.Threading.Tasks.ValueTask`1")
        {
            Diagnostics.ReportValueTaskDirectGetResult(callSyntax.Identifier.Location);
        }
    }

    /// <summary>
    /// Issue #1235: resolves an instance field/property read named on a
    /// receiver whose static type is a <see cref="TypeParameterSymbol"/>,
    /// against the type parameter's class constraint (including inherited
    /// members) or interface constraint. Instance method <em>calls</em> are
    /// handled separately in <c>ExpressionBinder.Calls</c>; this surfaces the
    /// remaining member kinds (fields and properties) so a constrained type
    /// parameter exposes its constraint's full instance member surface.
    /// Returns <see langword="null"/> when no such member exists (so the caller
    /// reports GS0158).
    /// </summary>
    /// <param name="tpRecv">The type-parameter receiver's type.</param>
    /// <param name="receiver">The bound receiver expression.</param>
    /// <param name="ne">The member-name syntax.</param>
    /// <returns>The bound member access, or <see langword="null"/>.</returns>
    private BoundExpression BindTypeParameterInstanceMemberAccess(
        TypeParameterSymbol tpRecv,
        BoundExpression receiver,
        NameExpressionSyntax ne)
    {
        var memberName = ne.IdentifierToken.Text;

        // Class constraint (issue #1056 surfaced methods; this adds the rest):
        // fields and properties, walking the base chain of the constraint class.
        if (tpRecv.ClassConstraint is StructSymbol classConstraint)
        {
            if (TypeMemberModel.TryGetFieldIncludingInherited(classConstraint, memberName, MemberQuery.Instance(MemberKinds.Field), out var field, out var fieldDeclaringType))
            {
                reportObsoleteUseIfApplicable(ne.IdentifierToken.Location, field, $"{fieldDeclaringType.Name}.{field.Name}");

                if (!AccessibilityChecker.IsAccessible(field.Accessibility, fieldDeclaringType, this.function))
                {
                    Diagnostics.ReportProtectedMemberInaccessible(ne.IdentifierToken.Location, field.Name, fieldDeclaringType.Name);
                }

                return ApplyMemberNarrowing(new BoundFieldAccessExpression(null, receiver, fieldDeclaringType, field));
            }

            if (TypeMemberModel.TryGetProperty(classConstraint, memberName, out var prop, out var propDeclaringType))
            {
                if (!prop.HasGetter)
                {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }

                if (!AccessibilityChecker.IsAccessible(prop.Accessibility, propDeclaringType, this.function))
                {
                    Diagnostics.ReportProtectedMemberInaccessible(ne.IdentifierToken.Location, prop.Name, propDeclaringType.Name);
                }

                return ApplyMemberNarrowing(new BoundPropertyAccessExpression(null, receiver, propDeclaringType, prop));
            }
        }

        // Interface constraint: an instance property declared on the (non-generic)
        // interface or any base interface. The getter dispatches through a
        // verifiable `box !!T; callvirt I::get_X` in the emitter.
        if (tpRecv.InterfaceConstraint is InterfaceSymbol interfaceConstraint
            && !interfaceConstraint.IsGenericDefinition
            && interfaceConstraint.TypeArguments.IsDefaultOrEmpty)
        {
            if (TypeMemberModel.TryGetProperty(interfaceConstraint, memberName, out var ifaceProp, out _))
            {
                if (!ifaceProp.HasGetter)
                {
                    Diagnostics.ReportCannotAssign(ne.Location, memberName);
                    return new BoundErrorExpression(null);
                }

                return new BoundPropertyAccessExpression(null, receiver, null, ifaceProp);
            }
        }

        return null;
    }

    /// <summary>
    /// ADR-0089 / issue #755: resolves <c>T.Method(args)</c> against the
    /// static-virtual interface members of <paramref name="tpSym"/>'s
    /// constraint. Produces a <see cref="BoundConstrainedStaticCallExpression"/>
    /// at the call site; reports GS0333 when the named member is not a
    /// static-virtual on any constraint interface.
    /// </summary>
    private BoundExpression BindTypeParameterStaticAccessorStep(
        TypeParameterSymbol tpSym,
        NameExpressionSyntax leftName,
        ExpressionSyntax rightPart)
    {
        if (tpSym.InterfaceConstraint == null)
        {
            Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                leftName.Location, tpSym.Name, rightPart is CallExpressionSyntax ce0 ? ce0.Identifier.Text : (rightPart is NameExpressionSyntax ne0 ? ne0.IdentifierToken.Text : "?"));
            return new BoundErrorExpression(null);
        }

        switch (rightPart)
        {
            case CallExpressionSyntax callSyntax:
                {
                    var methodName = callSyntax.Identifier.Text;
                    FunctionSymbol slot = null;
                    foreach (var candidate in TypeMemberModel.GetMethods(tpSym.InterfaceConstraint, methodName, MemberQuery.Static(MemberKinds.Method)))
                    {
                        if (candidate.Parameters.Length == callSyntax.Arguments.Count)
                        {
                            slot = candidate;
                            break;
                        }
                    }

                    if (slot == null)
                    {
                        Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                            leftName.Location, tpSym.Name, methodName);
                        return new BoundErrorExpression(null);
                    }

                    var boundArgs = ImmutableArray.CreateBuilder<BoundExpression>(callSyntax.Arguments.Count);
                    for (var i = 0; i < callSyntax.Arguments.Count; i++)
                    {
                        boundArgs.Add(BindExpression(callSyntax.Arguments[i]));
                    }

                    // Substitute the slot's return type T → caller's T
                    // (which is also the receiver tpSym). The slot was
                    // bound on the open interface definition so its return
                    // type might still mention the interface's own type
                    // parameter symbol — translate it through the
                    // constructed interface's TypeArguments.
                    var returnType = SubstituteThroughConstructedInterface(slot.Type, tpSym.InterfaceConstraint);

                    return new BoundConstrainedStaticCallExpression(
                        callSyntax,
                        tpSym,
                        slot,
                        boundArgs.MoveToImmutable(),
                        returnType);
                }

            case NameExpressionSyntax ne:
                {
                    // ADR-0089 / issue #1019: a static-virtual interface
                    // *property* read `T.Prop` dispatches through the
                    // property's getter accessor (a static-virtual slot),
                    // emitted as `constrained. !!T  call I::get_Prop()`.
                    var propName = ne.IdentifierToken.Text;
                    PropertySymbol slotProp = null;
                    InterfaceSymbol slotIface = null;
                    foreach (var iface in tpSym.InterfaceConstraint.SelfAndAllBaseInterfaces())
                    {
                        // Issue #1268: a constructed generic interface
                        // constraint (e.g. `T : IData[int32]` or the
                        // self-referential `T : IData[T]`) does not surface
                        // its declared static-virtual *properties* on the
                        // constructed instance — only methods are
                        // substituted onto it. Walk the open definition's
                        // property table so the slot is found regardless of
                        // whether the constraint is open or constructed; the
                        // getter resolved here is the open definition's
                        // static-virtual accessor (keyed in the emitter's
                        // MethodHandles), and the constructed interface is
                        // retained for type-argument substitution / emit.
                        var defIface = iface.Definition ?? iface;
                        defIface.EnsureMembersResolved();
                        foreach (var candidate in defIface.Properties)
                        {
                            if (candidate.IsStatic && candidate.Name == propName)
                            {
                                slotProp = candidate;
                                slotIface = iface;
                                break;
                            }
                        }

                        if (slotProp != null)
                        {
                            break;
                        }
                    }

                    if (slotProp == null || slotProp.GetterSymbol == null)
                    {
                        Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                            leftName.Location, tpSym.Name, propName);
                        return new BoundErrorExpression(null);
                    }

                    var propType = SubstituteThroughConstructedInterface(slotProp.Type, slotIface);

                    return new BoundConstrainedStaticCallExpression(
                        ne,
                        tpSym,
                        slotProp.GetterSymbol,
                        ImmutableArray<BoundExpression>.Empty,
                        propType);
                }

            default:
                return new BoundErrorExpression(null);
        }
    }

    /// <summary>
    /// ADR-0089: substitute a type that may mention the constructed
    /// interface's open type parameter with the corresponding type
    /// argument from <paramref name="constructedIface"/>. Conservative —
    /// only rewrites a top-level <see cref="TypeParameterSymbol"/>
    /// reference; leaves nested/generic shapes alone (the slot's
    /// signature is typically just <c>T</c> for the common math
    /// pattern).
    /// </summary>
    private static TypeSymbol SubstituteThroughConstructedInterface(TypeSymbol type, InterfaceSymbol constructedIface)
    {
        if (type is TypeParameterSymbol tp
            && constructedIface?.Definition?.TypeParameters != null
            && !constructedIface.Definition.TypeParameters.IsDefaultOrEmpty
            && !constructedIface.TypeArguments.IsDefaultOrEmpty)
        {
            for (var i = 0; i < constructedIface.Definition.TypeParameters.Length; i++)
            {
                if (ReferenceEquals(constructedIface.Definition.TypeParameters[i], tp))
                {
                    return constructedIface.TypeArguments[i];
                }
            }
        }

        return type;
    }

    /// <summary>
    /// ADR-0122 §10 / issue #1035: builds the <c>*T</c> value a fixed-size
    /// buffer field decays to — the address of the inline backing struct
    /// (whose first element sits at offset 0) reinterpreted to the element
    /// pointer type. Reuses the existing address-of + pointer-reinterpret
    /// machinery, so no new bound-node kind is required.
    /// </summary>
    /// <param name="receiver">The receiver expression the buffer field is read from.</param>
    /// <param name="declaringType">The type that declares the buffer field.</param>
    /// <param name="field">The fixed-size buffer field.</param>
    /// <returns>A <c>*T</c>-typed bound expression to the first element.</returns>
    private static BoundExpression MakeFixedBufferPointer(BoundExpression receiver, StructSymbol declaringType, FieldSymbol field)
    {
        var fieldAccess = new BoundFieldAccessExpression(null, receiver, declaringType, field);
        var addressOf = new BoundAddressOfExpression(null, fieldAccess, unmanaged: true);
        var elementPointer = PointerTypeSymbol.Get(field.FixedBufferElementType);
        return new BoundConversionExpression(null, elementPointer, addressOf);
    }
}
