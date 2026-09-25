// <copyright file="RefCapabilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal static class RefCapabilities
{
    /// <summary>
    /// Issue #4224: true when <paramref name="expression"/> is a call to a
    /// same-compilation (native) ref-returning function/method or a read of a
    /// native ref-returning property. An imported/CLR ref-returning member is
    /// NOT included here — <see cref="ConversionClassifier.AutoDereferenceRefReturn"/>
    /// already wraps those in a <see cref="BoundDereferenceExpression"/> at
    /// bind time, so they are already lvalues (see
    /// <see cref="ExpressionBinder.IsLvalue"/>'s <c>BoundDereferenceExpression</c>
    /// case) with no change needed here.
    /// </summary>
    /// <param name="expression">The bound expression to classify.</param>
    /// <returns><see langword="true"/> when the expression is such a call/property read.</returns>
    internal static bool IsNativeRefReturningCall(BoundExpression expression)
        => expression switch
        {
            // A [Conditional]-elided call leaves nothing on the stack to
            // address (issue #176 / ADR-0047 §6).
            BoundCallExpression { IsConditionalElided: true } => false,
            BoundCallExpression call => call.Function.ReturnRefKind != RefKind.None,
            BoundUserInstanceCallExpression uic => uic.Method.ReturnRefKind != RefKind.None,
            BoundBaseInterfaceCallExpression baseInterface =>
                baseInterface.Method.ReturnRefKind != RefKind.None,
            BoundBaseClassCallExpression { Method: { } method } =>
                method.ReturnRefKind != RefKind.None,

            // A flow-narrowed read (issue #1180) inserts a cast after the
            // getter call; the raw managed pointer from the getter would not
            // point at the narrowed value, so a narrowed read is excluded.
            BoundPropertyAccessExpression { NarrowedType: not null } => false,
            BoundPropertyAccessExpression prop => prop.Property.ReturnRefKind != RefKind.None,
            _ => false,
        };

    /// <summary>
    /// Issue #4224 (root cause #4) / #4265: decomposes a native ref-returning
    /// call or property read into the pieces the caller-side ref-safe-scope
    /// computation (<c>HasFunctionLocalRefScope</c>) needs — its instance
    /// receiver (whose storage the callee could be returning a reference
    /// into), the argument expressions passed to <c>ref</c>/<c>in</c>/
    /// <c>out</c> parameters (any of which the callee could likewise be
    /// returning), and — issue #4265 — the argument expressions passed to
    /// by-value BYREF-LIKE (ref struct, e.g. <c>Span[T]</c>) parameters,
    /// whose ENCAPSULATED REFERENT (not their own storage) the callee could
    /// be returning through, e.g. <c>func First(s Span[int32]) ref int32
    /// { return ref s[0] }</c>. These two argument kinds are kept in
    /// SEPARATE lists rather than merged, because the caller checks them
    /// with different scope semantics (<c>HasFunctionLocalRefScope</c> vs.
    /// <c>HasFunctionLocalReferentScope</c>) — conflating them would let a
    /// <c>ref</c> argument bound to a byref-like value smuggle a dangling
    /// reference through the wrong (too permissive) check. A <c>scoped</c>
    /// parameter of any of these three kinds is excluded: the callee's own
    /// signature promises not to return that reference, so the caller's
    /// argument does not contribute to the result's scope.
    /// </summary>
    /// <param name="expression">The bound expression to decompose.</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for a static/no-receiver call.</param>
    /// <param name="byRefArguments">The underlying storage of each non-<c>scoped</c> ref/in/out argument.</param>
    /// <param name="byValueByRefLikeArguments">Each non-<c>scoped</c> by-value byref-like argument, unchanged.</param>
    /// <returns>
    /// <see langword="false"/> when <paramref name="expression"/> is not a
    /// native ref-returning call/property (the out parameters are then empty).
    /// </returns>
    internal static bool TryGetRefReturnEscapeSources(
        BoundExpression expression,
        out BoundExpression? receiver,
        out ImmutableArray<BoundExpression> byRefArguments,
        out ImmutableArray<BoundExpression> byValueByRefLikeArguments)
    {
        switch (expression)
        {
            case BoundCallExpression { IsConditionalElided: false } call when call.Function.ReturnRefKind != RefKind.None:
                receiver = null;
                SelectEscapeArguments(call.Function.Parameters, call.Arguments, out byRefArguments, out byValueByRefLikeArguments);
                return true;
            case BoundUserInstanceCallExpression uic when uic.Method.ReturnRefKind != RefKind.None:
                receiver = uic.Receiver;
                SelectEscapeArguments(uic.Method.Parameters, uic.Arguments, out byRefArguments, out byValueByRefLikeArguments);
                return true;
            case BoundPropertyAccessExpression { NarrowedType: null } prop when prop.Property.ReturnRefKind != RefKind.None:
                receiver = prop.Receiver;
                byRefArguments = ImmutableArray<BoundExpression>.Empty;
                byValueByRefLikeArguments = ImmutableArray<BoundExpression>.Empty;
                return true;
            case BoundBaseInterfaceCallExpression baseInterface
                when baseInterface.Method.ReturnRefKind != RefKind.None:
                receiver = baseInterface.Receiver;
                SelectEscapeArguments(
                    baseInterface.Method.Parameters,
                    baseInterface.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments);
                return true;
            case BoundBaseClassCallExpression { Method: { } method } baseClass
                when method.ReturnRefKind != RefKind.None:
                receiver = baseClass.Receiver;
                SelectEscapeArguments(
                    method.Parameters,
                    baseClass.Arguments,
                    out byRefArguments,
                    out byValueByRefLikeArguments);
                return true;
            default:
                receiver = null;
                byRefArguments = ImmutableArray<BoundExpression>.Empty;
                byValueByRefLikeArguments = ImmutableArray<BoundExpression>.Empty;
                return false;
        }
    }

    /// <summary>
    /// ADR-0187 / issue #4350 (the C# scoped-<c>this</c> rule): whether the
    /// REF-safe-context of <paramref name="receiver"/> contributes to the
    /// reference a ref-returning call or property read hands back.
    /// </summary>
    /// <remarks>
    /// Every struct instance member's <c>this</c> is implicitly
    /// <c>scoped ref</c>, and the binder already enforces the callee side of
    /// that contract: a member that returns a reference into its own receiver
    /// must be <c>@UnscopedRef</c> (GS0589). So when the receiver's static
    /// type is a concrete struct — the call then names the implementation it
    /// dispatches to — a member WITHOUT <c>@UnscopedRef</c> cannot be the
    /// source of a reference into the receiver's storage, and C# excludes the
    /// receiver from the result's ref-safe-context entirely. Any other shape
    /// (a type-parameter or interface receiver, whose implementation may carry
    /// <c>@UnscopedRef</c> the called slot does not advertise; a base call; an
    /// unrecognized node) keeps the conservative answer.
    /// </remarks>
    /// <param name="expression">The ref-returning call or property read.</param>
    /// <param name="receiver">Its instance receiver.</param>
    /// <returns><see langword="true"/> when the receiver's storage can be the returned reference's source.</returns>
    internal static bool ReceiverContributesRefScope(BoundExpression expression, BoundExpression receiver)
    {
        var member = expression switch
        {
            BoundUserInstanceCallExpression call => call.Method,
            BoundPropertyAccessExpression property => property.Property.GetterSymbol,
            _ => null,
        };

        if (member == null || receiver.Type is not StructSymbol { IsClass: false })
        {
            return true;
        }

        return member.HasUnscopedRef;
    }

    internal static string DescribeReturn(RefKind kind)
        => kind == RefKind.RefReadOnly ? "by ref readonly" : kind == RefKind.Ref ? "by ref" : "by value";

    internal static bool IsReadOnlyReference(BoundExpression expression)
        => expression switch
        {
            // An immutable pointer binding does not make its pointee readonly.
            BoundVariableExpression { Type: ByRefTypeSymbol or PointerTypeSymbol } => false,
            BoundVariableExpression { Variable: LocalVariableSymbol local } =>
                local.RefKind == RefKind.RefReadOnly || local.RefKind == RefKind.In,
            BoundVariableExpression => false,
            BoundBlockExpression block => IsReadOnlyReference(block.Expression),
            BoundFieldAccessExpression field => field.Receiver != null
                && !Binder.IsReferenceTypeForConstraint(field.Receiver.Type) && IsReadOnlyReference(field.Receiver),
            _ => IsReadOnlyStorage(expression),
        };

    /// <summary>
    /// ADR-0184 amendment: the ONE condition under which the emitter replaces a
    /// value-type receiver with a defensive COPY in a function-local temp
    /// (<c>MethodBodyEmitter.EmitInstanceReceiver</c>,
    /// <c>MethodBodyEmitter.EmitConstrainedTypeParameterReceiver</c>,
    /// <c>ReflectionMetadataEmitter.NeedsRvalueReceiverSpill</c>). Any <c>ref</c>
    /// a member returns into its OWN receiver storage then points at that temp,
    /// which dies at function exit — so the binder's ref-safe-scope walk must
    /// treat such a forward as function-local
    /// (<c>StatementBinder.IsDefensivelyCopiedReceiverForwarding</c>). Before
    /// this helper existed the rule lived as three independently drifting
    /// copies in the emitter and nowhere at all in the binder, which is exactly
    /// how the caller-side dangling-reference hole got in.
    /// <para>
    /// Every caller keeps its own value-type/reference-type guard; this helper
    /// is deliberately ONLY the shared core, so extracting it left the
    /// emitter's behaviour byte-for-byte unchanged.
    /// </para>
    /// <para>
    /// <paramref name="isReadOnlyMember"/> is structurally <see langword="false"/>
    /// for every native G# member — G# has no <c>readonly func</c> — so it
    /// carries information only for CLR metadata members, whose
    /// <c>IsReadOnlyAttribute</c> <see cref="IsReadOnlyMethod"/> reads.
    /// </para>
    /// </summary>
    /// <param name="receiver">The instance receiver expression.</param>
    /// <param name="isReadOnlyMember">Whether the called member is itself a <c>readonly</c> member.</param>
    /// <returns><see langword="true"/> when the receiver is defensively copied before the call.</returns>
    internal static bool RequiresReadOnlyReceiverDefensiveCopy(
        BoundExpression receiver,
        bool isReadOnlyMember = false)
        => !isReadOnlyMember && IsReadOnlyReference(receiver);

    internal static bool IsReadOnlyMethod(MethodInfo method)
        => method.GetCustomAttributesData().Any(
                attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
            || method.DeclaringType?.GetCustomAttributesData().Any(
                attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute") == true;

    /// <summary>
    /// Issue #4265 soundness guard: true when <paramref name="indexer"/> (or
    /// its getter) carries <c>[UnscopedRef]</c> (<c>System.Diagnostics.CodeAnalysis.UnscopedRefAttribute</c>).
    /// C# accepts the attribute on EITHER the accessor or the property itself
    /// — an expression-bodied indexer (<c>[UnscopedRef] public ref int this[int i] => ref _value;</c>)
    /// emits it on the property's own metadata row, not <c>get_Item</c>, so
    /// both must be checked (confirmed via <c>CustomAttributeData</c> against
    /// a real compiled indexer of each shape — checking only the getter
    /// missed the expression-bodied spelling entirely). <see cref="StatementBinder"/>'s
    /// <c>BoundClrIndexExpression</c> case treats a byref-like CLR indexer's
    /// target as encapsulating a caller-supplied REFERENT (like <c>Span[T]</c>'s
    /// backing pointer) — safe to forward through a by-value parameter. That
    /// premise fails for an indexer explicitly marked <c>[UnscopedRef]</c>:
    /// the CLR author has declared it returns a reference into the
    /// RECEIVER'S OWN storage instead (exactly mirroring what <c>@UnscopedRef</c>
    /// signals for a native G# member — see <c>Binder.cs</c>'s
    /// <c>ThisParameter.IsScoped</c> handling), which a by-value receiver
    /// cannot safely yield. Real C# enforces the same distinction (CS8166:
    /// an <c>[UnscopedRef]</c> member invoked through a by-value parameter
    /// is rejected).
    /// </summary>
    /// <param name="indexer">The resolved CLR indexer property.</param>
    /// <returns><see langword="true"/> when the indexer or its getter carries <c>[UnscopedRef]</c>.</returns>
    internal static bool IsUnscopedRefIndexerGetter(PropertyInfo indexer)
        => HasUnscopedRefAttribute(indexer.GetCustomAttributesData())
            || HasUnscopedRefAttribute(indexer.GetGetMethod(nonPublic: true)?.GetCustomAttributesData());

    internal static TypeSymbol GetInferenceType(ParameterSymbol parameter, TypeSymbol argumentType)
        => parameter.RefKind != RefKind.None && argumentType is ByRefTypeSymbol byRef
            ? byRef.PointeeType
            : argumentType;

    internal static RefKind GetReturnRefKind(MethodInfo? method)
    {
        if (method?.ReturnType.IsByRef != true)
        {
            return RefKind.None;
        }

        var parameter = method.ReturnParameter;
        return parameter.GetRequiredCustomModifiers().Any(
                type => type.FullName == "System.Runtime.InteropServices.InAttribute")
            || parameter.GetCustomAttributesData().Any(
                attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
                ? RefKind.RefReadOnly
                : RefKind.Ref;
    }

    internal static RefKind GetReturnRefKind(PropertyInfo property)
        => !property.PropertyType.IsByRef ? RefKind.None
            : GetReturnRefKind(property.GetMethod) == RefKind.RefReadOnly
                || property.GetRequiredCustomModifiers().Any(type => type.FullName == "System.Runtime.InteropServices.InAttribute")
                || property.GetCustomAttributesData().Any(attribute => attribute.AttributeType.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
                    ? RefKind.RefReadOnly
                    : RefKind.Ref;

    /// <summary>
    /// Issue #4400: whether an argument written without a modifier at an
    /// <c>in</c> parameter passes its own storage's address (as C# does) —
    /// a variable (not a smart-cast narrowed read, whose storage has another
    /// type; not a compile-time constant; not a reference-type <c>this</c>),
    /// an addressable field, an array element, a dereference, or a native
    /// ref-returning call. Every other shape is an rvalue and is spilled to a
    /// readonly temp.
    /// </summary>
    /// <param name="value">The converted argument.</param>
    /// <returns><see langword="true"/> when its address is taken directly.</returns>
    internal static bool IsDirectlyAddressableForImplicitIn(BoundExpression value)
        => value switch
        {
            BoundVariableExpression { Variable: ParameterSymbol { IsReceiverParameter: true } } receiver =>
                !Binder.IsReferenceTypeForConstraint(receiver.Type) && receiver.NarrowedType == null,
            BoundVariableExpression variable =>
                (variable.NarrowedType == null || variable.NarrowedType == variable.Variable.Type)
                && variable.Variable is not GlobalVariableSymbol { IsConst: true },

            // A `const` field has no storage: lowering folds it to a literal.
            BoundFieldAccessExpression { Field.IsConst: true } => false,
            BoundClrPropertyAccessExpression { Member: FieldInfo { IsLiteral: true } } => false,
            BoundBlockExpression or BoundConditionalExpression => false,
            _ => ExpressionBinder.IsLvalue(value),
        };

    internal static bool IsReadOnlyStorage(BoundExpression expression)
        => expression switch
        {
            // ADR-0184 D2: a VALUE-type receiver is writable storage in every
            // struct instance member, not just an `@UnscopedRef` one — the CLR
            // passes a struct's `this` as `ref S`. ParameterSymbol derives
            // IsReadOnly from RefKind, and a receiver's RefKind is None, so
            // IsReadOnly alone wrongly classifies every `this` as read-only and
            // masks the escape-scope question behind GS0253. The assignment
            // binder already carried exactly this exemption for member WRITES
            // (ExpressionBinder.ReceiverVariableIsThis, issue #947); this is the
            // same fact made visible to the static classifiers. A REFERENCE-type
            // receiver is deliberately not exempted: IsReadOnlyValueReceiver
            // already short-circuits on it, so exempting it here would only
            // widen `&receiver` / `var ref x = receiver` on the parameter slot.
            BoundVariableExpression { Variable: ParameterSymbol { IsReceiverParameter: true } } receiver =>
                receiver.Variable.IsReadOnly && Binder.IsReferenceTypeForConstraint(receiver.Type),
            BoundVariableExpression variable => variable.Variable.IsReadOnly,
            BoundBlockExpression block => IsReadOnlyStorage(block.Expression),
            BoundConditionalExpression conditional => IsReadOnlyStorage(conditional.WhenTrue) || IsReadOnlyStorage(conditional.WhenFalse),
            BoundConditionalAddressExpression conditional => IsReadOnlyStorage(conditional.WhenTrueOperand) || IsReadOnlyStorage(conditional.WhenFalseOperand),
            BoundFieldAccessExpression field => field.Field.IsReadOnly || IsReadOnlyValueReceiver(field.Receiver),
            BoundAddressOfExpression address => address.IsReadOnly,
            BoundDereferenceExpression dereference => IsReadOnlyReference(dereference.Operand),

            // Issue #4224: a WRITABLE (`Ref`) getter/method called on a
            // read-only value-type receiver is treated as read-only storage
            // too — mirroring the field-access case just above and matching
            // C#'s conservative rule that any non-`readonly`-marked struct
            // member called on a `readonly` value requires a defensive copy,
            // so writing through whatever reference it returns cannot be
            // trusted to reach the original storage.
            //
            // ADR-0187: the copy only matters when the member may return into
            // its receiver (see ReceiverContributesRefScope); a `ref` from a
            // non-@UnscopedRef member of a concrete struct points elsewhere and
            // stays writable, as in C#.
            BoundPropertyAccessExpression property => property.Property.ReturnRefKind == RefKind.RefReadOnly
                || (property.Property.ReturnRefKind == RefKind.Ref
                    && IsReadOnlyValueReceiver(property.Receiver)
                    && (property.Receiver == null || ReceiverContributesRefScope(property, property.Receiver))),
            BoundCallExpression call => call.Function.ReturnRefKind == RefKind.RefReadOnly,
            BoundUserInstanceCallExpression call => call.Method.ReturnRefKind == RefKind.RefReadOnly
                || (call.Method.ReturnRefKind == RefKind.Ref
                    && IsReadOnlyValueReceiver(call.Receiver)
                    && ReceiverContributesRefScope(call, call.Receiver)),
            BoundBaseInterfaceCallExpression call => call.Method.ReturnRefKind == RefKind.RefReadOnly,
            BoundBaseClassCallExpression call => (call.Method?.ReturnRefKind ?? call.Property?.ReturnRefKind) == RefKind.RefReadOnly,
            BoundConstrainedStaticCallExpression call => (call.InterfaceMethod?.ReturnRefKind ?? GetReturnRefKind(call.ClrMethod)) == RefKind.RefReadOnly,
            BoundImportedCallExpression call => GetReturnRefKind(call.Function.Method) == RefKind.RefReadOnly,
            BoundImportedInstanceCallExpression call => GetReturnRefKind(call.Method) == RefKind.RefReadOnly,
            BoundClrStaticCallExpression call => GetReturnRefKind(call.Method) == RefKind.RefReadOnly,
            BoundClrIndexExpression index => GetReturnRefKind(index.Indexer) == RefKind.RefReadOnly,
            BoundClrPropertyAccessExpression { Member: PropertyInfo property } => GetReturnRefKind(property) == RefKind.RefReadOnly,
            BoundClrPropertyAccessExpression { Member: FieldInfo field } access => field.IsInitOnly || field.IsLiteral || IsReadOnlyValueReceiver(access.Receiver),
            _ => false,
        };

    internal static bool IsReadOnlyValueReceiver(BoundExpression? expression)
        => expression != null
            && !Binder.IsReferenceTypeForConstraint(expression.Type)
            && IsReadOnlyStorage(expression);

    internal static bool IsReadOnlyValueReference(BoundExpression expression)
        => !Binder.IsReferenceTypeForConstraint(expression.Type)
            && IsReadOnlyReference(expression);

    /// <summary>
    /// Splits a call's arguments into the two escape-source kinds
    /// <see cref="TryGetRefReturnEscapeSources"/> needs, keeping them in
    /// SEPARATE lists (issue #4265) because the caller checks them with
    /// different scope semantics: <paramref name="byRefArguments"/> holds
    /// the operand each non-<c>scoped</c> <c>ref</c>/<c>in</c>/<c>out</c>
    /// argument's address was taken of (checked against its own storage
    /// scope), and <paramref name="byValueByRefLikeArguments"/> holds each
    /// non-<c>scoped</c> by-value byref-like (e.g. <c>Span[T]</c>) argument
    /// unchanged (checked against its ENCAPSULATED REFERENT's scope
    /// instead — see <c>StatementBinder.HasFunctionLocalReferentScope</c>).
    /// Conservative on any shape the caller-side scope walk cannot
    /// decompose (a conditional address, a parameter/argument count
    /// mismatch, or a ref/in/out argument that was not itself wrapped in a
    /// <see cref="BoundAddressOfExpression"/>): the unrecognized argument
    /// expression itself is returned unchanged so the recursive
    /// <c>HasFunctionLocalRefScope</c> walk's default ("unrecognized shape
    /// is function-local, i.e. unsafe") still applies, rather than silently
    /// treating an undecomposable argument as safe to escape through.
    /// </summary>
    private static void SelectEscapeArguments(
        ImmutableArray<ParameterSymbol> parameters,
        ImmutableArray<BoundExpression> arguments,
        out ImmutableArray<BoundExpression> byRefArguments,
        out ImmutableArray<BoundExpression> byValueByRefLikeArguments)
    {
        if (parameters.IsDefaultOrEmpty || arguments.IsDefaultOrEmpty)
        {
            byRefArguments = ImmutableArray<BoundExpression>.Empty;
            byValueByRefLikeArguments = ImmutableArray<BoundExpression>.Empty;
            return;
        }

        var refBuilder = ImmutableArray.CreateBuilder<BoundExpression>();
        var byValueBuilder = ImmutableArray.CreateBuilder<BoundExpression>();
        var count = System.Math.Min(parameters.Length, arguments.Length);
        for (int i = 0; i < count; i++)
        {
            var parameter = parameters[i];
            if (parameter.IsScoped)
            {
                continue;
            }

            if (parameter.RefKind != RefKind.None)
            {
                refBuilder.Add(arguments[i] is BoundAddressOfExpression addr ? addr.Operand : arguments[i]);
            }
            else if (TypeSymbol.IsByRefLike(parameter.Type))
            {
                byValueBuilder.Add(arguments[i]);
            }
        }

        byRefArguments = refBuilder.ToImmutable();
        byValueByRefLikeArguments = byValueBuilder.ToImmutable();
    }

    private static bool HasUnscopedRefAttribute(IEnumerable<CustomAttributeData>? attributes)
        => attributes?.Any(
            attribute => attribute.AttributeType.FullName == "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute") == true;
}
