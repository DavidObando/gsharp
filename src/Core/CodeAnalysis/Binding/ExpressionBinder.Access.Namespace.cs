// <copyright file="ExpressionBinder.Access.Namespace.cs" company="GSharp">
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
    /// Issue #1069: resolves a dotted accessor of the form
    /// <c>Outer.Nested</c> (optionally deeper, <c>A.B.C</c>) to the user-defined
    /// nested type it names, by walking the enclosing-type chain. Each segment
    /// after the first must name a user type whose enclosing type is the symbol
    /// resolved for the preceding segment. Returns <see langword="false"/> when
    /// the chain is not a pure user nested-type reference.
    /// </summary>
    private bool TryResolveQualifiedUserNestedType(AccessorExpressionSyntax accessor, out TypeSymbol nestedType)
    {
        nestedType = null;

        if (accessor.RightPart is not NameExpressionSyntax rightName)
        {
            return false;
        }

        TypeSymbol container;
        switch (accessor.LeftPart)
        {
            case NameExpressionSyntax leftName
                when scope.TryLookupTypeAlias(leftName.IdentifierToken.Text, out var leftType)
                    && IsUserAggregateType(leftType):
                container = leftType;
                break;
            case AccessorExpressionSyntax leftAccessor
                when TryResolveQualifiedUserNestedType(leftAccessor, out var leftNested):
                container = leftNested;
                break;
            default:
                return false;
        }

        if (!scope.TryLookupNestedTypeAlias(container, rightName.IdentifierToken.Text, preferredArity: -1, out var candidate))
        {
            return false;
        }

        nestedType = candidate;
        return true;
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
            var clr = NullableTypeSymbol.GetEffectiveClrType(typeArgs[i]);
            if (clr == null)
            {
                return false;
            }

            // Project the host CLR type argument onto the resolver's reference
            // set so it shares the open type's load context (its
            // MetadataLoadContext when references are supplied via /reference:),
            // which MakeGenericType requires (mirrors Binder.BindGenericClrType).
            clrArgs[i] = scope.References.MapClrTypeToReferences(clr);
        }

        try
        {
            var closed = openClrType.MakeGenericType(clrArgs);
            constructedImported = new ImportedClassSymbol(closed, receiverSyntax);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
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
}
