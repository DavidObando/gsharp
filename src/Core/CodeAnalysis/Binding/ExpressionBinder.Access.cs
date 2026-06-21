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

    private BoundExpression BindAccessorExpression(AccessorExpressionSyntax syntax)
    {
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

        if (leftPart is NameExpressionSyntax leftName)
        {
            var name = leftName.IdentifierToken.Text;
            var variableHit = scope.TryLookupSymbol(name) as VariableSymbol;

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
                        $"{implicitStaticField.StructType.Name}.{implicitStaticField.Field.Name}");

                    receiver = new BoundFieldAccessExpression(
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

        return BindAccessorStep(receiver, classSymbol, rightPart);
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
                var head = BindUserTypeStaticAccessorStep(structSym, nested.LeftPart);
                if (head is BoundErrorExpression)
                {
                    return head;
                }

                return BindAccessorStep(head, null, nested.RightPart);

            case CallExpressionSyntax ce:
                return BindUserTypeStaticCall(structSym, ce);

            case NameExpressionSyntax ne:
                return BindUserTypeStaticMemberAccess(structSym, ne);

            default:
                return new BoundErrorExpression(null);
        }
    }

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

    private BoundExpression BindUserTypeStaticCall(StructSymbol structSym, CallExpressionSyntax ce)
    {
        var methodName = ce.Identifier.Text;

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var argument in ce.Arguments)
        {
            if (argument is RefArgumentExpressionSyntax refArg)
            {
                boundArguments.Add(BindRefArgumentExpression(refArg, parameter: null));
            }
            else
            {
                boundArguments.Add(BindExpression(argument));
            }
        }

        var arguments = boundArguments.ToImmutable();

        if (structSym.TryGetStaticMethod(methodName, out var method))
        {
            // ADR-0101 follow-up / issue #812: a user-declared static method
            // may declare a trailing variadic parameter. Allow flexible
            // arity, infer the element type from trailing args (if generic),
            // and pack / pass-through trailing args into a single slice
            // argument before the per-position conversion loop.
            var isVariadic = method.Parameters.Length > 0 && method.Parameters[method.Parameters.Length - 1].IsVariadic;
            var fixedParamCount = isVariadic ? method.Parameters.Length - 1 : method.Parameters.Length;

            if (isVariadic)
            {
                if (arguments.Length < fixedParamCount)
                {
                    Diagnostics.ReportTooFewArgumentsForVariadic(ce.Location, method.Name, fixedParamCount, arguments.Length);
                    return new BoundErrorExpression(null);
                }
            }
            else if (arguments.Length != method.Parameters.Length)
            {
                Diagnostics.ReportWrongArgumentCount(ce.Location, method.Name, method.Parameters.Length, arguments.Length);
                return new BoundErrorExpression(null);
            }

            // Issue #312 / ADR-0020: resolve a generic static method's own type
            // arguments from an explicit `[T1, T2]` list at the call site or by
            // left-to-right inference from argument types.
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution = null;
            if (method.IsGeneric)
            {
                substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
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
                permutedArgs = arguments;
            }

            var convertedArgs = ImmutableArray.CreateBuilder<BoundExpression>(permutedArgs.Length);
            for (var i = 0; i < permutedArgs.Length; i++)
            {
                var paramType = method.Parameters[i].Type;
                if (paramType is TypeParameterSymbol)
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

            if (substitution != null)
            {
                var substitutedReturn = Binder.SubstituteType(method.Type, substitution);
                if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
                {
                    substitutedReturn = lambdas.WrapAsTask(substitutedReturn);
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn);
                }

                if (!ReferenceEquals(substitutedReturn, method.Type))
                {
                    return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), substitutedReturn);
                }
            }

            if (method.IsAsync && !isAsyncIteratorReturnType(method.Type))
            {
                var asyncReturn = lambdas.WrapAsTask(method.Type);
                return new BoundCallExpression(null, method, convertedArgs.ToImmutable(), asyncReturn);
            }

            return new BoundCallExpression(null, method, convertedArgs.ToImmutable());
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
                    return new BoundClrPropertyAccessExpression(null, null, staticMember, staticType);
                }
                else if (receiver != null && receiver.Type is StructSymbol structSym)
                {
                    // Walk base chain to find the field.
                    for (var c = structSym; c != null; c = c.BaseClass)
                    {
                        if (c.TryGetField(ne.IdentifierToken.Text, out var field))
                        {
                            // Issue #186 / #175: dotted field read fires
                            // GS0204 if the field carries `@Obsolete`.
                            reportObsoleteUseIfApplicable(ne.IdentifierToken.Location, field, $"{c.Name}.{field.Name}");
                            return new BoundFieldAccessExpression(null, receiver, c, field);
                        }
                    }

                    // ADR-0051: check properties before reporting "unable to find member".
                    if (TypeMemberModel.TryGetProperty(structSym, ne.IdentifierToken.Text, out var prop))
                    {
                        if (!prop.HasGetter)
                        {
                            Diagnostics.ReportCannotAssign(ne.Location, ne.IdentifierToken.Text);
                            return new BoundErrorExpression(null);
                        }

                        return new BoundPropertyAccessExpression(null, receiver, structSym, prop);
                    }

                    // Issue #296: a GSharp class inheriting an imported CLR base
                    // exposes the base's instance properties/fields. Fall back to
                    // CLR member lookup on the imported base type.
                    if (structSym.ImportedBaseType?.ClrType is System.Type inheritedBaseClr)
                    {
                        var memberName = ne.IdentifierToken.Text;
                        var clrProp = ClrTypeUtilities.SafeGetProperty(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
                        if (clrProp != null && clrProp.GetIndexParameters().Length == 0 && clrProp.CanRead)
                        {
                            return new BoundClrPropertyAccessExpression(null, receiver, clrProp, TypeSymbol.FromClrType(clrProp.PropertyType));
                        }

                        var clrFld = ClrTypeUtilities.SafeGetField(inheritedBaseClr, memberName, BindingFlags.Public | BindingFlags.Instance);
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

        LocalVariableSymbol resultSlot = null;
        if (resultType is NullableTypeSymbol nullableResult
            && nullableResult.UnderlyingType?.ClrType is { IsValueType: true })
        {
            var resultSlotName = "$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
            resultSlot = new LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType);
        }

        return new BoundNullConditionalAccessExpression(null, receiver, capture, whenNotNull, resultType, resultSlot);
    }

    private BoundExpression BindIndexAgainstTarget(BoundExpression target, ExpressionSyntax indexSyntax, TextLocation targetLocation)
    {
        // Phase 3.A.4: map indexing `m[k]` — key bound to K, result type V.
        // The Go convention "zero value if missing" applies at evaluation;
        // the bound representation reuses BoundIndexExpression with the
        // element type set to V.
        if (target.Type is MapTypeSymbol mapType)
        {
            var key = conversions.BindConversion(indexSyntax, mapType.KeyType);
            return new BoundIndexExpression(null, target, key, mapType.ValueType);
        }

        var element = GetIndexElementType(target.Type);
        if (element != null)
        {
            var index = conversions.BindConversion(indexSyntax, TypeSymbol.Int32);
            return new BoundIndexExpression(null, target, index, element);
        }

        // Phase 4 exit: CLR indexer read on an imported reference type
        // (e.g. `d["k"]` on Dictionary[string, int]). Pick a public
        // instance indexer (a `PropertyInfo` whose `GetIndexParameters()`
        // matches the single argument by assignability).
        // Issue #209: when the target carries inner-position nullable flags,
        // use them to type the element correctly (e.g., `list[0]` on `List<string?>` → `string?`).
        if (target.Type is NullabilityAnnotatedTypeSymbol annotIdx && annotIdx.ClrType is System.Type clrAnnotIdx)
        {
            var idxArgsAnnot = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrAnnotIdx, idxArgsAnnot, out var idxPropAnnot))
            {
                var elemTypeAnnot = annotIdx.GetTypeArgumentSymbolForClrType(idxPropAnnot.PropertyType);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxPropAnnot, idxArgsAnnot, elemTypeAnnot));
            }
        }
        else if (target.Type is ImportedTypeSymbol && target.Type.ClrType is System.Type clrTarget)
        {
            var idxArgs = ImmutableArray.Create(BindExpression(indexSyntax));
            if (this.memberLookup.TryResolveClrIndexer(clrTarget, idxArgs, out var idxProp))
            {
                var elementType = MapErasedIndexerElementType((ImportedTypeSymbol)target.Type, idxProp);
                return ConversionClassifier.AutoDereferenceRefReturn(new BoundClrIndexExpression(null, target, idxProp, idxArgs, elementType));
            }
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

            var binaryOp = BoundBinaryOperator.Bind(baseOpKind, indexRead.Type, rhsBound.Type);
            if (binaryOp == null)
            {
                Diagnostics.ReportUndefinedBinaryOperator(
                    compoundOperatorToken.Location,
                    compoundOperatorToken.Text,
                    indexRead.Type,
                    rhsBound.Type);
                return new BoundErrorExpression(null);
            }

            var combined = new BoundBinaryExpression(null, indexRead, binaryOp, rhsBound);
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
            var index = conversions.BindConversion(indexSyntax, TypeSymbol.Int32);
            var value = BindValue(element);
            return new BoundIndexAssignmentExpression(null, variable, index, value, element);
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

                var valueType = TypeSymbol.FromClrType(idxProp.PropertyType);
                var boundValue = BindValue(valueType);
                return new BoundClrIndexAssignmentExpression(null, variable, idxProp, idxArgs, boundValue, valueType);
            }
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

    private static TypeSymbol MapClrMemberType(System.Type clrType)
    {
        if (clrType != null && clrType.IsByRef)
        {
            return ByRefTypeSymbol.Get(TypeSymbol.FromClrType(clrType.GetElementType()!));
        }

        return TypeSymbol.FromClrType(clrType);
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
            return TypeSymbol.ContainsTypeParameter(mapped) ? mapped : null;
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
                    foreach (var candidate in tpSym.InterfaceConstraint.StaticMethods)
                    {
                        if (candidate.Name == methodName
                            && candidate.Parameters.Length == callSyntax.Arguments.Count)
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
                // ADR-0089: static-virtual properties / constants are
                // deferred (v1 is static func only). Surface GS0333 so the
                // user gets a clear diagnostic.
                Diagnostics.ReportStaticVirtualMemberNotFoundOnTypeParameter(
                    leftName.Location, tpSym.Name, ne.IdentifierToken.Text);
                return new BoundErrorExpression(null);

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
}
