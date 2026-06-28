// <copyright file="DeclarationBinder.Interfaces.cs" company="GSharp">
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
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Extracted from <see cref="Binder"/> in PR-B-8. Owns every per-declaration-kind
/// binder: type aliases, named delegates, enums, structs (including the large
/// <c>BindStructDeclarationBody</c> driver and its interface-implementation
/// verification pass), interfaces, free / member / extension functions,
/// constructors (<c>init</c>) plus the <c>: base(...)</c> initializer
/// resolver, the two symbol-construction <c>BindVariableDeclaration</c>
/// overloads, generic-parameter binding (<c>BindTypeParameterList</c>), the
/// declaration-side attribute binder (<c>BindAttributes</c>/<c>BindAttribute</c>),
/// and the queue of pending struct→interface implementation checks. The
/// expression binder and most type-name resolution remain on
/// <see cref="Binder"/> and are invoked via the delegate callbacks supplied to
/// the constructor; the same is true for <c>BindBlockStatement</c>-driven
/// body binding (which happens later, in <c>BindProgram</c>, not here).
/// </summary>

internal sealed partial class DeclarationBinder
{


    /// <summary>
    /// Issue #1006: once interface base clauses have been bound, expand each
    /// implementer's interface set to include the transitive closure of base
    /// interfaces. A <c>class C : B</c> where <c>interface B : A</c> must
    /// implement (and metadata-declare) both <c>B</c> and <c>A</c>, matching
    /// C#. Base CLR interfaces of user interfaces are folded into the
    /// implementer's CLR interface set so dispatch through them works too.
    /// </summary>
    internal void ExpandStructInterfaceClosures()
    {
        foreach (var (_, structSymbol) in pendingInterfaceImplementationChecks)
        {
            if (structSymbol.Interfaces.IsDefaultOrEmpty)
            {
                continue;
            }

            var ordered = new List<InterfaceSymbol>();
            var seen = new HashSet<InterfaceSymbol>();
            var clrSeen = new HashSet<System.Type>();
            var extraClr = ImmutableArray.CreateBuilder<TypeSymbol>();
            if (!structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
            {
                foreach (var existing in structSymbol.ImplementedClrInterfaces)
                {
                    if (existing.ClrType != null)
                    {
                        clrSeen.Add(existing.ClrType);
                    }
                }
            }

            foreach (var direct in structSymbol.Interfaces)
            {
                foreach (var iface in direct.SelfAndAllBaseInterfaces())
                {
                    if (seen.Add(iface))
                    {
                        ordered.Add(iface);
                    }

                    if (!iface.BaseClrInterfaces.IsDefaultOrEmpty)
                    {
                        foreach (var clr in iface.BaseClrInterfaces)
                        {
                            if (clr.ClrType != null && clrSeen.Add(clr.ClrType))
                            {
                                extraClr.Add(clr);
                            }
                        }
                    }
                }
            }

            if (ordered.Count != structSymbol.Interfaces.Length)
            {
                structSymbol.SetInterfaces(ordered.ToImmutableArray());
            }

            if (extraClr.Count > 0)
            {
                var merged = ImmutableArray.CreateBuilder<TypeSymbol>();
                if (!structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
                {
                    merged.AddRange(structSymbol.ImplementedClrInterfaces);
                }

                merged.AddRange(extraClr);
                structSymbol.SetImplementedClrInterfaces(merged.ToImmutable());
            }
        }
    }

    internal void VerifyInterfaceImplementations()
    {
        foreach (var (syntax, structSymbol) in pendingInterfaceImplementationChecks)
        {
            // ADR-0085 / issue #726: collect every interface default-method
            // the implementer would inherit if it does not provide its own
            // method, keyed by signature (name + parameter shape). When two
            // unrelated interfaces both provide a default for the same
            // signature and the class does not declare an override, GS0318
            // fires. The mapping is "first-seen wins" for the diagnostic
            // message; conflicts are reported once per signature.
            var inheritedDefaultsBySignature = new Dictionary<string, (FunctionSymbol Method, InterfaceSymbol Iface)>(System.StringComparer.Ordinal);
            var conflictsReported = new HashSet<string>(System.StringComparer.Ordinal);

            foreach (var iface in structSymbol.Interfaces)
            {
                foreach (var imethod in iface.Methods)
                {
                    // ADR-0063 §8: implementing class may have multiple methods
                    // with the same name; pick the one whose signature matches
                    // this specific interface overload exactly.
                    var implCandidates = structSymbol.GetMethodsIncludingInherited(imethod.Name);
                    FunctionSymbol impl = null;
                    FunctionSymbol signatureMatch = null;
                    foreach (var candidate in implCandidates)
                    {
                        impl ??= candidate;
                        var methodTypeParamMap = TryBuildMethodTypeParameterMap(imethod, candidate);
                        if (methodTypeParamMap == null)
                        {
                            // Generic-arity mismatch: not a viable implementor
                            // of this interface method overload (issue #1007).
                            continue;
                        }

                        if (SignaturesMatch(imethod, GetCallableParameters(candidate), candidate.Type, candidate.ReturnRefKind, methodTypeParamMap, candidate.IsAsync))
                        {
                            signatureMatch = candidate;
                            break;
                        }
                    }

                    if (signatureMatch != null)
                    {
                        // The class itself provides an implementation that exactly
                        // matches the interface signature — no default needed and
                        // any earlier-seen conflicting default is preempted.
                        var sigKey = BuildInterfaceMethodSignatureKey(imethod);
                        inheritedDefaultsBySignature.Remove(sigKey);
                        conflictsReported.Add(sigKey);
                        continue;
                    }

                    if (impl == null)
                    {
                        // ADR-0085: when the interface itself provides a default,
                        // the implementer does not need to declare the method.
                        // Track which default would be inherited so we can
                        // diagnose diamond conflicts across multiple interfaces.
                        if (InterfaceSymbol.HasDefaultBody(imethod))
                        {
                            var sigKey = BuildInterfaceMethodSignatureKey(imethod);
                            if (inheritedDefaultsBySignature.TryGetValue(sigKey, out var prior))
                            {
                                if (!ReferenceEquals(prior.Method, imethod) && conflictsReported.Add(sigKey))
                                {
                                    Diagnostics.ReportConflictingInterfaceDefaults(
                                        syntax.Identifier.Location,
                                        structSymbol.Name,
                                        imethod.Name,
                                        prior.Iface.Name,
                                        iface.Name);
                                }
                            }
                            else
                            {
                                inheritedDefaultsBySignature[sigKey] = (imethod, iface);
                            }

                            continue;
                        }

                        // No impl, no default → original GS0187 channel for
                        // missing implementations. GS0320 narrows it to "the
                        // interface deliberately requires this method".
                        if (InterfaceHasAnyDefaultsExcept(iface, imethod))
                        {
                            Diagnostics.ReportInterfaceAbstractMethodHasNoDefault(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                        }
                        else
                        {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                        }
                    }
                    else if (signatureMatch == null)
                    {
                        // ADR-0060 §9: distinguish a pure ref-kind mismatch (GS0240) from
                        // an unrelated signature mismatch (the existing diagnostic).
                        // Issue #490: also surface a dedicated diagnostic when only the
                        // *return* ref-kind disagrees.
                        if (imethod.Type == impl.Type && imethod.ReturnRefKind != impl.ReturnRefKind)
                        {
                            Diagnostics.ReportOverrideReturnRefKindMismatch(
                                syntax.Identifier.Location,
                                imethod.Name,
                                imethod.ReturnRefKind == RefKind.Ref ? "by ref" : "by value",
                                impl.ReturnRefKind == RefKind.Ref ? "by ref" : "by value");
                        }
                        else
                        {
                            var refMismatchIdx = FindRefKindMismatchIndex(imethod, GetCallableParameters(impl), impl.Type);
                            if (refMismatchIdx >= 0)
                            {
                                var implCallable = GetCallableParameters(impl);
                                var ifaceCallable = GetCallableParameters(imethod);
                                Diagnostics.ReportOverrideRefKindMismatch(
                                    syntax.Identifier.Location,
                                    imethod.Name,
                                    ifaceCallable[refMismatchIdx].Name,
                                    refKindToString(ifaceCallable[refMismatchIdx].RefKind),
                                    refKindToString(implCallable[refMismatchIdx].RefKind));
                            }
                            else
                            {
                                Diagnostics.ReportInterfaceMethodNotImplemented(
                                    syntax.Identifier.Location,
                                    structSymbol.Name,
                                    iface.Name,
                                    imethod.Name);
                            }
                        }
                    }
                }

                // ADR-0051: verify property requirements.
                foreach (var iprop in iface.Properties)
                {
                    // ADR-0089 / issue #1019: static-virtual interface
                    // properties are verified separately (against the
                    // implementer's static properties); skip them here so the
                    // instance-property contract check doesn't misfire.
                    if (iprop.IsStatic)
                    {
                        continue;
                    }

                    // Issue #1066: an interface property may be satisfied by a
                    // property implemented (or inherited) ANYWHERE in the base
                    // chain, not only one declared directly on this class.
                    // TypeMemberModel.TryGetProperty walks BaseClass this-first,
                    // mirroring C# semantics where a base class's accessible
                    // instance member satisfies an interface listed on a
                    // derived class.
                    var found = TypeMemberModel.TryGetProperty(structSymbol, iprop.Name, out var implProp);
                    if (found)
                    {
                        if (iprop.HasGetter && !implProp.HasGetter)
                        {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                iprop.Name + " (getter)");
                        }

                        if (iprop.HasSetter && !implProp.HasSetter)
                        {
                            Diagnostics.ReportInterfaceMethodNotImplemented(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                iprop.Name + " (setter)");
                        }
                    }

                    if (!found)
                    {
                        Diagnostics.ReportInterfaceMethodNotImplemented(
                            syntax.Identifier.Location,
                            structSymbol.Name,
                            iface.Name,
                            iprop.Name);
                    }
                }
            }

            // Issue #525: verify CLR interfaces declared in the base-type clause.
            // Walks each public abstract member on the imported interface and
            // confirms the G# class provides a same-name, same-CLR-signature
            // method or property. Diagnostic uses the same GS0187 channel.
            VerifyClrInterfaceImplementations(syntax, structSymbol);

            // Issue #985: a CLR interface in the base clause may inherit other
            // interfaces whose abstract members are NOT enumerated by the
            // direct-interface walk above (e.g. `IEnumerable[T]` inherits the
            // non-generic `IEnumerable.GetEnumerator()`). The resulting type
            // must satisfy those inherited slots too — otherwise the runtime
            // rejects it with a TypeLoadException. Verify them here so a missing
            // bridge (the canonical "only the generic GetEnumerator present"
            // case) surfaces as GS0187 instead of emitting an unloadable type.
            VerifyInheritedClrInterfaceSlots(syntax, structSymbol);

            // ADR-0089 / issue #755: verify static-virtual interface members.
            // For each declared interface, walk its StaticMethods. The
            // implementer must either (a) declare a matching static method
            // inside its `shared { ... }` block (ADR-0053) — recorded on
            // StructSymbol.StaticMethods — or (b) inherit a default body
            // from the interface itself (the interface method declaration
            // carries a body). If a same-named *instance* method exists but
            // no matching static method, GS0332 surfaces; otherwise GS0331.
            VerifyStaticVirtualInterfaceImplementations(syntax, structSymbol);

            // ADR-0089 / issue #1019: verify static-virtual interface
            // *properties*. The implementer must declare a matching static
            // property (same name and type, with at least the required
            // accessors) inside its `shared { ... }` block; otherwise GS0397.
            VerifyStaticVirtualInterfacePropertyImplementations(syntax, structSymbol);

            // ADR-0090 / issue #756: verify that the implementer does not
            // attempt to override a `private` interface helper. Private
            // helpers are part of the interface's own implementation and
            // are not part of the public contract; an implementer that
            // happens to declare a same-signature method clashes with the
            // helper at the implementation level.
            VerifyPrivateInterfaceHelpersNotOverridden(syntax, structSymbol);
        }
    }

    /// <summary>
    /// ADR-0090 / issue #756: rejects implementers that attempt to declare a
    /// method whose signature matches one of the private helpers on an
    /// implemented interface. Private interface helpers are not part of the
    /// public contract — implementers cannot see them — but a same-shape
    /// declaration would create an ambiguous v-table slot if we did not
    /// surface a diagnostic.
    /// </summary>
    /// <param name="syntax">The implementer's declaring syntax (for location).</param>
    /// <param name="structSymbol">The class symbol whose interfaces are checked.</param>
    private void VerifyPrivateInterfaceHelpersNotOverridden(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        foreach (var iface in structSymbol.Interfaces)
        {
            if (!iface.PrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var imethod in iface.PrivateMethods)
                {
                    foreach (var candidate in structSymbol.GetMethodsIncludingInherited(imethod.Name))
                    {
                        if (SignaturesMatch(imethod, GetCallableParameters(candidate), candidate.Type, candidate.ReturnRefKind, typeParamMap: null, candidate.IsAsync))
                        {
                            Diagnostics.ReportImplementerOverridesPrivateInterfaceMember(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                            break;
                        }
                    }
                }
            }

            if (!iface.StaticPrivateMethods.IsDefaultOrEmpty)
            {
                foreach (var imethod in iface.StaticPrivateMethods)
                {
                    foreach (var candidate in structSymbol.GetStaticMethods(imethod.Name))
                    {
                        if (StaticVirtualSignaturesMatch(imethod, candidate))
                        {
                            Diagnostics.ReportImplementerOverridesPrivateInterfaceMember(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                            break;
                        }
                    }
                }
            }
        }
    }

    /// <summary>
    /// ADR-0089 / issue #755: enforces that every static-virtual interface
    /// member without a default body is matched by a same-signature static
    /// method on the implementer. A non-static implementer member with the
    /// same name produces GS0332; otherwise GS0331.
    /// </summary>
    private void VerifyStaticVirtualInterfaceImplementations(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        foreach (var iface in structSymbol.Interfaces)
        {
            if (iface.StaticMethods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var imethod in iface.StaticMethods)
            {
                var sigMatch = false;
                var nameMatch = false;
                foreach (var candidate in structSymbol.GetStaticMethods(imethod.Name))
                {
                    nameMatch = true;
                    if (StaticVirtualSignaturesMatch(imethod, candidate))
                    {
                        sigMatch = true;
                        break;
                    }
                }

                if (sigMatch)
                {
                    continue;
                }

                if (!nameMatch)
                {
                    // Detect a non-static instance candidate with the same
                    // name → GS0332 — instance member cannot satisfy a
                    // static-virtual slot.
                    foreach (var instCandidate in structSymbol.GetMethodsIncludingInherited(imethod.Name))
                    {
                        if (!instCandidate.IsStatic)
                        {
                            Diagnostics.ReportNonStaticMemberForStaticVirtualSlot(
                                syntax.Identifier.Location,
                                structSymbol.Name,
                                iface.Name,
                                imethod.Name);
                            nameMatch = true;
                            break;
                        }
                    }
                }

                if (sigMatch || nameMatch)
                {
                    continue;
                }

                // No same-name candidate at all. If the interface itself
                // provides a default body, the implementer inherits it.
                if (InterfaceSymbol.HasDefaultBody(imethod))
                {
                    continue;
                }

                Diagnostics.ReportStaticVirtualInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    iface.Name,
                    imethod.Name);
            }
        }
    }

    /// <summary>
    /// ADR-0089 / issue #1019: enforces that every static-virtual interface
    /// property (declared inside the interface <c>shared { … }</c> block) is
    /// matched by a same-name, same-type static property on the implementer
    /// providing at least the required accessors. Missing slots produce GS0397.
    /// </summary>
    private void VerifyStaticVirtualInterfacePropertyImplementations(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        foreach (var iface in structSymbol.Interfaces)
        {
            if (iface.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var iprop in iface.Properties)
            {
                if (!iprop.IsStatic)
                {
                    continue;
                }

                // Issue #1030: a default-bodied static-virtual interface
                // property accessor (non-abstract) supplies its own body, so
                // an implementer is NOT required to provide it. Only abstract
                // accessors must be satisfied. Compute per-accessor whether an
                // abstract slot remains for the implementer to fill.
                var getterIsAbstract = iprop.HasGetter && (iprop.GetterSymbol == null || iprop.GetterSymbol.IsAbstract);
                var setterIsAbstract = iprop.HasSetter && (iprop.SetterSymbol == null || iprop.SetterSymbol.IsAbstract);

                if (!getterIsAbstract && !setterIsAbstract)
                {
                    // Fully default-bodied property: nothing the implementer
                    // must provide.
                    continue;
                }

                PropertySymbol match = null;
                foreach (var candidate in structSymbol.StaticProperties)
                {
                    if (candidate.Name == iprop.Name
                        && System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(candidate.Type, iprop.Type))
                    {
                        match = candidate;
                        break;
                    }
                }

                if (match == null)
                {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "missing static property");
                    continue;
                }

                if (getterIsAbstract && !match.HasGetter)
                {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "getter");
                }

                if (setterIsAbstract && !match.HasSetter)
                {
                    Diagnostics.ReportStaticVirtualInterfacePropertyNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        iface.Name,
                        iprop.Name,
                        "setter");
                }
            }
        }
    }

    /// <summary>
    /// ADR-0085 / issue #726: builds a stable signature key for an interface
    /// method (used to detect diamond conflicts across multiple interfaces).
    /// The key is "Name(P0, P1, …)" using the parameter type names from the
    /// callable shape (which strips the implicit `this`).
    /// </summary>
    private string BuildInterfaceMethodSignatureKey(FunctionSymbol method)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(method.Name);
        sb.Append('(');
        var parameters = GetCallableParameters(method);
        for (var i = 0; i < parameters.Length; i++)
        {
            if (i > 0)
            {
                sb.Append(',');
            }

            sb.Append(parameters[i].Type?.Name ?? "?");
        }

        sb.Append(')');
        return sb.ToString();
    }

    /// <summary>
    /// ADR-0085 helper: returns <c>true</c> when the supplied interface
    /// carries at least one default-bearing method other than
    /// <paramref name="excluded"/>. Used to decide whether GS0320 ("no
    /// default available") fires instead of GS0187 (general "not
    /// implemented"). When the interface is purely abstract, GS0187 stays
    /// the right channel because DIM isn't part of the conversation.
    /// </summary>
    private static bool InterfaceHasAnyDefaultsExcept(InterfaceSymbol iface, FunctionSymbol excluded)
    {
        foreach (var m in iface.Methods)
        {
            if (ReferenceEquals(m, excluded))
            {
                continue;
            }

            if (InterfaceSymbol.HasDefaultBody(m))
            {
                return true;
            }
        }

        return false;
    }

    private void VerifyClrInterfaceImplementations(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        if (structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var ifaceSym in structSymbol.ImplementedClrInterfaces)
        {
            var clrIface = ifaceSym.ClrType;
            if (clrIface == null)
            {
                continue;
            }

            // Issue #949: a CLR generic interface closed over a user-defined G#
            // type (e.g. the self-referential `class Shape : IEquatable[Shape]`)
            // is represented with a type-erased ClrType (`IEquatable<object>`)
            // but carries the real symbolic arguments. Verify against the OPEN
            // definition's members with those arguments substituted in, so the
            // contract demands `Equals(Shape)` rather than `Equals(object)`.
            if (MemberLookup.TryGetSymbolicClrGenericInterface(ifaceSym, out var openDefinition, out var symbolicArgs))
            {
                VerifySymbolicClrGenericInterface(syntax, structSymbol, clrIface, openDefinition, symbolicArgs);
                continue;
            }

            // Methods excluding property/event accessors (those are validated
            // through their owning property / event below).
            foreach (var clrMethod in clrIface.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
            {
                if (clrMethod.IsSpecialName)
                {
                    continue;
                }

                // Skip Default Interface Methods (non-abstract virtual methods).
                // G# does not yet support DIMs (ADR-0018, Phase 6+); a class is
                // not required to implement them — the runtime dispatches to the
                // default body when no explicit override is present.
                if (!clrMethod.IsAbstract)
                {
                    continue;
                }

                if (MemberLookup.HasMatchingMethodForClrSignature(structSymbol, clrMethod))
                {
                    continue;
                }

                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    FormatClrMethodSignature(clrMethod));
            }

            // Properties.
            foreach (var clrProp in clrIface.GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
            {
                var implProp = MemberLookup.FindMatchingProperty(structSymbol, clrProp);
                if (implProp == null)
                {
                    // #573/#606: check whether a public field satisfies the property contract.
                    var matchingField = MemberLookup.FindMatchingFieldForPropertyContract(structSymbol, clrProp);
                    if (matchingField != null)
                    {
                        // Synthesize a PropertySymbol backed by the field so the emit
                        // path handles it via the existing auto-property machinery.
                        bool contractHasSetter = clrProp.SetMethod != null;
                        var synthesized = new PropertySymbol(
                            name: clrProp.Name,
                            type: matchingField.Type,
                            accessibility: Accessibility.Public,
                            hasGetter: true,
                            hasSetter: contractHasSetter,
                            isAutoProperty: true,
                            isVirtual: true,
                            isOverride: false);
                        synthesized.BackingField = matchingField;
                        structSymbol.SetProperties(structSymbol.Properties.Add(synthesized));
                        continue;
                    }

                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        clrIface.FullName ?? clrIface.Name,
                        clrProp.Name);
                    continue;
                }

                if (clrProp.GetMethod != null && !implProp.HasGetter)
                {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        clrIface.FullName ?? clrIface.Name,
                        clrProp.Name + " (getter)");
                }

                if (clrProp.SetMethod != null && !implProp.HasSetter)
                {
                    Diagnostics.ReportInterfaceMethodNotImplemented(
                        syntax.Identifier.Location,
                        structSymbol.Name,
                        clrIface.FullName ?? clrIface.Name,
                        clrProp.Name + " (setter)");
                }
            }
        }
    }

    /// <summary>
    /// Issue #985: verifies that the type satisfies every abstract method slot
    /// contributed by interfaces that its declared CLR interfaces transitively
    /// inherit. The direct-interface walks
    /// (<see cref="VerifyClrInterfaceImplementations"/> /
    /// <see cref="VerifySymbolicClrGenericInterface"/>) only enumerate the
    /// declared interface's OWN members, so an inherited slot such as the
    /// non-generic <c>IEnumerable.GetEnumerator()</c> reached through
    /// <c>IEnumerable[T]</c> would otherwise go unverified and the emitter would
    /// produce a type the runtime cannot load. A satisfying method may be the
    /// covariant-return bridge accepted by
    /// <see cref="MemberLookup.TryResolveCovariantInterfaceBridge"/>.
    /// </summary>
    private void VerifyInheritedClrInterfaceSlots(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        if (structSymbol.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            return;
        }

        var reported = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var ifaceSym in structSymbol.ImplementedClrInterfaces)
        {
            foreach (var slot in MemberLookup.EnumerateClrInterfaceSlots(ifaceSym))
            {
                if (!slot.IsInherited)
                {
                    // The declared interface's own members are checked by the
                    // direct-interface walks; only inherited slots are new here.
                    continue;
                }

                var declaringType = slot.Method.DeclaringType;
                var slotKey = (declaringType?.FullName ?? declaringType?.Name ?? string.Empty)
                    + "::" + MemberLookup.FormatClrSlotSignature(slot.Method);
                if (reported.Contains(slotKey))
                {
                    continue;
                }

                if (StructSatisfiesClrSlot(structSymbol, slot))
                {
                    continue;
                }

                reported.Add(slotKey);
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    declaringType?.FullName ?? declaringType?.Name ?? "interface",
                    MemberLookup.FormatClrSlotSignature(slot.Method));
            }
        }
    }

    /// <summary>
    /// Issue #949: verifies a class against a CLR generic interface that is
    /// closed over at least one user-defined G# type argument (e.g.
    /// <c>IEquatable[Shape]</c>, including the self-referential
    /// <c>class Shape : IEquatable[Shape]</c>). The interface's <c>ClrType</c>
    /// is type-erased (<c>IEquatable&lt;object&gt;</c>), so the contract is
    /// checked against the OPEN definition's members with the symbolic
    /// arguments substituted in — the class must provide <c>Equals(Shape)</c>,
    /// not <c>Equals(object)</c>.
    /// </summary>
    private void VerifySymbolicClrGenericInterface(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        System.Type clrIface,
        System.Type openDefinition,
        ImmutableArray<TypeSymbol> symbolicArgs)
    {
        foreach (var openMethod in openDefinition.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
        {
            if (openMethod.IsSpecialName || !openMethod.IsAbstract)
            {
                continue;
            }

            if (MemberLookup.HasMatchingMethodForSymbolicClrInterface(structSymbol, openMethod, symbolicArgs))
            {
                continue;
            }

            Diagnostics.ReportInterfaceMethodNotImplemented(
                syntax.Identifier.Location,
                structSymbol.Name,
                clrIface.FullName ?? clrIface.Name,
                FormatClrMethodSignature(openMethod));
        }

        foreach (var openProp in openDefinition.GetProperties(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
        {
            var implProp = MemberLookup.FindMatchingPropertyForSymbolicClrInterface(structSymbol, openProp, symbolicArgs);
            if (implProp == null)
            {
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    openProp.Name);
                continue;
            }

            if (openProp.GetMethod != null && !implProp.HasGetter)
            {
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    openProp.Name + " (getter)");
            }

            if (openProp.SetMethod != null && !implProp.HasSetter)
            {
                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    clrIface.FullName ?? clrIface.Name,
                    openProp.Name + " (setter)");
            }
        }
    }
}
