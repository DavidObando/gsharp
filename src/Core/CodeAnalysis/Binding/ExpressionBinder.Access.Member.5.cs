// <copyright file="ExpressionBinder.Access.Member.5.cs" company="GSharp">
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
