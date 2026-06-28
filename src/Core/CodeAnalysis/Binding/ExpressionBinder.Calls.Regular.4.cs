// <copyright file="ExpressionBinder.Calls.Regular.4.cs" company="GSharp">
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
    /// Issue #986: binds a base-class call of the form <c>base.M(args)</c>
    /// (when <paramref name="explicitBaseType"/> is <see langword="null"/>) or
    /// the bracketed <c>base[BaseClass].M(args)</c> form (when it names the
    /// base class). Resolves <c>M</c> on the nearest base class's member set
    /// (walking grandparents), reuses the standard overload resolution and
    /// argument-conversion pipeline via
    /// <see cref="OverloadResolver.BindUserInstanceCall"/>, then wraps the
    /// result in a <see cref="BoundBaseClassCallExpression"/> so the emitter
    /// produces a non-virtual <c>call</c> (not <c>callvirt</c>) — exactly like
    /// C# <c>base.M(...)</c>.
    /// </summary>
    /// <param name="ce">The method-call syntax (<c>M(args)</c>).</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain <c>base.M</c> form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385); ignored when <paramref name="explicitBaseType"/> is null.</param>
    /// <returns>The bound base-class call, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassCall(
        CallExpressionSyntax ce,
        TextLocation baseLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        var methodName = ce.Identifier.Text;

        // Resolve the overload set on the user base chain (this-first from the
        // search base), which walks grandparents — so the nearest user base
        // implementation of an inherited member is chosen.
        var baseOverloads = searchBase != null
            ? TypeMemberModel.GetMethods(searchBase, methodName, MemberQuery.Instance(MemberKinds.Method))
            : ImmutableArray<FunctionSymbol>.Empty;
        if (baseOverloads.IsEmpty)
        {
            // Issue #1260: no GSharp base declares the member (the class derives
            // directly from a BCL base, or the nearest user base does not declare
            // it). Fall back to the imported/BCL base type so `base.Dispose(...)`,
            // `base.ToString()`, etc. resolve and emit a non-virtual `call`.
            if (TryBindBaseClrInstanceCall(ce, methodName, clrBaseFallback, out var bclResult))
            {
                return bclResult;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(ce.Identifier.Location, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), methodName);
            return new BoundErrorExpression(null);
        }

        if (!overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames))
        {
            return new BoundErrorExpression(null);
        }

        var boundArguments = ImmutableArray.CreateBuilder<BoundExpression>(ce.Arguments.Count);
        foreach (var argument in ce.Arguments)
        {
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
        }

        var arguments = boundArguments.ToImmutable();
        var method = overloads.SelectInstanceOverloadOrReport(baseOverloads, arguments, ce, methodName, argumentNames);
        if (method == null)
        {
            return new BoundErrorExpression(null);
        }

        // Reuse the full instance-call binding pipeline (named-argument
        // reordering, generic substitution, variadic packing, per-argument
        // conversions). The receiver is the enclosing method's `this`.
        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        var bound = overloads.BindUserInstanceCall(receiver, method, arguments, ce, argumentNames);
        if (bound is not BoundUserInstanceCallExpression uic)
        {
            return bound;
        }

        var declaringType = uic.Method.ReceiverType as StructSymbol ?? searchBase;
        return new BoundBaseClassCallExpression(
            ce,
            uic.Receiver,
            declaringType,
            uic.Method,
            uic.Arguments,
            uic.Type);
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.M(args)</c> call into an imported/BCL base
    /// class. Resolves the overload set against <paramref name="clrBase"/>
    /// (which walks the CLR base chain), runs the shared imported-instance
    /// overload resolution, and produces a
    /// <see cref="BoundImportedInstanceCallExpression"/> flagged as a non-virtual
    /// base call so the emitter writes <c>call</c> (not <c>callvirt</c>) — exactly
    /// like C# <c>base.M(...)</c>. A base call to an <c>abstract</c> BCL member
    /// (no implementation to delegate to) is reported as GS0413.
    /// </summary>
    /// <param name="ce">The method-call syntax.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited member against.</param>
    /// <param name="result">The bound non-virtual base call (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when the call resolved (or a precise diagnostic was reported); <see langword="false"/> when no candidate member exists.</returns>
    private bool TryBindBaseClrInstanceCall(
        CallExpressionSyntax ce,
        string methodName,
        System.Type clrBase,
        out BoundExpression result)
    {
        result = null;

        var candidates = CollectBaseClrMethodCandidates(clrBase, methodName);
        if (candidates.Count == 0)
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
            boundArguments.Add(BindExpression(OverloadResolver.UnwrapNamedArgumentValue(argument)));
        }

        var arguments = boundArguments.ToImmutable();
        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        return TryResolveAndBindClrInstanceCall(
            receiver,
            candidates,
            clrBase,
            methodName,
            arguments,
            ce,
            out result,
            explicitTypeArgs: null,
            typeArgSymbols: default,
            argumentNames: argumentNames,
            nonVirtualBaseCall: true,
            baseMemberLocation: ce.Identifier.Location);
    }

    /// <summary>
    /// Issue #1260: collects the candidate inherited CLR instance methods named
    /// <paramref name="methodName"/> that are reachable for a <c>base.M(...)</c>
    /// call against <paramref name="clrBase"/>. Unlike the ordinary inherited-CLR
    /// lookup (public only), a base call may target a <c>protected</c> virtual
    /// member (e.g. <c>System.IO.Stream.Dispose(bool)</c>), so this includes
    /// non-public methods but excludes members a derived type cannot legally
    /// call via <c>base</c> (<c>private</c>, and other-assembly <c>internal</c>).
    /// </summary>
    /// <param name="clrBase">The CLR base type to search (its base chain is walked by reflection).</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <returns>The deduplicated candidate methods (most-derived signature wins).</returns>
    private static IReadOnlyList<MethodInfo> CollectBaseClrMethodCandidates(System.Type clrBase, string methodName)
    {
        var result = new List<MethodInfo>();
        if (clrBase == null)
        {
            return result;
        }

        foreach (var m in ClrTypeUtilities.SafeGetMethods(clrBase, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
        {
            if (!string.Equals(m.Name, methodName, System.StringComparison.Ordinal))
            {
                continue;
            }

            // Accessible to a derived type via `base`: public, protected
            // (Family), or protected-internal (FamilyOrAssembly). Exclude
            // private and (cross-assembly) internal members.
            if (!(m.IsPublic || m.IsFamily || m.IsFamilyOrAssembly))
            {
                continue;
            }

            if (!MemberLookup.HasSameSignature(result, m))
            {
                result.Add(m);
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #1104 / #1260: resolves the base class to start a
    /// <c>base.Member</c> search from, shared by the base-method-call path
    /// (<see cref="BindBaseClassCall"/>) and the base-property-access path
    /// (<see cref="BindBaseClassPropertyRead"/> /
    /// <see cref="BindBaseClassPropertyWrite"/>). Reports GS0383 when the call
    /// site is not an instance member of a class and GS0385 when a bracketed
    /// <c>base[Type]</c> selector does not name an actual base class.
    /// <para>
    /// Issue #1260: a class with no GSharp base class still inherits the members
    /// of its imported/BCL base (or <c>System.Object</c>), so when there is no
    /// user <see cref="StructSymbol"/> base this no longer reports GS0383.
    /// Instead it returns with <paramref name="searchBase"/> <see langword="null"/>
    /// and <paramref name="clrBaseFallback"/> set to the CLR base type to resolve
    /// inherited members against. <paramref name="clrBaseFallback"/> is always
    /// non-<see langword="null"/> on success (defaulting to <c>typeof(object)</c>)
    /// so a multi-level user → user → BCL chain can fall back when the nearest
    /// user base does not declare the member.
    /// </para>
    /// </summary>
    /// <param name="baseLocation">The location of the <c>base</c> token (for GS0383).</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385).</param>
    /// <param name="searchBase">The resolved GSharp base class to start the member search from, or <see langword="null"/> when the class derives only from an imported/BCL base.</param>
    /// <param name="clrBaseFallback">The CLR base type to resolve inherited BCL members against (issue #1260); always set on success.</param>
    /// <returns><see langword="true"/> when the access site is a valid class instance member.</returns>
    private bool TryResolveBaseSearchType(
        TextLocation baseLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation,
        out StructSymbol searchBase,
        out System.Type clrBaseFallback)
    {
        searchBase = null;
        clrBaseFallback = null;

        // The access site must live in an instance member of a class. Top-level
        // functions, `shared` statics, and structs (no base class) all fail.
        var enclosingType = function?.ReceiverType as StructSymbol;
        if (enclosingType == null || function?.ThisParameter == null || !enclosingType.IsClass)
        {
            Diagnostics.ReportBaseClassCallHasNoBaseClass(baseLocation, EnclosingTypeDisplayName());
            return false;
        }

        // Determine the base class to start the member search from. For the
        // bracketed form, the named selector must be an actual base class of
        // the enclosing type; for the plain form, use the immediate base.
        if (explicitBaseType != null)
        {
            if (!IsBaseClassOf(enclosingType, explicitBaseType))
            {
                Diagnostics.ReportBaseClassCallSelectorNotBaseClass(selectorLocation, enclosingType.Name, explicitBaseType.Name);
                return false;
            }

            searchBase = explicitBaseType;
        }
        else
        {
            searchBase = enclosingType.BaseClass;
        }

        // Issue #1260: the CLR base type used for inherited-BCL member lookup —
        // walk from the search base (or the enclosing type when there is no user
        // base) to the topmost user class and take its imported CLR base,
        // defaulting to System.Object so universally-inherited members
        // (ToString/Equals/GetHashCode/GetType) resolve.
        clrBaseFallback = ResolveClrBaseSearchType(searchBase ?? enclosingType);
        return true;
    }

    /// <summary>
    /// Issue #1260: returns the CLR base type whose inherited instance members a
    /// <c>base.Member</c> access resolves against. Walks the GSharp base-class
    /// chain from <paramref name="from"/> to the topmost user class and returns
    /// that class's imported/BCL base (<see cref="StructSymbol.ImportedBaseType"/>),
    /// defaulting to <c>typeof(object)</c> when no class in the chain declares an
    /// imported base.
    /// </summary>
    /// <param name="from">The GSharp class to start walking from.</param>
    /// <returns>The CLR base type for inherited-member lookup.</returns>
    private static System.Type ResolveClrBaseSearchType(StructSymbol from)
    {
        for (var t = from; t != null; t = t.BaseClass)
        {
            if (t.ImportedBaseType?.ClrType is System.Type clr)
            {
                return clr;
            }
        }

        return typeof(object);
    }

    /// <summary>
    /// Issue #1104: binds a base-class property READ of the form
    /// <c>base.Prop</c> (or the bracketed <c>base[BaseClass].Prop</c> form).
    /// Resolves <c>Prop</c> on the nearest base class's property set (walking
    /// grandparents) and wraps the property's getter accessor in a
    /// <see cref="BoundBaseClassCallExpression"/> so the emitter produces a
    /// non-virtual <c>call instance R BaseClass::get_Prop()</c> — exactly like
    /// C# <c>base.Prop</c>. This lets an override reference the inherited member
    /// it shadows without re-entering its own getter (infinite recursion).
    /// </summary>
    /// <param name="member">The member-name syntax (<c>Prop</c>).</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385).</param>
    /// <returns>The bound base-class property read, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassPropertyRead(
        NameExpressionSyntax member,
        TextLocation baseLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        var memberName = member.IdentifierToken.Text;
        if (searchBase == null || !TypeMemberModel.TryGetProperty(searchBase, memberName, out var prop, out var declaringType))
        {
            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop` reads the inherited member
            // non-virtually (e.g. a virtual/overridable BCL property).
            if (TryBindBaseClrPropertyRead(member, clrBaseFallback, out var bclRead))
            {
                return bclRead;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(member.IdentifierToken.Location, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), memberName);
            return new BoundErrorExpression(null);
        }

        if (!prop.HasGetter || prop.GetterSymbol == null)
        {
            Diagnostics.ReportCannotAssign(member.IdentifierToken.Location, memberName);
            return new BoundErrorExpression(null);
        }

        // Issue #950: enforce `protected` property access against the declaring type.
        if (!AccessibilityChecker.IsAccessible(prop.Accessibility, declaringType, this.function))
        {
            Diagnostics.ReportProtectedMemberInaccessible(member.IdentifierToken.Location, prop.Name, declaringType.Name);
        }

        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        return new BoundBaseClassCallExpression(
            member,
            receiver,
            declaringType,
            prop.GetterSymbol,
            ImmutableArray<BoundExpression>.Empty,
            prop.Type);
    }

    /// <summary>
    /// Issue #1104: binds a base-class property WRITE of the form
    /// <c>base.Prop = value</c>. Resolves <c>Prop</c> on the nearest base
    /// class's property set (walking grandparents) and wraps the property's
    /// setter accessor in a <see cref="BoundBaseClassCallExpression"/> so the
    /// emitter produces a non-virtual
    /// <c>call instance void BaseClass::set_Prop(value)</c>.
    /// </summary>
    /// <param name="memberName">The property name.</param>
    /// <param name="memberLocation">The location of the property name token.</param>
    /// <param name="baseLocation">The location of the <c>base</c> token for context diagnostics.</param>
    /// <param name="value">The already-bound right-hand value expression.</param>
    /// <param name="valueLocation">The location of the value expression (for conversion diagnostics).</param>
    /// <param name="equalsLocation">The location of the <c>=</c> token (for GS cannot-assign).</param>
    /// <param name="explicitBaseType">The class named in <c>base[BaseClass]</c>, or <see langword="null"/> for the plain <c>base.Prop</c> form.</param>
    /// <param name="selectorLocation">The location of the bracketed selector (for GS0385); use <paramref name="baseLocation"/> for the plain form.</param>
    /// <returns>The bound base-class property write, or a bound error on failure.</returns>
    private BoundExpression BindBaseClassPropertyWrite(
        string memberName,
        TextLocation memberLocation,
        TextLocation baseLocation,
        BoundExpression value,
        TextLocation valueLocation,
        TextLocation equalsLocation,
        StructSymbol explicitBaseType,
        TextLocation selectorLocation)
    {
        if (!TryResolveBaseSearchType(baseLocation, explicitBaseType, selectorLocation, out var searchBase, out var clrBaseFallback))
        {
            return new BoundErrorExpression(null);
        }

        if (searchBase == null || !TypeMemberModel.TryGetProperty(searchBase, memberName, out var prop, out var declaringType))
        {
            // Issue #1260: no GSharp base declares the property — fall back to the
            // imported/BCL base type so `base.Prop = value` writes the inherited
            // member non-virtually.
            if (TryBindBaseClrPropertyWrite(memberName, memberLocation, value, valueLocation, equalsLocation, clrBaseFallback, out var bclWrite))
            {
                return bclWrite;
            }

            Diagnostics.ReportBaseClassCallMemberNotFound(memberLocation, searchBase?.Name ?? ClrTypeDisplayName(clrBaseFallback), memberName);
            return new BoundErrorExpression(null);
        }

        if (!prop.HasSetter || prop.SetterSymbol == null)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            return new BoundErrorExpression(null);
        }

        // Issue #950: enforce `protected` property assignment against the declaring type.
        if (!AccessibilityChecker.IsAccessible(prop.Accessibility, declaringType, this.function))
        {
            Diagnostics.ReportProtectedMemberInaccessible(memberLocation, prop.Name, declaringType.Name);
        }

        var converted = conversions.BindConversion(valueLocation, value, prop.Type);
        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        return new BoundBaseClassCallExpression(
            value.Syntax,
            receiver,
            declaringType,
            prop.SetterSymbol,
            ImmutableArray.Create(converted));
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.Prop</c> READ into an imported/BCL base
    /// class. Resolves the inherited CLR property's getter and wraps it in a
    /// non-virtual <see cref="BoundImportedInstanceCallExpression"/> so the
    /// emitter produces <c>call instance R BaseClass::get_Prop()</c> — exactly
    /// like C# <c>base.Prop</c>. An <c>abstract</c> getter (no implementation)
    /// is reported as GS0413.
    /// </summary>
    /// <param name="member">The member-name syntax (<c>Prop</c>).</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited property against.</param>
    /// <param name="result">The bound non-virtual property read (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when a readable inherited property was found (or a precise diagnostic was reported).</returns>
    private bool TryBindBaseClrPropertyRead(
        NameExpressionSyntax member,
        System.Type clrBase,
        out BoundExpression result)
    {
        result = null;

        var memberName = member.IdentifierToken.Text;
        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBase, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (clrProp == null || clrProp.GetIndexParameters().Length != 0 || !clrProp.CanRead)
        {
            return false;
        }

        var getter = clrProp.GetGetMethod(nonPublic: false);
        if (getter == null)
        {
            return false;
        }

        if (getter.IsAbstract)
        {
            Diagnostics.ReportBaseClassCallAbstractMember(member.IdentifierToken.Location, clrProp.DeclaringType?.Name ?? clrBase.Name, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        result = new BoundImportedInstanceCallExpression(
            member,
            receiver,
            getter,
            TypeSymbol.FromClrType(clrProp.PropertyType),
            ImmutableArray<BoundExpression>.Empty,
            isNonVirtualBaseCall: true);
        return true;
    }

    /// <summary>
    /// Issue #1260: binds a <c>base.Prop = value</c> WRITE into an imported/BCL
    /// base class. Resolves the inherited CLR property's setter and wraps it in a
    /// non-virtual <see cref="BoundImportedInstanceCallExpression"/> so the
    /// emitter produces <c>call instance void BaseClass::set_Prop(value)</c>.
    /// An <c>abstract</c> setter (no implementation) is reported as GS0413.
    /// </summary>
    /// <param name="memberName">The property name.</param>
    /// <param name="memberLocation">The location of the property name token.</param>
    /// <param name="value">The already-bound right-hand value expression.</param>
    /// <param name="valueLocation">The location of the value expression (for conversion diagnostics).</param>
    /// <param name="equalsLocation">The location of the <c>=</c> token (for GS cannot-assign).</param>
    /// <param name="clrBase">The CLR base type to resolve the inherited property against.</param>
    /// <param name="result">The bound non-virtual property write (or an error node) when handled.</param>
    /// <returns><see langword="true"/> when a writable inherited property was found (or a precise diagnostic was reported).</returns>
    private bool TryBindBaseClrPropertyWrite(
        string memberName,
        TextLocation memberLocation,
        BoundExpression value,
        TextLocation valueLocation,
        TextLocation equalsLocation,
        System.Type clrBase,
        out BoundExpression result)
    {
        result = null;

        var clrProp = ClrTypeUtilities.SafeGetProperty(clrBase, memberName, BindingFlags.Public | BindingFlags.Instance);
        if (clrProp == null || clrProp.GetIndexParameters().Length != 0)
        {
            return false;
        }

        if (!clrProp.CanWrite)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var setter = clrProp.GetSetMethod(nonPublic: false);
        if (setter == null)
        {
            Diagnostics.ReportCannotAssign(equalsLocation, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        if (setter.IsAbstract)
        {
            Diagnostics.ReportBaseClassCallAbstractMember(memberLocation, clrProp.DeclaringType?.Name ?? clrBase.Name, memberName);
            result = new BoundErrorExpression(null);
            return true;
        }

        var converted = conversions.BindConversion(valueLocation, value, TypeSymbol.FromClrType(clrProp.PropertyType));
        var receiver = new BoundVariableExpression(null, function.ThisParameter);
        result = new BoundImportedInstanceCallExpression(
            value.Syntax,
            receiver,
            setter,
            TypeSymbol.Void,
            ImmutableArray.Create(converted),
            isNonVirtualBaseCall: true);
        return true;
    }

    /// <summary>
    /// Issue #986: returns true when <paramref name="candidate"/> is a base
    /// class of <paramref name="derived"/> (compared by definition identity to
    /// allow constructed generics).
    /// </summary>
    private static bool IsBaseClassOf(StructSymbol derived, StructSymbol candidate)
    {
        var candidateDef = candidate.Definition ?? candidate;
        for (var t = derived.BaseClass; t != null; t = t.BaseClass)
        {
            var tDef = t.Definition ?? t;
            if (ReferenceEquals(tDef, candidateDef) || ReferenceEquals(t, candidate))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #943: binds an instance call dispatched through a type parameter's
    /// imported CLR interface constraint (e.g. <c>a.CompareTo(b)</c> where
    /// <c>a : T</c> and <c>T : IComparable[T]</c>). The method is resolved
    /// against the constraint interface's (type-erased) CLR type; the resulting
    /// <see cref="BoundImportedInstanceCallExpression"/> carries the constrained
    /// type parameter and the symbolic interface type so the emitter produces a
    /// verifiable <c>constrained. !!T  callvirt</c> sequence with the
    /// <c>MemberRef</c> parented at the constructed interface
    /// (<c>IComparable`1&lt;!!T&gt;::CompareTo(!0)</c>).
    /// </summary>
    /// <param name="receiver">The bound receiver (its type is the constrained type parameter).</param>
    /// <param name="tp">The receiver's type parameter, carrying the CLR interface constraint.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The bound argument expressions.</param>
    /// <param name="ce">The originating call-expression syntax.</param>
    /// <param name="argumentNames">Optional named-argument labels in source order.</param>
    /// <param name="result">The bound constrained call on success.</param>
    /// <returns><see langword="true"/> when a matching interface method was found and bound.</returns>
    private bool TryBindConstrainedClrInterfaceCall(
        BoundExpression receiver,
        TypeParameterSymbol tp,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out BoundExpression result)
    {
        result = null;
        var constraintInterface = tp.ClrInterfaceConstraint;
        var clrType = constraintInterface?.ClrType;
        if (clrType is not { IsInterface: true })
        {
            return false;
        }

        var candidates = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(clrType, BindingFlags.Instance | BindingFlags.Public)
            .Where(m => m.Name == methodName)
            .ToList();
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new Type[arguments.Length];
        for (var i = 0; i < arguments.Length; i++)
        {
            var t = GetEffectiveArgumentClrTypeForOverloadResolution(arguments[i].Type);
            if (t == null && arguments[i].Type != TypeSymbol.Null)
            {
                return false;
            }

            argTypes[i] = t;
        }

        var resolution = OverloadResolution.Resolve(
            candidates,
            argTypes,
            null,
            scope.References.MapClrTypeToReferences,
            null,
            argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames);
        if (resolution.Outcome != OverloadResolution.ResolutionOutcome.Resolved)
        {
            return false;
        }

        var method = resolution.Best;
        var parameters = method.GetParameters();

        // Return type: a return that names the interface type-variable is
        // recovered by projecting through the constructed constraint interface;
        // a concrete return (e.g. IComparable.CompareTo -> int32) falls back to
        // the direct CLR mapping.
        var returnType = ResolveInstanceReturnTypeFromReceiver(constraintInterface, method)
            ?? MapClrMemberType(method.ReturnType);

        // Order positionally for named arguments; deliberately skip the CLR
        // boxing/conversion pass — the emitted MemberRef parameter is the
        // interface type-variable `!0` (== the reified `!!T`), so a `T`-typed
        // argument must be passed unboxed.
        var orderedArgs = OverloadResolver.BuildOrderedCallArguments(arguments, resolution.ParameterMapping, parameters);
        var refKinds = ComputeArgumentRefKinds(parameters);

        result = new BoundImportedInstanceCallExpression(
            ce,
            receiver,
            method,
            returnType,
            orderedArgs,
            refKinds,
            default,
            constrainedReceiverTypeParameter: tp,
            constrainedInterfaceType: constraintInterface);
        return true;
    }
}
