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
            return lambdas.WrapAsTask(declared, function.AsyncReturnsValueTask);
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

        if (!TryResolveQualifiedClrType(namespacePrefix, typeSimpleName, terminalCall.TypeArgumentList, out var clrType, out var openGenericDef, out var symbolicArgs))
        {
            return false;
        }

        return TryBindClrConstructorFromType(clrType, terminalCall, out result, openGenericDef, symbolicArgs);
    }

    /// <summary>
    /// Issue #2258: binds a fully-qualified imported-type object-initializer
    /// literal written in expression position, e.g.
    /// <c>System.Text.Json.JsonWriterOptions{ Indented: true }</c>. Such an
    /// expression parses as an accessor chain whose terminal segment is the
    /// struct literal (<see cref="StructLiteralExpressionSyntax"/>), so it never
    /// reaches the simple-name literal path in <see cref="BindStructLiteralExpression(StructLiteralExpressionSyntax)"/>.
    /// This walks the dotted name the same way <see cref="TryBindQualifiedClrConstructorCall"/>
    /// does, resolves the closed CLR type via the active references/imports, and
    /// binds the literal against it — generalizing to any referenced CLR type
    /// (class or struct) at any namespace depth.
    /// </summary>
    /// <param name="syntax">The accessor expression to bind.</param>
    /// <param name="result">The bound struct-literal expression on success.</param>
    /// <returns>Whether the accessor was a fully-qualified struct literal that bound successfully.</returns>
    private bool TryBindQualifiedClrStructLiteral(AccessorExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;

        if (syntax.IsNullConditional)
        {
            return false;
        }

        // Flatten the accessor chain into the leading namespace/type segments
        // and the terminal struct literal. Anything that isn't a pure
        // dotted-name chain ending in a struct literal is not a qualified
        // literal.
        var segments = new List<string>();
        ExpressionSyntax current = syntax;
        StructLiteralExpressionSyntax terminalLiteral = null;
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

            if (current is StructLiteralExpressionSyntax literal)
            {
                terminalLiteral = literal;
                break;
            }

            // A bare trailing name/call is not a struct literal.
            return false;
        }

        if (terminalLiteral == null || terminalLiteral.TypeIdentifier.IsMissing)
        {
            return false;
        }

        var typeSimpleName = terminalLiteral.TypeIdentifier.Text;
        var namespacePrefix = string.Join(".", segments);

        if (!TryResolveQualifiedClrType(namespacePrefix, typeSimpleName, terminalLiteral.TypeArgumentList, out var clrType, out _, out _))
        {
            return false;
        }

        result = BindImportedTypeLiteralExpression(terminalLiteral, clrType);
        return true;
    }

    /// <summary>
    /// Binds a same-compilation SOURCE type constructed or referenced through a
    /// package-qualified name — e.g. <c>Oahu.Decrypt.Mp4Operation(...)</c> or the
    /// generic <c>Oahu.Decrypt.Mp4Operation[TResult](...)</c>. cs2gs
    /// fully-qualifies type references, but a G# source type has no CLR type at
    /// bind time, so <see cref="TryBindQualifiedClrConstructorCall"/> (which only
    /// resolves reference-set types) cannot see it. G# resolves source types by
    /// simple name from a flat, cross-package type scope, so a leading
    /// namespace/package prefix is redundant.
    /// <para>
    /// This fires only when every leading segment is a pure namespace/package
    /// component — none names an in-scope value, a known type, an import alias,
    /// or an imported class (which would make the chain a static-member access or
    /// nested-type reference handled elsewhere) — and the terminal is a call or
    /// struct-literal whose simple name resolves to a user aggregate type. In that
    /// case the redundant prefix is peeled off and the terminal is bound by simple
    /// name, matching how the same construction binds when written unqualified.
    /// </para>
    /// </summary>
    /// <param name="syntax">The accessor chain forming the qualified name.</param>
    /// <param name="result">The bound terminal construction on success.</param>
    /// <returns>Whether the qualified name bound to a source-type construction.</returns>
    private bool TryBindQualifiedSourceTypeConstruction(AccessorExpressionSyntax syntax, out BoundExpression result)
    {
        result = null;

        if (syntax.IsNullConditional)
        {
            return false;
        }

        // Peel the leading dotted-name segments while each is a bare identifier
        // that does NOT resolve to a value, a type, an import alias, or an
        // imported class — i.e. a pure namespace/package component. Stop at the
        // first segment that is anything else (a generic-name type reference, a
        // type name, or the terminal construction).
        ExpressionSyntax current = syntax;
        var peeledAny = false;
        while (current is AccessorExpressionSyntax accessor
               && !accessor.IsNullConditional
               && accessor.LeftPart is NameExpressionSyntax leftName
               && IsNamespacePrefixSegment(leftName.IdentifierToken.Text))
        {
            current = accessor.RightPart;
            peeledAny = true;
        }

        // Only fire when at least one namespace segment was peeled (so ordinary
        // static-member access and simple-name construction are untouched) and
        // the remainder's head names a same-compilation user aggregate source
        // type — a constructor call `Type(...)`, a struct literal `Type{...}`, or
        // a static-member access `Type.Member` / `Type[Args].Member`.
        if (!peeledAny || !RemainderHeadIsSourceType(current))
        {
            return false;
        }

        // Peel the redundant namespace prefix and bind the remainder by simple
        // name. Use BindExpressionpublic (not BindExpression) so a void terminal
        // (a `Ns.Type[Args].VoidMethod(...)` call in an expression-bodied void
        // member) is not prematurely rejected here — the caller's BindExpression
        // wrapper applies the correct void-in-value-position check on the
        // original syntax.
        result = BindExpressionpublic(current);
        return true;
    }

    /// <summary>
    /// Whether the head of <paramref name="remainder"/> (after peeling a
    /// namespace prefix) names a same-compilation user aggregate source type:
    /// a constructor call <c>Type(...)</c>, a struct literal <c>Type{...}</c>,
    /// or a static-member access rooted at a type name <c>Type.Member</c> /
    /// generic type reference <c>Type[Args].Member</c>.
    /// </summary>
    private bool RemainderHeadIsSourceType(ExpressionSyntax remainder)
    {
        string simpleName;
        int arity;
        switch (remainder)
        {
            case CallExpressionSyntax call when !call.Identifier.IsMissing:
                simpleName = call.Identifier.Text;
                arity = call.TypeArgumentList?.Arguments.Count ?? 0;
                break;
            case StructLiteralExpressionSyntax literal when !literal.TypeIdentifier.IsMissing:
                simpleName = literal.TypeIdentifier.Text;
                arity = literal.TypeArgumentList?.Arguments.Count ?? 0;
                break;
            case AccessorExpressionSyntax { LeftPart: GenericNameExpressionSyntax genericHead }:
                simpleName = genericHead.Identifier.Text;
                arity = genericHead.TypeArgumentList?.Arguments.Count ?? 0;
                break;
            case AccessorExpressionSyntax { LeftPart: NameExpressionSyntax nameHead }:
                simpleName = nameHead.IdentifierToken.Text;
                arity = 0;
                break;
            case AccessorExpressionSyntax { LeftPart: IndexExpressionSyntax { Target: NameExpressionSyntax indexNameHead } }:
                // `Type[Args].Member`: a generic type receiver parses as an index
                // expression (`Mp4Operation[int32]`), not a GenericName, when it
                // appears as the left part of a member access.
                simpleName = indexNameHead.IdentifierToken.Text;
                arity = 0;
                break;
            default:
                return false;
        }

        return scope.TryLookupTypeAlias(simpleName, arity > 0 ? arity : -1, out var terminalType)
            && IsUserAggregateType(terminalType);
    }

    /// <summary>
    /// Resolves a closed CLR type from a fully-qualified dotted name written in
    /// source. Tries the name as written, the name with the leading segment
    /// expanded from a matching import alias/path, and the name prefixed by each
    /// active import target. Generic type arguments on <paramref name="typeArgumentList"/>
    /// are honoured by resolving the mangled open generic and closing it.
    /// </summary>
    /// <param name="namespacePrefix">The dotted segments preceding the type name (may be empty).</param>
    /// <param name="typeSimpleName">The simple type name (the constructor call / struct literal identifier).</param>
    /// <param name="typeArgumentList">
    /// The terminal's explicit type-argument list (from a constructor call or a
    /// struct literal), used for generic arity/arguments; <see langword="null"/>
    /// for a non-generic reference.
    /// </param>
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
        TypeArgumentListSyntax typeArgumentList,
        out System.Type clrType,
        out System.Type openGenericDefinition,
        out ImmutableArray<TypeSymbol> symbolicTypeArgs)
    {
        clrType = null;
        openGenericDefinition = null;
        symbolicTypeArgs = default;

        var arity = typeArgumentList?.Arguments.Count ?? 0;

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
                        var ta = bindTypeClause(typeArgumentList.Arguments[i]);
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
        if (TryResolveAsNestedTypeChain(namespacePrefix, typeSimpleName, arity, typeArgumentList, out clrType))
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
    private bool TryResolveAsNestedTypeChain(string namespacePrefix, string typeSimpleName, int arity, TypeArgumentListSyntax typeArgumentList, out System.Type clrType)
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
                    var ta = bindTypeClause(typeArgumentList.Arguments[i]);
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
}
