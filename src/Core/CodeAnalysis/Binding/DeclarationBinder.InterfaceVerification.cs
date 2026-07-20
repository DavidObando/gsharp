// <copyright file="DeclarationBinder.InterfaceVerification.cs" company="GSharp">
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
    internal void VerifyAbstractMethodImplementations()
    {
        foreach (var (syntax, structSymbol) in pendingAbstractImplementationChecks)
        {
            // An `open` class is permitted to remain abstract — it need not
            // override inherited abstract members.
            if (structSymbol.IsOpen)
            {
                continue;
            }

            foreach (var abstractMethod in structSymbol.GetUnimplementedAbstractMethods())
            {
                // Skip abstract methods declared directly on this class — those
                // are reported via GS0388 (abstract member in a non-open class).
                // GS0387 is reserved for abstract members *inherited* from a base
                // class and left unimplemented by a concrete subclass.
                if (ReferenceEquals(abstractMethod.ReceiverType, structSymbol))
                {
                    continue;
                }

                Diagnostics.ReportAbstractMemberNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    abstractMethod.ReceiverType?.Name ?? structSymbol.Name,
                    abstractMethod.Name);
            }
        }
    }

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
            ResolveExplicitClrInterfaceImplementations(structSymbol);

            var inheritedDefaultsBySignature = new Dictionary<string, (FunctionSymbol Method, InterfaceSymbol Iface)>(System.StringComparer.Ordinal);
            var conflictsReported = new HashSet<string>(System.StringComparer.Ordinal);
            var positionalInterfaceProps = new Dictionary<string, (ParameterSymbol Param, bool NeedsSetter)>(System.StringComparer.Ordinal);

            foreach (var iface in structSymbol.Interfaces)
            {
                VerifyInterfaceMethodImplementationsAndDefaultConflicts(
                    syntax,
                    structSymbol,
                    iface,
                    inheritedDefaultsBySignature,
                    conflictsReported);
                VerifyInterfacePropertyImplementationsAndCollectPositionalCandidates(
                    syntax,
                    structSymbol,
                    iface,
                    positionalInterfaceProps);
                ResolveExplicitInterfaceEventImplementations(structSymbol, iface);
            }

            static void ResolveExplicitClrInterfaceImplementations(StructSymbol structSymbol)
            {
                foreach (var method in structSymbol.Methods)
                {
                    var target = method.ExplicitInterfaceClauseTarget;
                    if (!method.HasExplicitInterfaceClause
                        || target is InterfaceSymbol
                        || target?.ClrType?.IsInterface != true)
                    {
                        continue;
                    }

                    foreach (var slot in target.ClrType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                    {
                        if (!slot.IsSpecialName
                            && slot.Name == method.Name
                            && MemberLookup.MethodMatchesClrSignature(method, slot))
                        {
                            method.ExplicitInterfaceSlot = slot;
                            method.ExplicitInterfaceSlotContainingType = target;
                            break;
                        }
                    }
                }

                foreach (var property in structSymbol.Properties)
                {
                    var target = property.ExplicitInterfaceClauseTarget;
                    if (!property.HasExplicitInterfaceClause
                        || target is InterfaceSymbol
                        || target?.ClrType?.IsInterface != true)
                    {
                        continue;
                    }

                    foreach (var slot in target.ClrType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                    {
                        if (!ExplicitClrPropertyMatches(property, target, slot))
                        {
                            continue;
                        }

                        property.ExplicitInterfaceGetterSlot = slot.GetMethod;
                        property.ExplicitInterfaceSetterSlot = slot.SetMethod;
                        property.ExplicitInterfaceSlotContainingType = target;
                        break;
                    }
                }

                foreach (var eventSymbol in structSymbol.Events)
                {
                    var target = eventSymbol.ExplicitInterfaceClauseTarget;
                    if (!eventSymbol.HasExplicitInterfaceClause
                        || target is InterfaceSymbol
                        || target?.ClrType?.IsInterface != true)
                    {
                        continue;
                    }

                    foreach (var slot in target.ClrType.GetEvents(BindingFlags.Public | BindingFlags.Instance))
                    {
                        if (slot.Name != eventSymbol.Name
                            || !TypeSignaturesEquivalent(
                                eventSymbol.Type,
                                MemberLookup.GetClrEventHandlerTypeSymbol(target, slot)))
                        {
                            continue;
                        }

                        eventSymbol.ExplicitInterfaceAddSlot = slot.AddMethod;
                        eventSymbol.ExplicitInterfaceRemoveSlot = slot.RemoveMethod;
                        eventSymbol.ExplicitInterfaceRaiseSlot = slot.RaiseMethod;
                        eventSymbol.ExplicitInterfaceSlotContainingType = target;
                        break;
                    }
                }
            }

            static bool ExplicitClrPropertyMatches(
                PropertySymbol property,
                TypeSymbol target,
                PropertyInfo slot)
            {
                if (slot.Name != property.Name
                    || (slot.GetMethod != null) != property.HasGetter
                    || (slot.SetMethod != null) != property.HasSetter
                    || !TypeSignaturesEquivalent(
                        property.Type,
                        MemberLookup.GetClrPropertyTypeSymbol(target, slot)))
                {
                    return false;
                }

                var slotParameters = slot.GetIndexParameters();
                if (slotParameters.Length != property.Parameters.Length)
                {
                    return false;
                }

                for (var i = 0; i < slotParameters.Length; i++)
                {
                    if (!ClrTypeUtilities.AreSame(
                        NullableLifting.GetEffectiveClrType(property.Parameters[i].Type),
                        slotParameters[i].ParameterType))
                    {
                        return false;
                    }
                }

                return true;
            }

            SynthesizePositionalInterfaceProperties(structSymbol, positionalInterfaceProps);
            VerifyClrInterfaceImplementations(syntax, structSymbol);
            VerifyInheritedClrInterfaceSlots(syntax, structSymbol);
            VerifyStaticVirtualInterfaceImplementations(syntax, structSymbol);
            VerifyStaticVirtualInterfacePropertyImplementations(syntax, structSymbol);
            VerifyPrivateInterfaceHelpersNotOverridden(syntax, structSymbol);
            VerifyExplicitInterfaceClauseResolution(syntax, structSymbol);
        }
    }

    private void VerifyInterfaceMethodImplementationsAndDefaultConflicts(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        InterfaceSymbol iface,
        Dictionary<string, (FunctionSymbol Method, InterfaceSymbol Iface)> inheritedDefaultsBySignature,
        HashSet<string> conflictsReported)
    {
        // ADR-0085 / issue #726: collect every interface default-method
        // the implementer would inherit if it does not provide its own
        // method, keyed by signature (name + parameter shape). When two
        // unrelated interfaces both provide a default for the same
        // signature and the class does not declare an override, GS0318
        // fires. The mapping is "first-seen wins" for the diagnostic
        // message; conflicts are reported once per signature.
        foreach (var imethod in iface.Methods)
        {
            // ADR-0149 (was issue #2010's mangled-name convention): an
            // explicit-interface-clause implementation
            // (`func (IFoo) M(...)`) satisfies this slot even though
            // its own declared name never needs to match `imethod`
            // via any string convention — it was already resolved and
            // linked to `imethod` by `ResolveExplicitInterfaceClauses`.
            // Skip the name-based lookup entirely once found; no
            // diagnostic, and the emitter binds the slot via
            // `FunctionSymbol.ExplicitInterfaceMember`.
            if (TryResolveExplicitInterfaceImplementation(structSymbol, iface, imethod) != null)
            {
                continue;
            }

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
    }

    private void VerifyInterfacePropertyImplementationsAndCollectPositionalCandidates(
        StructDeclarationSyntax syntax,
        StructSymbol structSymbol,
        InterfaceSymbol iface,
        Dictionary<string, (ParameterSymbol Param, bool NeedsSetter)> positionalInterfaceProps)
    {
        // Issue #2150: data-class positional parameters that satisfy an
        // interface property are materialized only as public fields, so the
        // CLR interface slot (get_/set_ accessor) would be missing and the
        // emitted type would fail to load. Collect the parameters that
        // satisfy an interface property here, then synthesize backing
        // auto-property accessor members below so the interface contract is
        // fulfilled at the IL level. Keyed by parameter name; the flag
        // tracks whether any satisfied interface property also requires a
        // setter.

        // Issue #2362: a mangled-name explicit PROPERTY implementation
        // (`__explicit_<Interface>__<Member>`) is resolved against the
        // interface's OPEN DEFINITION property table, not the
        // (possibly constructed-generic) `iface.Properties` iterated
        // below. Unlike Methods, InterfaceSymbol.Construct does not
        // substitute Properties onto a constructed instance (see
        // InterfaceSymbol.TryResolveMembers) — `iface.Properties` is
        // empty for a constructed generic interface, so the main loop
        // below never even runs for one. Resolving against
        // `iface.Definition ?? iface` here (a no-op for a non-generic
        // interface, where Definition is the interface itself) lets a
        // generic interface's explicit property implementation still
        // get linked, mirroring the #2181 fix for methods and
        // `EmitStaticVirtualPropertyMethodImpls`, which reads
        // `defIface.Properties` for the identical reason.
        var explicitPropDefIface = iface.Definition ?? iface;
        if (!explicitPropDefIface.Properties.IsDefaultOrEmpty)
        {
            foreach (var openIprop in explicitPropDefIface.Properties)
            {
                if (!openIprop.IsStatic)
                {
                    TryResolveExplicitInterfacePropertyImplementation(structSymbol, iface, openIprop);
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

            // Issue #2362: a mangled-name explicit implementation
            // (`__explicit_<Interface>__<Member>`) satisfies this slot
            // even though its own name never matches `iprop.Name` —
            // already resolved and linked by the pre-pass above. Skip
            // entirely; no diagnostic, and the emitter binds the
            // accessor MethodImpl rows via
            // `PropertySymbol.ExplicitInterfaceMember`.
            if (TryResolveExplicitInterfacePropertyImplementation(structSymbol, iface, iprop) != null)
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

            // Issue #2150: a data-class positional (primary-constructor)
            // parameter is materialized as a public instance field and,
            // like a C# record's positional property, may satisfy a
            // matching get/set interface property. It never appears in
            // `.Properties`, so `TryGetProperty` misses it. Walk the
            // this-first BaseClass chain (mirroring `TryGetProperty` and
            // issue #1066) and treat a same-name, type-compatible
            // positional parameter as satisfying the property contract.
            if (!found && TypeMemberModel.TryGetPrimaryConstructorParameter(structSymbol, iprop.Name, out var positionalParam))
            {
                found = true;

                // Issue #2150 follow-up (Oahu migration): compare the
                // underlying (nullability-erased) types, then apply
                // Kotlin-style SOUND nullability variance on top —
                // G# targets Kotlin-faithful null safety (smart-casts,
                // `if let`/`guard let`), which enforces nullability via
                // subtyping: `T <: T?`, never the reverse. A get-only
                // interface property is a covariant (return) position,
                // so the implementing member's type merely needs to be
                // a SUBTYPE of the interface property's type — `T` or
                // `T?` both satisfy `T?`, but only `T` satisfies `T`
                // (accepting `T?` there would let a consumer of the
                // non-null contract observe `null` and NPE, which is
                // exactly the unsoundness this tightens). A property
                // that ALSO declares a setter is an invariant
                // (read/write) position — like a C# `in`/`out`
                // parameter mismatch, both directions must hold, so the
                // nullability must match EXACTLY.
                var positionalUnderlyingType = positionalParam.Type is NullableTypeSymbol positionalNullable
                    ? positionalNullable.UnderlyingType
                    : positionalParam.Type;
                var ifaceUnderlyingType = iprop.Type is NullableTypeSymbol ifaceNullable
                    ? ifaceNullable.UnderlyingType
                    : iprop.Type;

                var underlyingTypesMatch = System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(positionalUnderlyingType, ifaceUnderlyingType);
                var ifaceIsNullable = iprop.Type is NullableTypeSymbol;
                var implIsNullable = positionalParam.Type is NullableTypeSymbol;

                var nullabilityCompatible = iprop.HasSetter
                    ? ifaceIsNullable == implIsNullable
                    : !(!ifaceIsNullable && implIsNullable);

                if (!underlyingTypesMatch || !nullabilityCompatible)
                {
                    // Name matches but the type is incompatible: the
                    // positional parameter does not satisfy the contract.
                    // Fall through to the single GS0187 report below.
                    found = false;
                }
                else
                {
                    // Record the positional parameter so a backing
                    // auto-property is synthesized below, filling the
                    // interface's get_/set_ accessor slots. A data-class
                    // positional parameter is a mutable public field, so
                    // it can satisfy a setter requirement too.
                    var needsSetter = iprop.HasSetter;
                    if (positionalInterfaceProps.TryGetValue(iprop.Name, out var existing))
                    {
                        positionalInterfaceProps[iprop.Name] = (existing.Param, existing.NeedsSetter || needsSetter);
                    }
                    else
                    {
                        positionalInterfaceProps[iprop.Name] = (positionalParam, needsSetter);
                    }
                }
            }

            if (!found)
            {
                // Issue #2293: an interface property whose required
                // accessors all carry a default (arrow/block) body is
                // satisfied by inheritance, exactly like a
                // default-interface method — no GS0187 needed.
                if (PropertyHasDefaultBody(iprop))
                {
                    continue;
                }

                Diagnostics.ReportInterfaceMethodNotImplemented(
                    syntax.Identifier.Location,
                    structSymbol.Name,
                    iface.Name,
                    iprop.Name);
            }
        }
    }

    private void ResolveExplicitInterfaceEventImplementations(StructSymbol structSymbol, InterfaceSymbol iface)
    {
        // ADR-0149: resolve explicit-interface EVENT implementations
        // (`event (IFoo) Changed T`) — generalizes the #2362 property
        // pre-pass immediately above to events for the first time.
        // Mirrors the property pre-pass exactly: resolved against the
        // interface's OPEN DEFINITION event table (constructed
        // generic interfaces do not substitute Events either — see
        // InterfaceSymbol.TryResolveMembers), and is a pure resolve
        // pass with no ordinary implicit-event-contract diagnostic
        // (there is currently no implicit interface-event contract
        // check in this binder at all — adding one is out of scope
        // for this explicit-implementation feature and would risk an
        // unrelated regression across every existing interface-event
        // declaration in the test suite).
        var explicitEventDefIface = iface.Definition ?? iface;
        if (!explicitEventDefIface.Events.IsDefaultOrEmpty)
        {
            foreach (var openIevent in explicitEventDefIface.Events)
            {
                TryResolveExplicitInterfaceEventImplementation(structSymbol, iface, openIevent);
            }
        }
    }

    private static void SynthesizePositionalInterfaceProperties(
        StructSymbol structSymbol,
        Dictionary<string, (ParameterSymbol Param, bool NeedsSetter)> positionalInterfaceProps)
    {
        // Issue #2150: materialize synthesized backing auto-properties for
        // every data-class positional parameter that satisfied an interface
        // property above. Member access still resolves to the underlying
        // field (fields are probed before properties), so this only adds the
        // get_/set_ accessor methods the CLR interface slot requires. The
        // existing property-emission path (planning, accessor IL, PropertyDef
        // rows, and Virtual|NewSlot promotion for interface implementation)
        // consumes these uniformly.
        //
        // The synthesized property is attached to the class that actually
        // declares the backing field (this class or a base). Emitting it on
        // the declaring type keeps it a same-type auto-property — the field
        // planner only reserves a backing-field row when the auto-property's
        // backing field is NOT one of the type's own fields, so a
        // cross-type backing reference would corrupt the FieldDef range.
        // The accessor is virtual (NewSlot), so a derived class that lists
        // the interface satisfies the slot through inheritance.
        if (positionalInterfaceProps.Count > 0)
        {
            foreach (var entry in positionalInterfaceProps.Values)
            {
                var param = entry.Param;
                if (!structSymbol.TryGetFieldIncludingInherited(param.Name, out var backingField, out var declaringType))
                {
                    continue;
                }

                // Skip if the declaring type already exposes a property of
                // this name (a real one that already satisfies the slot, or
                // one synthesized by an earlier derived-class check).
                if (TypeMemberModel.TryGetProperty(declaringType, param.Name, out _))
                {
                    continue;
                }

                var synthProp = new PropertySymbol(
                    name: param.Name,
                    type: param.Type,
                    accessibility: Accessibility.Public,
                    hasGetter: true,
                    hasSetter: entry.NeedsSetter,
                    isAutoProperty: true,
                    isVirtual: true,
                    isOverride: false)
                {
                    BackingField = backingField,
                };

                declaringType.SetProperties(declaringType.Properties.Add(synthProp));
            }
        }
    }

    // ADR-0149: sweep every explicit-interface qualifier clause that
    // successfully bound a target interface (via
    // ResolveExplicitInterfaceClauses) for two outstanding problems
    // the per-interface-member loops above cannot detect on their
    // own: (a) two members on the same type both explicitly claim
    // the same (interface, name) slot (GS0495), and (b) a clause
    // whose target interface has no member matching this
    // declaration's name/signature/accessor-shape at all (GS0494) —
    // the loops above only ever *consume* a clause-bearing candidate
    // when it matches; one that never matches anything is otherwise
    // silently accepted as an ordinary (non-conforming) member.

    /// <summary>
    /// ADR-0149: reports GS0495 for two explicit-interface-clause members on
    /// the same type that target the same (interface, member-name) slot, and
    /// GS0494 for a clause-bearing member whose target interface was
    /// resolved (by <see cref="ResolveExplicitInterfaceClauses"/>) but which
    /// never matched any interface member during the per-interface-member
    /// loops above (i.e. its <c>ExplicitInterfaceMember</c> is still
    /// unset) — most commonly a signature or accessor-shape mismatch, or a
    /// name the target interface simply does not declare.
    /// </summary>
    private void VerifyExplicitInterfaceClauseResolution(StructDeclarationSyntax syntax, StructSymbol structSymbol)
    {
        var seenSlots = new Dictionary<(TypeSymbol Iface, string Name), bool>();

        if (!structSymbol.Methods.IsDefaultOrEmpty)
        {
            foreach (var method in structSymbol.Methods)
            {
                if (!method.HasExplicitInterfaceClause || method.ExplicitInterfaceClauseTarget == null)
                {
                    continue;
                }

                var slot = (method.ExplicitInterfaceClauseTarget, method.Name);
                if (seenSlots.ContainsKey(slot))
                {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        method.Declaration.Identifier.Location,
                        method.ExplicitInterfaceClauseTarget.Name,
                        method.Name);
                    continue;
                }

                seenSlots[slot] = true;

                if (method.ExplicitInterfaceMember == null && method.ExplicitInterfaceSlot == null)
                {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        method.Declaration.Identifier.Location,
                        method.ExplicitInterfaceClauseTarget.Name,
                        method.Name);
                }
            }
        }

        if (!structSymbol.Properties.IsDefaultOrEmpty)
        {
            foreach (var prop in structSymbol.Properties)
            {
                if (!prop.HasExplicitInterfaceClause || prop.ExplicitInterfaceClauseTarget == null)
                {
                    continue;
                }

                var slot = (prop.ExplicitInterfaceClauseTarget, prop.Name);
                if (seenSlots.ContainsKey(slot))
                {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        prop.Declaration.Identifier.Location,
                        prop.ExplicitInterfaceClauseTarget.Name,
                        prop.Name);
                    continue;
                }

                seenSlots[slot] = true;

                if (prop.ExplicitInterfaceMember == null
                    && prop.ExplicitInterfaceGetterSlot == null
                    && prop.ExplicitInterfaceSetterSlot == null)
                {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        prop.Declaration.Identifier.Location,
                        prop.ExplicitInterfaceClauseTarget.Name,
                        prop.Name);
                }
            }
        }

        // ADR-0149: generalizes the method/property sweep above to events —
        // the fourth and final explicit-implementable member kind (an
        // indexer reuses the property sweep above, since it IS a
        // PropertySymbol with IsIndexer=true).
        if (!structSymbol.Events.IsDefaultOrEmpty)
        {
            foreach (var evt in structSymbol.Events)
            {
                if (!evt.HasExplicitInterfaceClause || evt.ExplicitInterfaceClauseTarget == null)
                {
                    continue;
                }

                var slot = (evt.ExplicitInterfaceClauseTarget, evt.Name);
                if (seenSlots.ContainsKey(slot))
                {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        evt.Declaration.Identifier.Location,
                        evt.ExplicitInterfaceClauseTarget.Name,
                        evt.Name);
                    continue;
                }

                seenSlots[slot] = true;

                if (evt.ExplicitInterfaceMember == null
                    && evt.ExplicitInterfaceAddSlot == null
                    && evt.ExplicitInterfaceRemoveSlot == null)
                {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        evt.Declaration.Identifier.Location,
                        evt.ExplicitInterfaceClauseTarget.Name,
                        evt.Name);
                }
            }
        }

        // ADR-0149 follow-up (issue #2370): STATIC methods/properties use a
        // SEPARATE slot-identity dictionary — a static-virtual member and an
        // instance member of the SAME interface/name occupy different vtable
        // spaces (distinct CLR MethodImpl targets: an instance method's
        // interfaceimpl slot vs. a static-virtual method's own, unrelated
        // slot introduced by ADR-0089/#755), so they must never collide with
        // (or be conflated with) the instance sweep above.
        var seenStaticSlots = new Dictionary<(TypeSymbol Iface, string Name), bool>();

        if (!structSymbol.StaticMethods.IsDefaultOrEmpty)
        {
            foreach (var method in structSymbol.StaticMethods)
            {
                if (!method.HasExplicitInterfaceClause || method.ExplicitInterfaceClauseTarget == null)
                {
                    continue;
                }

                var slot = (method.ExplicitInterfaceClauseTarget, method.Name);
                if (seenStaticSlots.ContainsKey(slot))
                {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        method.Declaration.Identifier.Location,
                        method.ExplicitInterfaceClauseTarget.Name,
                        method.Name);
                    continue;
                }

                seenStaticSlots[slot] = true;

                if (method.ExplicitInterfaceMember == null)
                {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        method.Declaration.Identifier.Location,
                        method.ExplicitInterfaceClauseTarget.Name,
                        method.Name);
                }
            }
        }

        if (!structSymbol.StaticProperties.IsDefaultOrEmpty)
        {
            foreach (var prop in structSymbol.StaticProperties)
            {
                if (!prop.HasExplicitInterfaceClause || prop.ExplicitInterfaceClauseTarget == null)
                {
                    continue;
                }

                var slot = (prop.ExplicitInterfaceClauseTarget, prop.Name);
                if (seenStaticSlots.ContainsKey(slot))
                {
                    Diagnostics.ReportDuplicateExplicitInterfaceImplementation(
                        prop.Declaration.Identifier.Location,
                        prop.ExplicitInterfaceClauseTarget.Name,
                        prop.Name);
                    continue;
                }

                seenStaticSlots[slot] = true;

                if (prop.ExplicitInterfaceMember == null)
                {
                    Diagnostics.ReportExplicitInterfaceClauseMemberNotFound(
                        prop.Declaration.Identifier.Location,
                        prop.ExplicitInterfaceClauseTarget.Name,
                        prop.Name);
                }
            }
        }
    }

    // ADR-0090 / issue #756: verify that the implementer does not
    // attempt to override a `private` interface helper. Private
    // helpers are part of the interface's own implementation and
    // are not part of the public contract; an implementer that
    // happens to declare a same-signature method clashes with the
    // helper at the implementation level.

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

    // ADR-0089 / issue #755: verify static-virtual interface members.
    // For each declared interface, walk its StaticMethods. The
    // implementer must either (a) declare a matching static method
    // inside its `shared { ... }` block (ADR-0053) — recorded on
    // StructSymbol.StaticMethods — or (b) inherit a default body
    // from the interface itself (the interface method declaration
    // carries a body). If a same-named *instance* method exists but
    // no matching static method, GS0332 surfaces; otherwise GS0331.

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
                // ADR-0149 follow-up (issue #2370): an explicit-interface-
                // clause static method (`func (IFoo) M(...)` inside a
                // `shared { }` block) satisfies this slot even though its
                // own declared name never needs to match `imethod` — already
                // resolved and linked by ResolveExplicitInterfaceClauses.
                // Skip the name-based lookup entirely once found; no
                // diagnostic, and the emitter binds the MethodImpl slot via
                // FunctionSymbol.ExplicitInterfaceMember.
                if (TryResolveExplicitInterfaceStaticImplementation(structSymbol, iface, imethod) != null)
                {
                    continue;
                }

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

    // ADR-0089 / issue #1019: verify static-virtual interface
    // *properties*. The implementer must declare a matching static
    // property (same name and type, with at least the required
    // accessors) inside its `shared { ... }` block; otherwise GS0397.

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
            // Pre-existing bug found while generalizing #2370 to static
            // explicit members: InterfaceSymbol.Construct does NOT
            // substitute Properties onto a constructed generic instance
            // (see InterfaceSymbol.TryResolveMembers, and the identical
            // `iface.Definition ?? iface` fixes above for the instance
            // explicit-property/-event pre-passes) — `iface.Properties` is
            // empty for e.g. `IBox[int32]`, so a static-virtual property
            // requirement declared on a GENERIC interface was silently
            // never verified at all before this fix.
            var staticPropDefIface = iface.Definition ?? iface;
            if (staticPropDefIface.Properties.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var iprop in staticPropDefIface.Properties)
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

                // ADR-0149 follow-up (issue #2370): an explicit-interface-
                // clause static property (`prop (IFoo) P T` inside a
                // `shared { }` block) satisfies this slot regardless of its
                // own declared name — already resolved and linked by
                // ResolveExplicitInterfaceClauses. Skip the name-based
                // lookup entirely once found.
                if (TryResolveExplicitInterfaceStaticPropertyImplementation(structSymbol, iface, iprop) != null)
                {
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
    /// ADR-0089: shallow signature comparison for a static-virtual interface
    /// slot vs. a candidate implementer method. Static methods have no
    /// implicit <c>this</c>, so all parameters are direct and compared by
    /// type identity and ref-kind.
    /// </summary>
    private static bool StaticVirtualSignaturesMatch(FunctionSymbol iface, FunctionSymbol impl)
    {
        if (iface.Parameters.Length != impl.Parameters.Length)
        {
            return false;
        }

        if (!System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(iface.Type, impl.Type))
        {
            return false;
        }

        if (iface.ReturnRefKind != impl.ReturnRefKind)
        {
            return false;
        }

        for (var i = 0; i < iface.Parameters.Length; i++)
        {
            if (!System.Collections.Generic.EqualityComparer<TypeSymbol>.Default.Equals(iface.Parameters[i].Type, impl.Parameters[i].Type))
            {
                return false;
            }

            if (iface.Parameters[i].RefKind != impl.Parameters[i].RefKind)
            {
                return false;
            }
        }

        return true;
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

    /// <summary>
    /// Issue #2293: returns <c>true</c> when the supplied interface property
    /// is fully satisfied by the interface's own default (arrow/block-bodied)
    /// accessor implementations — i.e. every accessor the property actually
    /// requires (getter when <see cref="PropertySymbol.HasGetter"/>, setter
    /// when <see cref="PropertySymbol.HasSetter"/>) is a non-abstract default
    /// slot with a real body. This mirrors <see cref="InterfaceSymbol.HasDefaultBody(FunctionSymbol)"/>
    /// for default-interface *methods*: a class that omits the property
    /// entirely still satisfies the contract by inheriting the interface's
    /// default accessor bodies. An accessor without a default body (a
    /// body-less/abstract slot) still requires the implementer to provide it,
    /// so this returns <c>false</c> in that case even if the other accessor
    /// has a default.
    /// </summary>
    /// <param name="property">The interface property to inspect.</param>
    /// <returns>True when every required accessor has a default body.</returns>
    private static bool PropertyHasDefaultBody(PropertySymbol property)
    {
        if (property.HasGetter && (property.GetterSymbol == null || property.GetterSymbol.IsAbstract))
        {
            return false;
        }

        if (property.HasSetter && (property.SetterSymbol == null || property.SetterSymbol.IsAbstract))
        {
            return false;
        }

        return true;
    }

    // Issue #525: verify CLR interfaces declared in the base-type clause.
    // Walks each public abstract member on the imported interface and
    // confirms the G# class provides a same-name, same-CLR-signature
    // method or property. Diagnostic uses the same GS0187 channel.
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

    // Issue #985: a CLR interface in the base clause may inherit other
    // interfaces whose abstract members are NOT enumerated by the
    // direct-interface walk above (e.g. `IEnumerable[T]` inherits the
    // non-generic `IEnumerable.GetEnumerator()`). The resulting type
    // must satisfy those inherited slots too — otherwise the runtime
    // rejects it with a TypeLoadException. Verify them here so a missing
    // bridge (the canonical "only the generic GetEnumerator present"
    // case) surfaces as GS0187 instead of emitting an unloadable type.

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

    private static bool StructSatisfiesClrSlot(StructSymbol structSymbol, in MemberLookup.ClrInterfaceSlot slot)
    {
        // Note: do NOT route through GetMethodsIncludingInherited here — it
        // dedups same-name overloads by parameter signature (ignoring return
        // type), which would hide the non-generic covariant bridge method that
        // shares the generic method's name and (empty) parameter list. Walk the
        // class and its base chain directly so both overloads are visible.
        for (var c = structSymbol; c != null; c = c.BaseClass)
        {
            if (c.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var candidate in c.Methods)
            {
                if (candidate.Name == slot.Method.Name
                    && MemberLookup.MethodSatisfiesClrSlot(candidate, slot))
                {
                    return true;
                }
            }
        }

        return false;
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

    private static string FormatClrMethodSignature(System.Reflection.MethodInfo method)
    {
        var ps = method.GetParameters();
        if (ps.Length == 0)
        {
            return method.Name;
        }

        var names = new string[ps.Length];
        for (var i = 0; i < ps.Length; i++)
        {
            names[i] = ps[i].ParameterType.Name;
        }

        return $"{method.Name}({string.Join(", ", names)})";
    }

    /// <summary>
    /// Issue #948: scans an instance field initializer expression for a
    /// reference to <c>this</c>, another instance member, or a constructor
    /// parameter. Such references are illegal because instance field
    /// initializers run before the constructor body (matching C#).
    /// </summary>
    /// <param name="node">The initializer expression syntax to scan.</param>
    /// <param name="forbiddenNames">Instance member and constructor parameter names.</param>
    /// <param name="offendingName">The first offending name found.</param>
    /// <param name="offendingLocation">The location of the first offending reference.</param>
    /// <returns>True when an illegal reference was found.</returns>
    private static bool TryFindInstanceMemberReference(
        SyntaxNode node,
        HashSet<string> forbiddenNames,
        out string offendingName,
        out TextLocation offendingLocation) =>
        TryFindInstanceMemberReference(node, forbiddenNames, new HashSet<string>(StringComparer.Ordinal), out offendingName, out offendingLocation);

    /// <summary>
    /// Issue #1641: scoped/shadow-aware variant of the scan above. A name that
    /// resolves to a locally-introduced binding (lambda/function-literal
    /// parameter, local <c>let</c>/<c>var</c>, deconstruction binding, pattern
    /// capture, catch/for-loop variable, ...) shadows the instance member of
    /// the same name and must not be flagged. <paramref name="shadowedNames"/>
    /// carries the names bound by enclosing scopes down into this call.
    /// Note: unlike C#, G#'s <c>is</c> operator (<see cref="IsExpressionSyntax"/>)
    /// is a plain type test with no capture — <c>expr is T name</c> does not
    /// exist. The only pattern captures reachable here come from
    /// <c>switch</c>/<c>match</c> arm patterns (<see cref="TypePatternSyntax"/>,
    /// <see cref="SlicePatternSyntax"/>), which the generic child walk already
    /// scopes correctly: a capture is added to the shadow set only while
    /// iterating the owning <see cref="SwitchCaseSyntax"/>/
    /// <see cref="SwitchExpressionArmSyntax"/>'s own children (guard + body),
    /// never leaking to sibling arms or the enclosing scope.
    /// </summary>
    private static bool TryFindInstanceMemberReference(
        SyntaxNode node,
        HashSet<string> forbiddenNames,
        HashSet<string> shadowedNames,
        out string offendingName,
        out TextLocation offendingLocation)
    {
        switch (node)
        {
            case NameExpressionSyntax nameExpr:
                if (forbiddenNames.Contains(nameExpr.IdentifierToken.Text) &&
                    !shadowedNames.Contains(nameExpr.IdentifierToken.Text))
                {
                    offendingName = nameExpr.IdentifierToken.Text;
                    offendingLocation = nameExpr.IdentifierToken.Location;
                    return true;
                }

                break;

            // Lambda / function-literal parameters shadow only within the body.
            // Param default-value expressions (ADR-0063) and type clauses are
            // intentionally not scanned: defaults are restricted by the binder
            // to compile-time constants (numeric/bool/char/string/enum/nil),
            // which can never resolve to an instance member, and type clauses
            // carry no expressions either.
            case LambdaExpressionSyntax lambda:
                return TryFindInstanceMemberReference(
                    lambda.Body, forbiddenNames, WithShadowed(shadowedNames, lambda.Parameters.Select(p => p.Identifier.Text)), out offendingName, out offendingLocation);

            case FunctionLiteralExpressionSyntax func:
                return TryFindInstanceMemberReference(
                    func.Body, forbiddenNames, WithShadowed(shadowedNames, func.Parameters.Select(p => p.Identifier.Text)), out offendingName, out offendingLocation);

            // Catch and loop variables shadow only within their body; the
            // scrutinee/collection/bounds are evaluated in the outer scope.
            case CatchClauseSyntax catchClause when catchClause.Identifier != null:
                return TryFindInstanceMemberReference(
                    catchClause.Body, forbiddenNames, WithShadowed(shadowedNames, new[] { catchClause.Identifier.Text }), out offendingName, out offendingLocation);

            case ForRangeStatementSyntax forRange:
                if (TryFindInstanceMemberReference(forRange.Collection, forbiddenNames, shadowedNames, out offendingName, out offendingLocation))
                {
                    return true;
                }

                var forRangeNames = forRange.SecondIdentifier != null
                    ? new[] { forRange.FirstIdentifier.Text, forRange.SecondIdentifier.Text }
                    : new[] { forRange.FirstIdentifier.Text };
                return TryFindInstanceMemberReference(forRange.Body, forbiddenNames, WithShadowed(shadowedNames, forRangeNames), out offendingName, out offendingLocation);

            case ForTupleRangeStatementSyntax forTupleRange:
                if (TryFindInstanceMemberReference(forTupleRange.Collection, forbiddenNames, shadowedNames, out offendingName, out offendingLocation))
                {
                    return true;
                }

                var forTupleRangeNames = forTupleRange.Identifiers.Select(t => t.Text);
                return TryFindInstanceMemberReference(forTupleRange.Body, forbiddenNames, WithShadowed(shadowedNames, forTupleRangeNames), out offendingName, out offendingLocation);

            case ForEllipsisStatementSyntax forEllipsis:
                if (TryFindInstanceMemberReference(forEllipsis.LowerBound, forbiddenNames, shadowedNames, out offendingName, out offendingLocation) ||
                    TryFindInstanceMemberReference(forEllipsis.UpperBound, forbiddenNames, shadowedNames, out offendingName, out offendingLocation))
                {
                    return true;
                }

                return TryFindInstanceMemberReference(
                    forEllipsis.Body, forbiddenNames, WithShadowed(shadowedNames, new[] { forEllipsis.Identifier.Text }), out offendingName, out offendingLocation);

            case AwaitForRangeStatementSyntax awaitForRange:
                if (TryFindInstanceMemberReference(awaitForRange.Stream, forbiddenNames, shadowedNames, out offendingName, out offendingLocation))
                {
                    return true;
                }

                return TryFindInstanceMemberReference(
                    awaitForRange.Body, forbiddenNames, WithShadowed(shadowedNames, new[] { awaitForRange.Identifier.Text }), out offendingName, out offendingLocation);

            // `if let` bindings are visible only in the then/else clauses, not
            // to statements following the `if`.
            case IfLetStatementSyntax ifLet:
                var ifLetNames = new List<string>();
                foreach (var binding in ifLet.Bindings)
                {
                    if (TryFindInstanceMemberReference(binding.Initializer, forbiddenNames, shadowedNames, out offendingName, out offendingLocation))
                    {
                        return true;
                    }

                    ifLetNames.Add(binding.Identifier.Text);
                }

                var ifLetShadowed = WithShadowed(shadowedNames, ifLetNames);
                if (TryFindInstanceMemberReference(ifLet.ThenStatement, forbiddenNames, ifLetShadowed, out offendingName, out offendingLocation))
                {
                    return true;
                }

                return ifLet.ElseClause != null &&
                    TryFindInstanceMemberReference(ifLet.ElseClause, forbiddenNames, shadowedNames, out offendingName, out offendingLocation);
        }

        // Generic default: sequentially walk this node's children, growing a
        // local shadow set as declaration-introducing children are seen so
        // later siblings (e.g. a subsequent statement in the same block) see
        // names bound by an earlier `let`/`var`, deconstruction, `guard let`,
        // or pattern capture — matching how those bindings extend the
        // enclosing scope.
        var local = shadowedNames;
        var cloned = false;
        foreach (var child in node.GetChildren())
        {
            if (TryFindInstanceMemberReference(child, forbiddenNames, local, out offendingName, out offendingLocation))
            {
                return true;
            }

            var declared = GetSequentiallyDeclaredNames(child);
            if (declared != null)
            {
                if (!cloned)
                {
                    local = new HashSet<string>(local, StringComparer.Ordinal);
                    cloned = true;
                }

                foreach (var name in declared)
                {
                    local.Add(name);
                }
            }
        }

        offendingName = null;
        offendingLocation = default;
        return false;
    }

    /// <summary>Returns a copy of <paramref name="shadowedNames"/> with <paramref name="newNames"/> added.</summary>
    private static HashSet<string> WithShadowed(HashSet<string> shadowedNames, IEnumerable<string> newNames)
    {
        var result = new HashSet<string>(shadowedNames, StringComparer.Ordinal);
        foreach (var name in newNames)
        {
            result.Add(name);
        }

        return result;
    }

    /// <summary>
    /// Names bound by <paramref name="node"/> that remain visible to its
    /// following siblings within the enclosing node's child list — plain
    /// local declarations (<c>let</c>/<c>var</c>, tuple/named deconstruction,
    /// <c>guard let</c>) and pattern captures (e.g. <c>x is Foo y</c> or a
    /// <c>match</c> arm pattern), which this scan conservatively treats as
    /// shadowing for the rest of the initializer rather than modelling
    /// precise flow-sensitive scoping. Returns <c>null</c> when the node
    /// introduces no such bindings.
    /// </summary>
    private static IEnumerable<string> GetSequentiallyDeclaredNames(SyntaxNode node)
    {
        switch (node)
        {
            case VariableDeclarationSyntax variableDeclaration:
                return new[] { variableDeclaration.Identifier.Text };

            case TupleDeconstructionStatementSyntax tupleDeconstruction:
                return tupleDeconstruction.Identifiers.Select(t => t.Text).ToArray();

            case NamedDeconstructionStatementSyntax namedDeconstruction:
                return namedDeconstruction.Fields.Select(f => f.LocalIdentifier.Text).ToArray();

            case GuardLetStatementSyntax guardLet:
                return guardLet.Bindings.Select(b => b.Identifier.Text).ToArray();

            case PatternSyntax pattern:
                var captures = new List<string>();
                CollectPatternCaptureNames(pattern, captures);
                return captures.Count > 0 ? captures : null;

            default:
                return null;
        }
    }

    /// <summary>Recursively collects capture names (e.g. <c>y</c> in the type pattern <c>Foo y</c>, or <c>rest</c> in a slice pattern) from a pattern subtree.</summary>
    private static void CollectPatternCaptureNames(SyntaxNode node, List<string> captures)
    {
        switch (node)
        {
            case TypePatternSyntax typePattern when typePattern.Identifier != null:
                captures.Add(typePattern.Identifier.Text);
                break;

            case SlicePatternSyntax slicePattern when slicePattern.CaptureIdentifier != null:
                captures.Add(slicePattern.CaptureIdentifier.Text);
                break;
        }

        foreach (var child in node.GetChildren())
        {
            CollectPatternCaptureNames(child, captures);
        }
    }

    /// <summary>
    /// Issue #948: attempts to fold a bound const-field initializer to a
    /// compile-time constant value coerced to the field's CLR primitive type.
    /// Handles literal expressions (optionally wrapped in numeric/identity
    /// conversions) and unary negation of a numeric literal. Returns
    /// <c>false</c> for non-constant expressions so the caller can report a
    /// diagnostic.
    /// </summary>
    /// <param name="bound">The bound (already type-converted) initializer expression.</param>
    /// <param name="fieldType">The declared const field type.</param>
    /// <param name="value">The folded constant value on success.</param>
    /// <returns>True when a compile-time constant was produced.</returns>
    private static bool TryFoldConstantFieldValue(BoundExpression bound, TypeSymbol fieldType, out object value)
    {
        value = null;
        if (!TryEvaluateConstant(bound, out var raw))
        {
            return false;
        }

        if (raw == null)
        {
            // A null literal is only valid for reference-typed const fields
            // (e.g. `const s string = nil`); the Constant row stores a null.
            value = null;
            return !fieldType.ClrType?.IsValueType ?? true;
        }

        var targetClr = fieldType.ClrType;
        if (targetClr == null)
        {
            return false;
        }

        if (targetClr.IsEnum)
        {
            targetClr = System.Enum.GetUnderlyingType(targetClr);
        }

        try
        {
            value = targetClr == raw.GetType()
                ? raw
                : System.Convert.ChangeType(raw, targetClr, System.Globalization.CultureInfo.InvariantCulture);
            return true;
        }
        catch (System.Exception ex) when (ex is System.InvalidCastException or System.FormatException or System.OverflowException or System.ArgumentException)
        {
            return false;
        }
    }

    /// <summary>
    /// Issue #948: evaluates a bound expression to a compile-time constant
    /// (a literal, a conversion over a constant, or a unary +/- over a numeric
    /// constant). Returns <c>false</c> for any non-constant shape.
    /// </summary>
    /// <param name="bound">The bound expression.</param>
    /// <param name="value">The constant value on success.</param>
    /// <returns>True when the expression is a compile-time constant.</returns>
    private static bool TryEvaluateConstant(BoundExpression bound, out object value)
    {
        switch (bound)
        {
            case BoundLiteralExpression lit:
                value = lit.Value;
                return true;

            case BoundConversionExpression conv:
                return TryEvaluateConstant(conv.Expression, out value);

            case BoundFieldAccessExpression fieldAccess
                when fieldAccess.Field is { IsConst: true } constField
                && constField.ConstantValue != null:
                // Issue #1193: a `const` field initializer composed of other
                // `const` fields folds by reading the referenced field's
                // already-computed compile-time value. Sibling const fields are
                // folded in dependency order (see the fixpoint loop in the
                // const-binding pass), so a referenced const's value is present
                // by the time this initializer is evaluated.
                value = constField.ConstantValue;
                return true;

            case BoundUnaryExpression unary
                when unary.Op.Kind is BoundUnaryOperatorKind.Negation or BoundUnaryOperatorKind.Identity
                && TryEvaluateConstant(unary.Operand, out var operand)
                && operand != null:
                value = NegateIfNeeded(operand, unary.Op.Kind == BoundUnaryOperatorKind.Negation);
                return value != null;

            case BoundBinaryExpression binary
                when TryEvaluateConstant(binary.Left, out var left)
                && TryEvaluateConstant(binary.Right, out var right)
                && left != null
                && right != null:
                value = FoldBinary(binary.Op.Kind, left, right);
                return value != null;

            default:
                value = null;
                return false;
        }
    }

    /// <summary>
    /// Issue #948: folds a binary operation over two constant operands. Supports
    /// the constant-expression forms allowed in C# const initializers that the
    /// const-field feature commonly needs: numeric arithmetic and string
    /// concatenation. Returns <c>null</c> for unsupported shapes.
    /// </summary>
    private static object FoldBinary(BoundBinaryOperatorKind kind, object left, object right)
    {
        if (left is string || right is string)
        {
            return kind == BoundBinaryOperatorKind.Sum ? string.Concat(left, right) : null;
        }

        if (left is decimal || right is decimal)
        {
            if (!TryToDecimal(left, out var ld) || !TryToDecimal(right, out var rd))
            {
                return null;
            }

            return kind switch
            {
                BoundBinaryOperatorKind.Sum => ld + rd,
                BoundBinaryOperatorKind.Difference => ld - rd,
                BoundBinaryOperatorKind.Product => ld * rd,
                BoundBinaryOperatorKind.Quotient when rd != 0 => ld / rd,
                _ => (object)null,
            };
        }

        if (left is double || left is float || right is double || right is float)
        {
            var ld = System.Convert.ToDouble(left, System.Globalization.CultureInfo.InvariantCulture);
            var rd = System.Convert.ToDouble(right, System.Globalization.CultureInfo.InvariantCulture);
            return kind switch
            {
                BoundBinaryOperatorKind.Sum => ld + rd,
                BoundBinaryOperatorKind.Difference => ld - rd,
                BoundBinaryOperatorKind.Product => ld * rd,
                BoundBinaryOperatorKind.Quotient when rd != 0 => ld / rd,
                _ => (object)null,
            };
        }

        // Issue #1232: fold `<<`/`>>` with C#/CLR shift semantics. The shift
        // count is masked by the LEFT operand's width (32-bit types → count &
        // 0x1F, 64-bit types → count & 0x3F) and right-shift uses the operand's
        // actual signedness (arithmetic for signed, logical for unsigned), so
        // the compile-time result matches the runtime `shl`/`shr` emission.
        if (kind is BoundBinaryOperatorKind.ShiftLeft or BoundBinaryOperatorKind.ShiftRight or BoundBinaryOperatorKind.UnsignedShiftRight)
        {
            return FoldShift(kind, left, right);
        }

        if (!TryToInt64(left, out var li) || !TryToInt64(right, out var ri))
        {
            return null;
        }

        return kind switch
        {
            BoundBinaryOperatorKind.Sum => li + ri,
            BoundBinaryOperatorKind.Difference => li - ri,
            BoundBinaryOperatorKind.Product => li * ri,
            BoundBinaryOperatorKind.Quotient when ri != 0 => li / ri,
            BoundBinaryOperatorKind.Remainder when ri != 0 => li % ri,
            BoundBinaryOperatorKind.BitwiseAnd => li & ri,
            BoundBinaryOperatorKind.BitwiseOr => li | ri,
            BoundBinaryOperatorKind.BitwiseXor => li ^ ri,
            _ => (object)null,
        };
    }

    /// <summary>
    /// Issue #1232: folds a left/right shift over two constant operands using
    /// the same semantics the runtime emits (bare CLR <c>shl</c>/<c>shr</c>). The shift
    /// count is masked by the left operand's CLR width and the operation is
    /// computed in the left operand's actual type so masking, wrap-around and
    /// sign-extension exactly match C#. C# promotes operands narrower than
    /// <c>int</c> to <c>int</c> (32-bit, mask 0x1F); <c>uint</c> is 32-bit;
    /// <c>long</c>/<c>ulong</c> are 64-bit (mask 0x3F). 32-bit results are
    /// widened back to <see cref="long"/> to preserve the Int64 return-shape the
    /// other folded arithmetic ops use; 64-bit results keep their CLR type so
    /// downstream narrowing to the declared const field type stays correct.
    /// </summary>
    private static object FoldShift(BoundBinaryOperatorKind kind, object left, object right)
    {
        if (!TryToInt64(right, out var rawCount))
        {
            return null;
        }

        var is64 = left is long or ulong;
        var count = (int)(rawCount & (is64 ? 0x3F : 0x1F));
        var isLeft = kind == BoundBinaryOperatorKind.ShiftLeft;
        var isUnsigned = kind == BoundBinaryOperatorKind.UnsignedShiftRight;

        switch (left)
        {
            case long l:
                return isLeft ? l << count : isUnsigned ? (long)((ulong)l >> count) : l >> count;
            case ulong ul:
                return isLeft ? ul << count : ul >> count;
            case uint u:
                return (long)(isLeft ? u << count : u >> count);
            case int or short or sbyte or byte or ushort or char:
                var i = System.Convert.ToInt32(left, System.Globalization.CultureInfo.InvariantCulture);
                return (long)(isLeft ? i << count : isUnsigned ? unchecked((int)((uint)i >> count)) : i >> count);
            default:
                return null;
        }
    }

    private static bool TryToInt64(object value, out long result)
    {
        switch (value)
        {
            case int or long or short or sbyte or byte or ushort or uint:
                result = System.Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
                return true;
            case char c:
                result = c;
                return true;
            default:
                result = 0;
                return false;
        }
    }

    private static bool TryToDecimal(object value, out decimal result)
    {
        try
        {
            result = System.Convert.ToDecimal(value, System.Globalization.CultureInfo.InvariantCulture);
            return true;
        }
        catch (System.Exception ex) when (ex is System.InvalidCastException or System.FormatException or System.OverflowException)
        {
            result = 0;
            return false;
        }
    }

    private static object NegateIfNeeded(object operand, bool negate)
    {
        if (!negate)
        {
            return operand;
        }

        return operand switch
        {
            int i => -i,
            long l => -l,
            short s => -s,
            sbyte sb => -sb,
            float f => -f,
            double d => -d,
            decimal m => -m,
            _ => null,
        };
    }

    private static string GetBaseClauseTypeDisplayName(TypeClauseSyntax typeClause)
    {
        if (typeClause == null)
        {
            return string.Empty;
        }

        var dotted = typeClause.DottedName;
        if (!typeClause.HasTypeArguments)
        {
            return dotted;
        }

        var args = new string[typeClause.TypeArguments.Count];
        for (var i = 0; i < typeClause.TypeArguments.Count; i++)
        {
            args[i] = GetBaseClauseTypeDisplayName(typeClause.TypeArguments[i]);
        }

        return $"{dotted}[{string.Join(", ", args)}]";
    }
}
